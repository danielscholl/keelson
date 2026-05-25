// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";

import { makeLoopHandler } from "./loop.ts";
import type { NodeContext, NodeHandler, NodeResult } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";

interface SeenPrompt {
	prompt: string;
	resolvedBody: string;
	nodeId: string;
}

function makeRecorderHandler(
	responder: (call: SeenPrompt, callIndex: number) => NodeResult,
): {
	handler: NodeHandler;
	seen: SeenPrompt[];
} {
	const seen: SeenPrompt[] = [];
	const handler: NodeHandler = {
		type: "prompt",
		async handle(node, ctx): Promise<NodeResult> {
			const call: SeenPrompt = {
				prompt: (node as { prompt?: string }).prompt ?? "",
				resolvedBody: ctx.resolvedBody,
				nodeId: node.id,
			};
			seen.push(call);
			return responder(call, seen.length - 1);
		},
	};
	return { handler, seen };
}

function buildCtx(opts: { abortSignal?: AbortSignal } = {}): NodeContext {
	return {
		runId: "run-loop-1",
		nodeId: "summarize",
		inputs: {},
		upstreamOutputs: new Map(),
		cwd: process.cwd(),
		abortSignal: opts.abortSignal ?? new AbortController().signal,
		emit: () => undefined,
		resolvedBody: "",
		rawBody: "",
		workflow: { name: "t", description: "", nodes: [] } as unknown as WorkflowDefinition,
	};
}

function loopNode(overrides: Partial<{ max_iterations: number; until: string; interactive: boolean }>) {
	return {
		id: "summarize",
		model: "claude-sonnet-4-6",
		loop: {
			prompt: "summarize this: $LOOP_PREV_OUTPUT",
			until: "DONE",
			max_iterations: 3,
			fresh_context: false,
			...overrides,
		},
	} as unknown as DagNode;
}

describe("makeLoopHandler — completion signal", () => {
	test("exits early when 'until' signal appears", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler((_, i) =>
			i === 1
				? { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } }
				: { status: "succeeded", output: { kind: "text", text: "still working" } },
		);
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(loopNode({}), buildCtx());
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "" });
		expect(seen).toHaveLength(2);
		// $LOOP_PREV_OUTPUT empty on iter 1; populated on iter 2 with previous stripped output.
		expect(seen[0].prompt).toBe("summarize this: ");
		expect(seen[1].prompt).toBe("summarize this: still working");
	});

	test("strips the <promise> tag from the returned output", async () => {
		const { handler: promptHandler } = makeRecorderHandler(() => ({
			status: "succeeded",
			output: { kind: "text", text: "result body <promise>DONE</promise>" },
		}));
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(loopNode({}), buildCtx());
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "result body" });
	});
});

describe("makeLoopHandler — max_iterations cap", () => {
	test("hitting max_iterations without 'until' is SUCCESS", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
			status: "succeeded",
			output: { kind: "text", text: "still working" },
		}));
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(loopNode({ max_iterations: 3 }), buildCtx());
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "still working" });
		expect(seen).toHaveLength(3);
	});
});

describe("makeLoopHandler — failure propagation", () => {
	test("a failing iteration short-circuits the loop", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler((_, i) =>
			i === 0
				? { status: "succeeded", output: { kind: "text", text: "progress" } }
				: { status: "failed", output: { kind: "text", text: "" }, error: "provider crashed" },
		);
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(loopNode({}), buildCtx());
		expect(result.status).toBe("failed");
		expect(result.error).toBe("provider crashed");
		expect(seen).toHaveLength(2);
	});
});

describe("makeLoopHandler — interactive rejection", () => {
	test("interactive: true returns a clear failure without invoking the prompt handler", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
			status: "succeeded",
			output: { kind: "text", text: "should not run" },
		}));
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(
			loopNode({ interactive: true }),
			buildCtx(),
		);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("interactive loops are not yet supported");
		expect(seen).toHaveLength(0);
	});

	test("until_bash returns a clear failure without invoking the prompt handler", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
			status: "succeeded",
			output: { kind: "text", text: "should not run" },
		}));
		const handler = makeLoopHandler({ promptHandler });
		const node = {
			id: "summarize",
			loop: {
				prompt: "do work",
				until: "DONE",
				max_iterations: 3,
				fresh_context: false,
				until_bash: "test -f /tmp/done",
			},
		} as unknown as Parameters<typeof handler.handle>[0];
		const result = await handler.handle(node, buildCtx());
		expect(result.status).toBe("failed");
		expect(result.error).toContain("loop.until_bash");
		expect(result.error).toContain("not yet supported");
		expect(seen).toHaveLength(0);
	});
});

describe("makeLoopHandler — abort honor", () => {
	test("aborted ctx skips remaining iterations", async () => {
		const ac = new AbortController();
		const { handler: promptHandler, seen } = makeRecorderHandler((_, i) => {
			if (i === 0) {
				ac.abort();
				return { status: "succeeded", output: { kind: "text", text: "first" } };
			}
			return { status: "succeeded", output: { kind: "text", text: "second" } };
		});
		const handler = makeLoopHandler({ promptHandler });
		const result = await handler.handle(loopNode({}), buildCtx({ abortSignal: ac.signal }));
		expect(result.status).toBe("failed");
		expect(result.error).toContain("aborted");
		expect(seen).toHaveLength(1);
	});
});

describe("makeLoopHandler — AI passthrough", () => {
	test("model carries onto the synthesized iteration node", async () => {
		const seenModels: (string | undefined)[] = [];
		const handler: NodeHandler = {
			type: "prompt",
			async handle(node) {
				seenModels.push((node as { model?: string }).model);
				return { status: "succeeded", output: { kind: "text", text: "DONE" } };
			},
		};
		const loop = makeLoopHandler({ promptHandler: handler });
		await loop.handle(loopNode({}), buildCtx());
		expect(seenModels).toEqual(["claude-sonnet-4-6"]);
	});
});

describe("makeLoopHandler — substitution in loop.prompt", () => {
	test("expands $ARGUMENTS / $inputs.* / $X.output before $LOOP_PREV_OUTPUT", async () => {
		const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
			status: "succeeded",
			output: { kind: "text", text: "DONE" },
		}));
		const node = {
			id: "loop1",
			model: "x",
			loop: {
				prompt:
					"args=$ARGUMENTS lane=$inputs.lane prior=$producer.output prev=$LOOP_PREV_OUTPUT",
				until: "DONE",
				max_iterations: 1,
				fresh_context: false,
			},
		} as unknown as Parameters<typeof promptHandler.handle>[0];
		const handler = makeLoopHandler({ promptHandler });
		const ctx = {
			...buildCtx(),
			inputs: { ARGUMENTS: "u-msg", lane: "stable" },
			upstreamOutputs: new Map([
				[
					"producer",
					{
						state: "completed" as const,
						output: "upstream-text",
						startedAt: "2026-01-01T00:00:00.000Z",
						completedAt: "2026-01-01T00:00:00.000Z",
						durationMs: 0,
					},
				],
			]),
		};
		await handler.handle(node, ctx);
		expect(seen).toHaveLength(1);
		expect(seen[0].prompt).toBe(
			"args=u-msg lane=stable prior=upstream-text prev=",
		);
	});
});

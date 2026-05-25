// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";

import { makeCancelHandler, type RequestCancel } from "./cancel.ts";
import type { NodeContext } from "../executor.ts";
import type {
	DagNode,
	NodeOutput,
	WorkflowDefinition,
} from "../schema/index.ts";

function buildCtx(opts: {
	upstreamOutputs?: Map<string, NodeOutput>;
	resolvedBody?: string;
}): NodeContext {
	return {
		runId: "run-cancel-1",
		nodeId: "stop",
		inputs: {},
		upstreamOutputs: opts.upstreamOutputs ?? new Map(),
		cwd: process.cwd(),
		abortSignal: new AbortController().signal,
		emit: () => undefined,
		resolvedBody: opts.resolvedBody ?? "",
		rawBody: opts.resolvedBody ?? "",
		workflow: {
			name: "t",
			description: "",
			nodes: [],
		} as unknown as WorkflowDefinition,
	};
}

const stopNode = {
	id: "stop",
	cancel: "policy violation: $check.output",
} as unknown as DagNode;

describe("makeCancelHandler", () => {
	test("invokes requestCancel with the substituted reason and returns failed", async () => {
		const upstream: Map<string, NodeOutput> = new Map([
			[
				"check",
				{
					state: "completed",
					output: "lint failed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:00:00.000Z",
					durationMs: 0,
				},
			],
		]);
		let captured: { runId?: string; reason?: string } = {};
		const requestCancel: RequestCancel = (runId, reason) => {
			captured = { runId, reason };
		};
		const handler = makeCancelHandler({ requestCancel });
		const result = await handler.handle(
			stopNode,
			buildCtx({ upstreamOutputs: upstream }),
		);
		expect(captured.runId).toBe("run-cancel-1");
		expect(captured.reason).toBe("policy violation: lint failed");
		expect(result.status).toBe("failed");
		expect(result.error).toBe("cancelled: policy violation: lint failed");
		expect(result.output).toEqual({
			kind: "text",
			text: "policy violation: lint failed",
		});
	});

	test("missing upstream substitutes to empty string (best-effort)", async () => {
		const requestCancel: RequestCancel = () => undefined;
		const handler = makeCancelHandler({ requestCancel });
		const node = { id: "stop", cancel: "stopped: $missing.output" } as unknown as DagNode;
		const result = await handler.handle(node, buildCtx({}));
		expect(result.status).toBe("failed");
		// best-effort substitution leaves trailing space → trimmed to "stopped:"
		expect(result.error).toBe("cancelled: stopped:");
	});

	test("requestCancel throw surfaces as a distinct error message", async () => {
		const requestCancel: RequestCancel = () => {
			throw new Error("store offline");
		};
		const handler = makeCancelHandler({ requestCancel });
		const node = { id: "stop", cancel: "halt" } as unknown as DagNode;
		const result = await handler.handle(node, buildCtx({}));
		expect(result.status).toBe("failed");
		expect(result.error).toBe("cancel signalling failed: store offline");
		expect(result.output).toEqual({ kind: "text", text: "halt" });
	});

	test("awaits an async requestCancel before completing", async () => {
		const order: string[] = [];
		const requestCancel: RequestCancel = async () => {
			order.push("cancel-called");
			await new Promise((r) => setTimeout(r, 5));
			order.push("cancel-resolved");
		};
		const handler = makeCancelHandler({ requestCancel });
		const node = { id: "stop", cancel: "halt" } as unknown as DagNode;
		await handler.handle(node, buildCtx({}));
		order.push("handler-returned");
		expect(order).toEqual([
			"cancel-called",
			"cancel-resolved",
			"handler-returned",
		]);
	});

	test("uses ctx.resolvedBody when populated (executor path with $ARGUMENTS/$inputs)", async () => {
		// Simulates the executor having already substituted the cancel body.
		let captured = "";
		const requestCancel: RequestCancel = (_runId, reason) => {
			captured = reason;
		};
		const handler = makeCancelHandler({ requestCancel });
		const node = {
			id: "stop",
			cancel: "stopped by $inputs.user for $ARGUMENTS",
		} as unknown as DagNode;
		const ctx = buildCtx({
			resolvedBody: "stopped by alice for security-review",
		});
		await handler.handle(node, ctx);
		expect(captured).toBe("stopped by alice for security-review");
	});
});

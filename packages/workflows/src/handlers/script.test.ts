// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeScriptHandler } from "./script.ts";
import type { NodeContext } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";

function buildCtx(opts: {
	cwd: string;
	body: string;
	resolvedBody?: string;
	inputs?: Record<string, string>;
	abortSignal?: AbortSignal;
	emit?: (e: { type: string; line?: string }) => void;
}): NodeContext {
	return {
		runId: "run-script",
		nodeId: "s",
		inputs: opts.inputs ?? {},
		upstreamOutputs: new Map(),
		cwd: opts.cwd,
		abortSignal: opts.abortSignal ?? new AbortController().signal,
		emit: (opts.emit as unknown as NodeContext["emit"]) ?? (() => undefined),
		resolvedBody: opts.resolvedBody ?? opts.body,
		rawBody: opts.body,
		workflow: { name: "t", description: "", nodes: [] } as unknown as WorkflowDefinition,
	};
}

async function uvAvailable(): Promise<boolean> {
	try {
		const p = Bun.spawn(["uv", "--version"], { stdout: "ignore", stderr: "ignore" });
		return (await p.exited) === 0;
	} catch {
		return false;
	}
}

// Resolve once at module load so the `test.if(...)` predicate is sync.
const UV_OK = await uvAvailable();

describe("makeScriptHandler — inline bun", () => {
	test("captures stdout (trimmed of trailing newline)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "console.log('hello-bun')" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "hello-bun" });
	});

	test("surfaces non-zero exit with truncated stderr tail", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({
			cwd,
			body: "console.error('boom'); process.exit(7)",
		});
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("exit 7");
		expect(result.error).toContain("boom");
	});

	test("respects timeout", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler({ timeoutMs: 150 });
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({
			cwd,
			body: "await new Promise(r => setTimeout(r, 5000))",
		});
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("timed out");
	});

	test("honors ctx.abortSignal", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const ac = new AbortController();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({
			cwd,
			body: "await new Promise(r => setTimeout(r, 5000))",
			abortSignal: ac.signal,
		});
		const resultPromise = handler.handle(node, ctx);
		setTimeout(() => ac.abort(), 50);
		const result = await resultPromise;
		expect(result.status).toBe("failed");
		expect(result.error).toBe("aborted");
	});

	test("emits per-line node_log events as the script writes stdout", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const lines: string[] = [];
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({
			cwd,
			body: "console.log('a'); console.log('b'); console.log('c')",
			emit: (e) => {
				if (e.type === "node_log" && typeof e.line === "string") lines.push(e.line);
			},
		});
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect(lines).toEqual(["a", "b", "c"]);
	});
});

describe("makeScriptHandler — named bun", () => {
	test("runs a .js file discovered from .keelson/scripts/", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		await mkdir(join(cwd, ".keelson/scripts"), { recursive: true });
		await writeFile(
			join(cwd, ".keelson/scripts/echo-args.js"),
			"console.log('from-named')",
		);
		await chmod(join(cwd, ".keelson/scripts/echo-args.js"), 0o644);

		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "echo-args" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "from-named" });
	});

	test("returns clear error when named script not found", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "nope-script" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not found");
	});
});

describe("makeScriptHandler — injection safety (rawBody dispatch + env channel)", () => {
	test("a substituted body containing JS-breaking chars is NOT executed as code", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		// rawBody reads inputs through env vars — even if a malicious value
		// would have closed a string literal, the dispatch never sees it.
		const ctx = buildCtx({
			cwd,
			body: "console.log(`got=${process.env.KEELSON_INPUTS_evil ?? ''}`)",
			// Simulates the executor splicing a malicious value into resolvedBody.
			resolvedBody: "console.log(`got=`); process.exit(99); //`)",
			inputs: { evil: '"; process.exit(99); //' },
		});
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect((result.output as { text: string }).text).toBe(
			'got="; process.exit(99); //',
		);
	});

	test("inputs reach inline bun script via KEELSON_INPUTS_* / KEELSON_ARGUMENTS", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({
			cwd,
			body:
				"console.log(`args=${process.env.KEELSON_ARGUMENTS} lane=${process.env.KEELSON_INPUTS_lane}`)",
			inputs: { ARGUMENTS: "smoke", lane: "stable" },
		});
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect((result.output as { text: string }).text).toBe("args=smoke lane=stable");
	});
});

describe("makeScriptHandler — empty body / invalid runtime", () => {
	test("empty body fails fast", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "bun" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "   " });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("empty script body");
	});

	test("invalid runtime fails fast", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "ruby" as unknown as "bun" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "puts 'hi'" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("invalid runtime");
	});
});

describe("makeScriptHandler — uv (python)", () => {
	test.if(UV_OK)("runs inline python via uv", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "uv" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "print('hello-uv')" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "hello-uv" });
	});

	test.if(UV_OK)("runs a named .py from .keelson/scripts/", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "keelson-script-"));
		await mkdir(join(cwd, ".keelson/scripts"), { recursive: true });
		await writeFile(
			join(cwd, ".keelson/scripts/echo-py.py"),
			"print('from-py')\n",
		);
		const handler = makeScriptHandler();
		const node = { id: "s", runtime: "uv" } as unknown as DagNode;
		const ctx = buildCtx({ cwd, body: "echo-py" });
		const result = await handler.handle(node, ctx);
		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ kind: "text", text: "from-py" });
	});
});

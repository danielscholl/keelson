// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutorValidationError,
  type MemoryTools,
  type NodeHandler,
  type NotebookAdapter,
  type RecallResponseLike,
  type RunOptions,
  type RunStreamEvent,
  resolveBody,
  runWorkflow,
  type WritebackResponseLike,
} from "./executor.ts";
import { makeApprovalHandler } from "./handlers/approval.ts";
import { parseWorkflow } from "./loader.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "./schema/index.ts";
import { seedStarterAssets } from "./seed.ts";

/**
 * Local mirror of @keelson/shared's MessageChunk shape. Defined here
 * instead of imported because @keelson/workflows has no upstream deps in
 * the architecture graph (docs/architecture.md §3). Covers only the variants
 * these tests exercise.
 */
type TestMessageChunk =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; toolName: string };

// ---------------------------------------------------------------------------
// Synthetic handlers
// ---------------------------------------------------------------------------

interface RecordedCall {
  nodeId: string;
  resolvedBody: string;
  rawBody: string;
  at: number;
}

function echoHandler(
  type: string,
  opts: { delayMs?: number; signal?: { aborted: boolean } } = {},
): { handler: NodeHandler; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handler: NodeHandler = {
    type,
    async handle(node, ctx) {
      calls.push({
        nodeId: node.id,
        resolvedBody: ctx.resolvedBody,
        rawBody: ctx.rawBody,
        at: Date.now(),
      });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (ctx.abortSignal.aborted) {
        return { status: "failed", output: { kind: "text", text: "" }, error: "aborted" };
      }
      return {
        status: "succeeded",
        output: { kind: "text", text: `echo:${node.id}:${ctx.resolvedBody}` },
      };
    },
  };
  return { handler, calls };
}

function cannedHandler(table: Record<string, string>, type: string): NodeHandler {
  return {
    type,
    async handle(node) {
      const t = table[node.id];
      if (t === undefined) {
        return {
          status: "failed",
          output: { kind: "text", text: "" },
          error: `no canned response for ${node.id}`,
        };
      }
      return { status: "succeeded", output: { kind: "text", text: t } };
    },
  };
}

function chunkEmitter(chunks: TestMessageChunk[], type: string): NodeHandler {
  return {
    type,
    async handle(_node, ctx) {
      for (const c of chunks) ctx.emit({ type: "node_chunk", chunk: c });
      const text = chunks
        .filter((c): c is Extract<TestMessageChunk, { type: "text" }> => c.type === "text")
        .map((c) => c.content)
        .join("");
      return { status: "succeeded", output: { kind: "text", text } };
    },
  };
}

function failingHandler(type: string, error: string): NodeHandler {
  return {
    type,
    async handle() {
      return { status: "failed", output: { kind: "text", text: "" }, error };
    },
  };
}

// Fails its first `failTimes` calls, then succeeds. Optionally aborts the given
// controller on its first call (to exercise the never-retry-a-cancel path).
function flakyHandler(
  type: string,
  opts: { failTimes: number; error: string; abortOnFirstCall?: AbortController },
): { handler: NodeHandler; attempts: () => number } {
  let calls = 0;
  const handler: NodeHandler = {
    type,
    async handle() {
      calls++;
      if (calls === 1 && opts.abortOnFirstCall) opts.abortOnFirstCall.abort();
      if (calls <= opts.failTimes) {
        return { status: "failed", output: { kind: "text", text: "" }, error: opts.error };
      }
      return { status: "succeeded", output: { kind: "text", text: `ok after ${calls}` } };
    },
  };
  return { handler, attempts: () => calls };
}

function recordEvents(): { events: RunStreamEvent[]; onEvent: (e: RunStreamEvent) => void } {
  const events: RunStreamEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// DAG-shape fixtures: hello-world (single layer), status-report (sequential), classify-changes (conditional fan-out).
function loadStarter(name: string): WorkflowDefinition {
  const root = join(import.meta.dir, "..", "test", "fixtures", `${name}.yaml`);
  const yaml = readFileSync(root, "utf-8");
  const result = parseWorkflow(yaml, root);
  if (result.error) throw new Error(`fixture load failed: ${result.error.error}`);
  return result.workflow as WorkflowDefinition;
}

// smoke-test stays bundled — it's the user-facing "is the engine alive"
// fixture and we want both the SPA card and this executor test to read the
// same file. Separate helper so a future move of one doesn't drag the other.
function loadBundled(name: string): WorkflowDefinition {
  const root = join(import.meta.dir, "..", "assets", "workflows", `${name}.yaml`);
  const yaml = readFileSync(root, "utf-8");
  const result = parseWorkflow(yaml, root);
  if (result.error) throw new Error(`bundled load failed: ${result.error.error}`);
  return result.workflow as WorkflowDefinition;
}

function parseInline(yaml: string): WorkflowDefinition {
  const result = parseWorkflow(yaml, "inline.yaml");
  if (result.error) throw new Error(`inline parse failed: ${result.error.error}`);
  return result.workflow as WorkflowDefinition;
}

function baseOpts(workflow: WorkflowDefinition): Omit<RunOptions, "handlers"> {
  return {
    workflow,
    runId: "run-1",
    inputs: {},
    cwd: "/tmp",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWorkflow — hello-world (1 layer, 1 prompt node)", () => {
  test("emits run_started → node_started → node_done → run_done", async () => {
    const workflow = loadStarter("hello-world");
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "Daniel" },
      onEvent,
    });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["run_started", "node_started", "node_done", "run_done"]);
  });

  test("$ARGUMENTS substitution lands in greet's resolvedBody", async () => {
    const workflow = loadStarter("hello-world");
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "Daniel" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("greet");
    expect(calls[0].resolvedBody).toContain("Daniel");
    expect(calls[0].rawBody).toContain("$ARGUMENTS");
  });

  test("RunSummary reflects greet as completed and overall succeeded", async () => {
    const workflow = loadStarter("hello-world");
    const { handler } = echoHandler("prompt");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "x" },
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.greet.state).toBe("completed");
    expect(summary.nodes.greet.output).toContain("echo:greet:");
  });
});

describe("runWorkflow — status-report (2 layers, sequential)", () => {
  test("collect runs before summarize", async () => {
    const workflow = loadStarter("status-report");
    const { handler: bash, calls: bashCalls } = echoHandler("bash");
    const { handler: prompt, calls: promptCalls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", bash],
        ["prompt", prompt],
      ]),
    });
    expect(bashCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(1);
    expect(bashCalls[0].at).toBeLessThanOrEqual(promptCalls[0].at);
  });

  test("$collect.output substitution lands in summarize's resolvedBody", async () => {
    const workflow = loadStarter("status-report");
    const collected = "BRANCH=main";
    const { handler: prompt, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ collect: collected }, "bash")],
        ["prompt", prompt],
      ]),
    });
    expect(calls[0].nodeId).toBe("summarize");
    expect(calls[0].resolvedBody).toContain(collected);
  });

  test("emits node_started in topological order [collect, summarize]", async () => {
    const workflow = loadStarter("status-report");
    const { events, onEvent } = recordEvents();
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", echoHandler("bash").handler],
        ["prompt", echoHandler("prompt").handler],
      ]),
      onEvent,
    });
    const started = events
      .filter(
        (e): e is Extract<RunStreamEvent, { type: "node_started" }> => e.type === "node_started",
      )
      .map((e) => e.nodeId);
    expect(started).toEqual(["collect", "summarize"]);
  });
});

describe("runWorkflow — classify-changes (4 layers, conditional fan-out)", () => {
  const buildHandlers = (classifyResponse: string) =>
    new Map<string, NodeHandler>([
      ["bash", echoHandler("bash").handler],
      ["prompt", cannedHandler({ classify: classifyResponse }, "prompt")],
    ]);

  test("topological order honored across all layers", async () => {
    const workflow = loadStarter("classify-changes");
    const { handler: bash, calls } = echoHandler("bash");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", bash],
        ["prompt", cannedHandler({ classify: "FEATURE" }, "prompt")],
      ]),
    });
    const by = (id: string) => calls.find((c) => c.nodeId === id)!.at;
    expect(by("collect")).toBeLessThanOrEqual(by("label-feature"));
    expect(by("label-feature")).toBeLessThanOrEqual(by("report"));
  });

  test("when: 'FEATURE' runs only label-feature; others skipped", async () => {
    const workflow = loadStarter("classify-changes");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: buildHandlers("FEATURE"),
    });
    expect(summary.nodes["label-feature"].state).toBe("completed");
    expect(summary.nodes["label-bugfix"].state).toBe("skipped");
    expect(summary.nodes["label-other"].state).toBe("skipped");
  });

  test("when: 'BUGFIX' runs only label-bugfix; others skipped", async () => {
    const workflow = loadStarter("classify-changes");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: buildHandlers("BUGFIX"),
    });
    expect(summary.nodes["label-feature"].state).toBe("skipped");
    expect(summary.nodes["label-bugfix"].state).toBe("completed");
    expect(summary.nodes["label-other"].state).toBe("skipped");
  });

  test("when: anything-else runs only label-other", async () => {
    const workflow = loadStarter("classify-changes");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: buildHandlers("DOCS"),
    });
    expect(summary.nodes["label-feature"].state).toBe("skipped");
    expect(summary.nodes["label-bugfix"].state).toBe("skipped");
    expect(summary.nodes["label-other"].state).toBe("completed");
  });

  test("trigger_rule: one_success lets report complete despite 2 skipped siblings", async () => {
    const workflow = loadStarter("classify-changes");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: buildHandlers("FEATURE"),
    });
    expect(summary.nodes.report.state).toBe("completed");
    expect(summary.status).toBe("succeeded");
  });

  test("$collect.output lands in classify prompt; bash report reaches collect via env-var", async () => {
    const workflow = loadStarter("classify-changes");
    const { handler: bash, calls: bashCalls } = echoHandler("bash");
    const { handler: prompt, calls: promptCalls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", bash],
        ["prompt", prompt],
      ]),
    });
    const collectOutput = bashCalls.find((c) => c.nodeId === "collect")!;
    const classifyCall = promptCalls.find((c) => c.nodeId === "classify")!;
    const reportCall = bashCalls.find((c) => c.nodeId === "report")!;
    // classify's prompt embeds $collect.output → it should appear in the resolved body
    expect(classifyCall.resolvedBody).toContain(`echo:collect:${collectOutput.resolvedBody}`);
    // report's bash does NOT use $collect.output (Codex round 4 fix —
    // raw text-substitution into bash is a command-injection vector).
    // Instead the body references the env-var channel; the executor's
    // resolveBody leaves KEELSON_NODE_collect_OUTPUT untouched (no .output
    // suffix to match).
    expect(reportCall.resolvedBody).toContain("$KEELSON_NODE_collect_OUTPUT");
    expect(reportCall.rawBody).toContain("$KEELSON_NODE_collect_OUTPUT");
  });
});

function single(body: string) {
  return parseInline(`
name: t
description: test
nodes:
  - id: greet
    prompt: ${JSON.stringify(body)}
`);
}

describe("runWorkflow — substitution edge cases", () => {
  test("$inputs.foo substitution", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("hello $inputs.name")),
      handlers: new Map([["prompt", handler]]),
      inputs: { name: "world" },
    });
    expect(calls[0].resolvedBody).toBe("hello world");
  });

  test("$inputs.missing resolves to empty string", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("hello $inputs.absent end")),
      handlers: new Map([["prompt", handler]]),
      inputs: {},
    });
    expect(calls[0].resolvedBody).toBe("hello  end");
  });

  test("$inputs.foo and $ARGUMENTS coexist", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("$inputs.name says $ARGUMENTS")),
      handlers: new Map([["prompt", handler]]),
      inputs: { name: "alice", ARGUMENTS: "hi" },
    });
    expect(calls[0].resolvedBody).toBe("alice says hi");
  });

  test("node output containing literal $ARGUMENTS is NOT re-interpreted", async () => {
    // Regression: previously the sequential passes would re-scan substituted
    // node output, so the literal "$ARGUMENTS" coming out of `source` got
    // replaced with the current inputs.ARGUMENTS value. Single-pass fix.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: source
    bash: echo "literal"
  - id: consumer
    depends_on: [source]
    prompt: "out=$source.output"
`);
    const { handler: consumer, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ source: "raw $ARGUMENTS marker" }, "bash")],
        ["prompt", consumer],
      ]),
      inputs: { ARGUMENTS: "USER_INPUT" },
    });
    expect(calls[0].nodeId).toBe("consumer");
    expect(calls[0].resolvedBody).toBe("out=raw $ARGUMENTS marker");
    expect(calls[0].resolvedBody).not.toContain("USER_INPUT");
  });

  test("$ARTIFACTS_DIR substitutes to the per-run artifacts dir provided via RunOptions", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("write log to $ARTIFACTS_DIR/run.log")),
      handlers: new Map([["prompt", handler]]),
      artifactsDir: "/tmp/keelson-run-abc",
    });
    expect(calls[0].resolvedBody).toBe("write log to /tmp/keelson-run-abc/run.log");
  });

  test("$ARTIFACTS_DIR resolves to empty string when no artifactsDir is provided", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("prefix=[$ARTIFACTS_DIR]")),
      handlers: new Map([["prompt", handler]]),
    });
    expect(calls[0].resolvedBody).toBe("prefix=[]");
  });

  test("\\$ARTIFACTS_DIR escape preserves the literal token in the body", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("doc: \\$ARTIFACTS_DIR is the run scratch dir")),
      handlers: new Map([["prompt", handler]]),
      artifactsDir: "/tmp/keelson-run-abc",
    });
    // The escape strips the backslash but leaves the marker intact —
    // matches the existing $ARGUMENTS escape semantics so documentation
    // text doesn't need provider-specific quoting.
    expect(calls[0].resolvedBody).toBe("doc: $ARTIFACTS_DIR is the run scratch dir");
  });

  test("NodeContext exposes artifactsDir to handlers", async () => {
    let captured: string | undefined = "not-set";
    const handler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        captured = ctx.artifactsDir;
        return { status: "succeeded", output: { kind: "text", text: "ok" } };
      },
    };
    await runWorkflow({
      ...baseOpts(single("body")),
      handlers: new Map([["prompt", handler]]),
      artifactsDir: "/tmp/keelson-run-xyz",
    });
    expect(captured).toBe("/tmp/keelson-run-xyz");
  });

  test("$ARTIFACTS_DIR2.output is parsed as a node ref (NOT ARTIFACTS_DIR + '2.output' literal)", async () => {
    // Regression: previously the reserved-token alternation had no word
    // boundary, so `$ARTIFACTS_DIR2.output` matched `ARTIFACTS_DIR` first
    // and left `2.output` as literal text. With the \b fix, the regex
    // falls through to the node-output alternative — and since a node
    // named `ARTIFACTS_DIR2` is *not* in RESERVED_NODE_IDS, this resolves
    // against the upstream node map (here: bash producer named that).
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: ARTIFACTS_DIR2
    bash: 'echo from-producer'
  - id: consumer
    depends_on: [ARTIFACTS_DIR2]
    prompt: 'got: $ARTIFACTS_DIR2.output'
`);
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ ARTIFACTS_DIR2: "from-producer" }, "bash")],
        ["prompt", handler],
      ]),
      artifactsDir: "/tmp/keelson-run-xyz",
    });
    expect(calls[0]!.nodeId).toBe("consumer");
    expect(calls[0]!.resolvedBody).toBe("got: from-producer");
    // And NOT `/tmp/keelson-run-xyz2.output` — the reserved token only
    // consumes when followed by a non-word char (or end of input).
    expect(calls[0]!.resolvedBody).not.toContain("/tmp/keelson-run-xyz");
  });

  test("$ARTIFACTS_DIR-cache.output is parsed as a node ref (hyphen is NOT a boundary char)", async () => {
    // Regression: `\b` treats `-` as a word boundary, so the previous
    // pattern `(ARTIFACTS_DIR)\b` matched `ARTIFACTS_DIR` in
    // `$ARTIFACTS_DIR-cache.output` and left `-cache.output` literal.
    // Since node ids allow `[a-zA-Z0-9_-]`, the boundary must exclude
    // `-` too — only then does the regex fall through to the node-output
    // alt and capture the full hyphenated id.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: ARTIFACTS_DIR-cache
    bash: 'echo from-cache'
  - id: consumer
    depends_on: [ARTIFACTS_DIR-cache]
    prompt: 'got: $ARTIFACTS_DIR-cache.output'
`);
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ "ARTIFACTS_DIR-cache": "from-cache" }, "bash")],
        ["prompt", handler],
      ]),
      artifactsDir: "/tmp/keelson-run-xyz",
    });
    expect(calls[0]!.nodeId).toBe("consumer");
    expect(calls[0]!.resolvedBody).toBe("got: from-cache");
    // And NOT `/tmp/keelson-run-xyz-cache.output` — the reserved token only
    // consumes when followed by a non-[a-zA-Z0-9_-] char (or end of input).
    expect(calls[0]!.resolvedBody).not.toContain("/tmp/keelson-run-xyz");
  });

  test("$ARGUMENTS-foo.output is parsed as a node ref (hyphen boundary applies to ARGUMENTS too)", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: ARGUMENTS-foo
    bash: 'echo from-args-foo'
  - id: consumer
    depends_on: [ARGUMENTS-foo]
    prompt: 'got: $ARGUMENTS-foo.output'
`);
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ "ARGUMENTS-foo": "from-args-foo" }, "bash")],
        ["prompt", handler],
      ]),
      inputs: { ARGUMENTS: "TOPLEVEL" },
    });
    expect(calls[0]!.resolvedBody).toBe("got: from-args-foo");
    expect(calls[0]!.resolvedBody).not.toContain("TOPLEVEL");
  });

  test("$ARGUMENTS2 with no matching node falls through to the node-output alt and resolves to '' (existing behavior — confirms \\b works for ARGUMENTS too)", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("body $ARGUMENTS2 end")),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "foo" },
    });
    // $ARGUMENTS2 is parsed as `$ARGUMENTS2` (a node ref shape) — no
    // matching node, no `.output` suffix, so the regex doesn't actually
    // match (it requires `.output` for the node-id alt). The literal
    // `$ARGUMENTS2` remains.
    expect(calls[0]!.resolvedBody).toBe("body $ARGUMENTS2 end");
    expect(calls[0]!.resolvedBody).not.toContain("foo2");
  });

  test("NodeContext.artifactsDir is undefined when the option is omitted", async () => {
    let captured: string | undefined = "not-set";
    const handler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        captured = ctx.artifactsDir;
        return { status: "succeeded", output: { kind: "text", text: "ok" } };
      },
    };
    await runWorkflow({
      ...baseOpts(single("body")),
      handlers: new Map([["prompt", handler]]),
    });
    expect(captured).toBeUndefined();
  });

  test("$inputs value containing $ARGUMENTS is NOT re-interpreted", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("inject:$inputs.text")),
      handlers: new Map([["prompt", handler]]),
      inputs: { text: "has $ARGUMENTS inside", ARGUMENTS: "EVIL" },
    });
    expect(calls[0].resolvedBody).toBe("inject:has $ARGUMENTS inside");
    expect(calls[0].resolvedBody).not.toContain("EVIL");
  });

  test("$inputs.output resolves to the input named 'output' (end-to-end through loader)", async () => {
    // Regression: previously the alternation matched nodeId.output before
    // inputs.<key>, so $inputs.output returned empty. Also, the loader's
    // cross-ref validator false-positived on $inputs.output as an unknown
    // node ref. Both fixes: alternation reordered + loader treats "inputs"
    // as a reserved namespace.
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("see $inputs.output here")),
      handlers: new Map([["prompt", handler]]),
      inputs: { output: "the-value" },
    });
    expect(calls[0].resolvedBody).toBe("see the-value here");
  });

  test("$inputs.constructor (prototype key) does NOT leak inherited values", async () => {
    // Regression: inputs[inputKey] returns Object.prototype.constructor when
    // the input map doesn't own the key. Without guarding, that function got
    // coerced to "function Object() { [native code] }" and corrupted the body.
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("see $inputs.constructor here")),
      handlers: new Map([["prompt", handler]]),
      inputs: {},
    });
    expect(calls[0].resolvedBody).toBe("see  here");
    expect(calls[0].resolvedBody).not.toContain("function");
    expect(calls[0].resolvedBody).not.toContain("native");
  });

  test("$inputs.toString (prototype key) resolves to empty string", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("a $inputs.toString b")),
      handlers: new Map([["prompt", handler]]),
      inputs: {},
    });
    expect(calls[0].resolvedBody).toBe("a  b");
  });

  test("$inputs.foo and $nodeId.output interleave correctly", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: data
    bash: echo "X"
  - id: consumer
    depends_on: [data]
    prompt: "$inputs.prefix-$data.output"
`);
    const { handler: prompt, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ data: "X" }, "bash")],
        ["prompt", prompt],
      ]),
      inputs: { prefix: "P" },
    });
    expect(calls[0].resolvedBody).toBe("P-X");
  });
});

describe("runWorkflow — $1..$9 are NOT workflow positional args", () => {
  test("bash $1 in node body is preserved (treated as shell positional, not workflow arg)", async () => {
    // Regression: previously inputsToPositional aliased inputs.ARGUMENTS to a
    // one-element positional array, which caused the digit branch to
    // substitute $1 — corrupting bash idioms like `awk '{print $1}'`.
    // v1 has no real positional plumbing; digits are left alone.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: cmd
    bash: "awk '{print $1}'"
`);
    const { handler, calls } = echoHandler("bash");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      inputs: { ARGUMENTS: "anything" },
    });
    expect(calls[0].resolvedBody).toBe("awk '{print $1}'");
  });

  test("$1 in a prompt body is preserved too", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("see $1 and $2")),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "ignored" },
    });
    expect(calls[0].resolvedBody).toBe("see $1 and $2");
  });
});

describe("runWorkflow — bash quoting policy", () => {
  test("bash $ARGUMENTS is NOT pre-quoted (author owns quoting)", async () => {
    // Regression: previously inputsToPositional(...).map(shellQuote) corrupted
    // the common `echo "$ARGUMENTS"` pattern into `echo "'value'"`.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: cmd
    bash: 'echo "$ARGUMENTS"'
`);
    const { handler, calls } = echoHandler("bash");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      inputs: { ARGUMENTS: "hello world" },
    });
    expect(calls[0].resolvedBody).toBe('echo "hello world"');
    expect(calls[0].resolvedBody).not.toContain("'hello world'");
  });

  test("bash $inputs.foo is NOT pre-quoted (author owns quoting)", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: cmd
    bash: 'echo "$inputs.name"'
`);
    const { handler, calls } = echoHandler("bash");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      inputs: { name: "alice" },
    });
    expect(calls[0].resolvedBody).toBe('echo "alice"');
  });

  test("bash $X.output is NOT pre-quoted — author owns quoting", async () => {
    // All substitutions are raw. $X.output is treated the same as
    // $ARGUMENTS and $inputs.foo for bash. Author must wrap in single quotes
    // in the YAML (e.g. `bash: "echo '$X.output'"`) to defang upstream output.
    // Safer interpolation against hostile output (env / argv) is not done here;
    // no quoting strategy in `bash -c <text>` is universally safe.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: producer
    bash: echo unused
  - id: consumer
    depends_on: [producer]
    bash: 'echo $producer.output'
`);
    const { handler: consumer, calls } = echoHandler("bash");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        [
          "bash",
          {
            type: "bash",
            async handle(node, ctx) {
              if (node.id === "producer") {
                return {
                  status: "succeeded",
                  output: { kind: "text", text: "weird's value" },
                };
              }
              return await consumer.handle(node, ctx);
            },
          },
        ],
      ]),
    });
    // Raw substitution: the value lands verbatim, author owns escaping.
    expect(calls[0].resolvedBody).toBe("echo weird's value");
    expect(calls[0].resolvedBody).not.toContain("'\\''");
  });
});

describe("runWorkflow — backslash escape", () => {
  test("\\$ARGUMENTS and \\$inputs.foo stay literal", async () => {
    // The documented `\$` escape: a backslash before the dollar suppresses
    // substitution, then the final `\$ → $` pass restores the literal form.
    // Without the lookbehind on SUB_PATTERN this would substitute the value
    // and leave a stray backslash behind.
    //
    // `\$X.output` is not exercised here because the loader's cross-ref
    // validator (loader.ts:197) rejects unknown node references at parse time
    // regardless of escape — that's a loader concern, separate from the
    // executor's substitution semantics.
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("a \\$ARGUMENTS b \\$inputs.name")),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "ARG_VAL", name: "NAME_VAL" },
    });
    expect(calls[0].resolvedBody).toBe("a $ARGUMENTS b $inputs.name");
    expect(calls[0].resolvedBody).not.toContain("ARG_VAL");
    expect(calls[0].resolvedBody).not.toContain("NAME_VAL");
  });

  test("substituted data containing \\$5 is preserved verbatim (no re-scan)", async () => {
    // Regression: previously the trailing `\$ → $` pass ran on the fully
    // assembled body, which corrupted upstream output containing `\$N` (shell
    // snippets, escaped markdown, money formatting). Fix: escape is inline
    // with the substitution regex, so substituted values are never re-scanned.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: source
    bash: echo unused
  - id: consumer
    depends_on: [source]
    prompt: "report: $source.output"
`);
    const { handler: consumer, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", cannedHandler({ source: "items \\$5 and \\$2.50 tax" }, "bash")],
        ["prompt", consumer],
      ]),
    });
    expect(calls[0].resolvedBody).toBe("report: items \\$5 and \\$2.50 tax");
  });

  test("unescaped placeholders adjacent to escaped ones still substitute", async () => {
    const { handler, calls } = echoHandler("prompt");
    await runWorkflow({
      ...baseOpts(single("literal=\\$ARGUMENTS value=$ARGUMENTS")),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "HELLO" },
    });
    expect(calls[0].resolvedBody).toBe("literal=$ARGUMENTS value=HELLO");
  });
});

describe("runWorkflow — intra-layer isolation", () => {
  test("siblings in the same layer cannot observe each other via ctx.upstreamOutputs", async () => {
    // Two-layer workflow: layer 1 has two independent nodes (fast + slow).
    // Slow node's handler awaits, then reads ctx.upstreamOutputs.get(fastId).
    // If the executor wrote fast's result into the shared map mid-layer,
    // slow would see it — making behavior race-sensitive. Expectation: no.
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: fast
    bash: echo fast
  - id: slow
    bash: echo slow
`);
    const observed: { fastVisible: boolean } = { fastVisible: false };
    const fast: NodeHandler = {
      type: "bash",
      async handle() {
        return { status: "succeeded", output: { kind: "text", text: "F" } };
      },
    };
    const slow: NodeHandler = {
      type: "bash",
      async handle(_node, ctx) {
        // Give 'fast' time to complete first (it has no delay).
        await new Promise((r) => setTimeout(r, 20));
        observed.fastVisible = ctx.upstreamOutputs.has("fast");
        return { status: "succeeded", output: { kind: "text", text: "S" } };
      },
    };
    // Single handler that dispatches by node id (both are bash type).
    const dispatch: NodeHandler = {
      type: "bash",
      async handle(node, ctx) {
        return node.id === "fast" ? fast.handle(node, ctx) : slow.handle(node, ctx);
      },
    };
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", dispatch]]),
    });
    expect(observed.fastVisible).toBe(false);
  });
});

describe("runWorkflow — malformed when:", () => {
  test("malformed when: skips the node with a run_warning", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: source
    bash: echo "OK"
  - id: dependent
    depends_on: [source]
    when: "garbage syntax here"
    bash: echo "never"
`);
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", echoHandler("bash").handler]]),
      onEvent,
    });
    const warnings = events.filter(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].nodeId).toBe("dependent");
    expect(warnings[0].message).toContain("malformed when:");
    expect(summary.nodes.dependent.state).toBe("skipped");
  });
});

describe("runWorkflow — missing handler for unsupported node types", () => {
  test("loop node with no handler fails with run_warning", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: looper
    loop:
      prompt: hi
      until: DONE
      max_iterations: 1
`);
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map(),
      onEvent,
    });
    const warnings = events.filter(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warnings[0].message).toContain("no handler registered for node type 'loop'");
    expect(summary.nodes.looper.state).toBe("failed");
    expect(summary.status).toBe("failed");
  });

  test("downstream one_success rescues a missing-handler failure", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: a
    bash: echo "A"
  - id: b
    bash: echo "B"
  - id: rescue
    depends_on: [a, b]
    trigger_rule: one_success
    bash: echo "rescue"
`);
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        // Only register bash for 'b' and 'rescue'; 'a' uses bash too so both succeed.
        // To exercise rescue, fail 'a' explicitly.
        [
          "bash",
          {
            type: "bash",
            async handle(node) {
              if (node.id === "a")
                return {
                  status: "failed",
                  output: { kind: "text", text: "" },
                  error: "intentional",
                };
              return { status: "succeeded", output: { kind: "text", text: node.id } };
            },
          },
        ],
      ]),
    });
    expect(summary.nodes.a.state).toBe("failed");
    expect(summary.nodes.rescue.state).toBe("completed");
    expect(summary.status).toBe("succeeded");
  });
});

describe("runWorkflow — cancellation", () => {
  test("abort mid-run yields run_done.status === 'cancelled'", async () => {
    const workflow = loadStarter("status-report");
    const controller = new AbortController();
    const { handler: bash } = echoHandler("bash", { delayMs: 30 });
    const { handler: prompt } = echoHandler("prompt", { delayMs: 30 });
    const promise = runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", bash],
        ["prompt", prompt],
      ]),
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const summary = await promise;
    expect(summary.status).toBe("cancelled");
  });

  test("pre-aborted signal skips every node", async () => {
    const workflow = loadStarter("classify-changes");
    const controller = new AbortController();
    controller.abort();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", echoHandler("bash").handler],
        ["prompt", echoHandler("prompt").handler],
      ]),
      abortSignal: controller.signal,
    });
    expect(summary.status).toBe("cancelled");
    for (const state of Object.values(summary.nodes)) {
      expect(state.state).toBe("skipped");
    }
  });

  test("layer-1 completed nodes keep their result on mid-run abort", async () => {
    const workflow = loadStarter("status-report");
    const controller = new AbortController();
    const { handler: bash } = echoHandler("bash");
    const { handler: prompt } = echoHandler("prompt", { delayMs: 100 });
    // Abort between layer 1 (collect, fast) and layer 2 (summarize, slow).
    setTimeout(() => controller.abort(), 30);
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", bash],
        ["prompt", prompt],
      ]),
      abortSignal: controller.signal,
    });
    expect(summary.status).toBe("cancelled");
    expect(summary.nodes.collect.state).toBe("completed");
  });
});

describe("runWorkflow — fail-fast vs rescue", () => {
  test("failing leaf propagates to run.status === 'failed'", async () => {
    const workflow = parseInline(`
name: t
description: test
nodes:
  - id: a
    bash: echo "A"
  - id: dependent
    depends_on: [a]
    bash: echo "never"
`);
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", failingHandler("bash", "boom")]]),
    });
    expect(summary.nodes.a.state).toBe("failed");
    expect(summary.nodes.dependent.state).toBe("skipped");
    expect(summary.status).toBe("failed");
  });
});

describe("runWorkflow — structured output validation", () => {
  test("failed handler with unserializable structured value stays schema-safe", async () => {
    // Regression: the loud-fail guard in runNodeOnce only fires for succeeded
    // results. A handler returning {status:"failed", output:{kind:"structured",
    // value: undefined}, error:"..."} would still go through
    // bodyToSchemaOutput, where JSON.stringify(undefined) → undefined corrupts
    // the schema. Fix: coerce in bodyToSchemaOutput so NodeOutput.output is
    // always a string regardless of status.
    const workflow = loadStarter("hello-world");
    const handler: NodeHandler = {
      type: "prompt",
      async handle() {
        return {
          status: "failed",
          output: { kind: "structured", value: undefined },
          error: "boom",
        };
      },
    };
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "" },
    });
    expect(summary.nodes.greet.state).toBe("failed");
    expect(typeof summary.nodes.greet.output).toBe("string");
    expect(summary.nodes.greet.output).toBe("");
  });

  test("handler returning unserializable structured output fails loudly", async () => {
    // JSON.stringify(undefined) returns undefined (not a string); same for
    // top-level functions and symbols. Without explicit guarding, the executor
    // would record a NodeOutput whose `output` violates the schema and breaks
    // downstream substitution. Fix: the executor overrides the result to
    // failed + emits a run_warning naming the typeof, so the handler bug is
    // diagnosable.
    const workflow = loadStarter("hello-world");
    const handler: NodeHandler = {
      type: "prompt",
      async handle() {
        return {
          status: "succeeded",
          output: { kind: "structured", value: undefined },
        };
      },
    };
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "" },
      onEvent,
    });
    expect(summary.nodes.greet.state).toBe("failed");
    expect(summary.status).toBe("failed");
    const warnings = events.filter(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warnings.some((w) => w.message.includes("not JSON-serializable"))).toBe(true);
  });
});

describe("runWorkflow — onEvent resilience", () => {
  test("an async onEvent that rejects after await does not kill the run", async () => {
    // Regression: a sync try/catch around onEvent doesn't catch rejections
    // from an async callback that throws *after* an await — that becomes an
    // unhandled rejection. Consumers using onEvent for SQLite
    // persistence are exactly this shape.
    const workflow = loadStarter("hello-world");
    const { handler } = echoHandler("prompt");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "x" },
      onEvent: (async (e) => {
        if (e.type === "node_started") {
          await new Promise((r) => setTimeout(r, 1));
          throw new Error("simulated async failure");
        }
      }) as (e: RunStreamEvent) => void,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.greet.state).toBe("completed");
  });

  test("a throwing onEvent callback does not kill the run", async () => {
    // Regression: Promise.allSettled previously swallowed rejections from
    // runNodeOnce when the user's onEvent threw on `node_started`, leaving
    // the node missing from summary.nodes and the run reporting "succeeded".
    const workflow = loadStarter("hello-world");
    const { handler } = echoHandler("prompt");
    let invocations = 0;
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      inputs: { ARGUMENTS: "x" },
      onEvent: (e) => {
        invocations++;
        if (e.type === "node_started") throw new Error("simulated callback bug");
      },
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.greet.state).toBe("completed");
    expect(invocations).toBeGreaterThan(2);
  });
});

describe("runWorkflow — event emission", () => {
  test("handler-emitted node_chunk events appear between node_started and node_done", async () => {
    const workflow = loadStarter("hello-world");
    const chunks: TestMessageChunk[] = [
      { type: "text", content: "hi" },
      { type: "thinking", content: "hmm" },
      { type: "text", content: " there" },
    ];
    const { events, onEvent } = recordEvents();
    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", chunkEmitter(chunks, "prompt")]]),
      inputs: { ARGUMENTS: "" },
      onEvent,
    });
    const greetIdx = (predicate: (e: RunStreamEvent) => boolean) => events.findIndex(predicate);
    const startedIdx = greetIdx((e) => e.type === "node_started" && e.nodeId === "greet");
    const doneIdx = greetIdx((e) => e.type === "node_done" && e.nodeId === "greet");
    const chunkEvents = events.filter(
      (e): e is Extract<RunStreamEvent, { type: "node_event" }> =>
        e.type === "node_event" && e.nodeId === "greet",
    );
    expect(chunkEvents.length).toBe(3);
    const firstChunkIdx = events.indexOf(chunkEvents[0]);
    const lastChunkIdx = events.indexOf(chunkEvents[chunkEvents.length - 1]);
    expect(startedIdx).toBeLessThan(firstChunkIdx);
    expect(lastChunkIdx).toBeLessThan(doneIdx);
  });
});

describe("loader — non-ancestor $X.output references", () => {
  test("rejects $X.output reference from a node that doesn't depends_on X (when)", async () => {
    // Regression: a node referencing $X.output where X isn't an ancestor
    // would silently resolve to "" at runtime, allowing conditional bash
    // nodes (e.g. `when: "$classify.output != 'FEATURE'"` without
    // depends_on: [classify]) to run before their producer. Fix: loader's
    // validateOutputRefs now requires every $X.output ref to be in the
    // referencing node's depends_on chain.
    const yaml = `
name: trap
description: silent-empty trap
nodes:
  - id: classify
    prompt: "classify"
  - id: action
    bash: "echo go"
    when: "$classify.output != 'FEATURE'"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("not in its depends_on chain");
    expect(result.error?.error).toContain("classify");
  });

  test("rejects $X.output reference in a bash body without depends_on (bash)", async () => {
    // Regression: ancestor check originally only scanned when/prompt/loop.prompt,
    // so a bash body using $X.output without depends_on slipped through and
    // resolved to "" at runtime. Fix: bash bodies are part of the validation set.
    const yaml = `
name: bash-trap
description: bash silent-empty trap
nodes:
  - id: classify
    prompt: "classify"
  - id: action
    bash: "echo $classify.output"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("not in its depends_on chain");
    expect(result.error?.error).toContain("classify");
  });

  test("rejects $inputs.* used inside a when: clause (conditions can't resolve it)", async () => {
    // Regression: evaluateCondition (conditions.ts) only resolves $nodeId.output.
    // A workflow whose when: references $inputs.X would silently evaluate
    // against "" at runtime because the condition evaluator has no plumbing
    // for workflow inputs. Loader now rejects $inputs.* in when: bodies.
    const yaml = `
name: bad-when
description: inputs in when
nodes:
  - id: cmd
    bash: "echo go"
    when: "$inputs.output != 'prod'"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("when");
    expect(result.error?.error).toContain("inputs");
  });

  test("rejects bare $inputs.<key> in when: clauses (not just $inputs.output)", async () => {
    // Regression: my first when: check only flagged $X.output patterns, so
    // $inputs.env (no .output) slipped through and evaluated to "" at runtime.
    const yaml = `
name: bad-when-bare
description: bare inputs in when
nodes:
  - id: cmd
    bash: "echo go"
    when: "$inputs.env == 'prod'"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("when");
    expect(result.error?.error).toContain("$inputs.env");
  });

  test("rejects bare $ARGUMENTS in when: clauses", async () => {
    // Same class as $inputs.env. $ARGUMENTS in when: evaluates to "" at
    // runtime since evaluateCondition has no plumbing for ARGUMENTS.
    const yaml = `
name: bad-when-args
description: bare ARGUMENTS in when
nodes:
  - id: cmd
    bash: "echo go"
    when: "$ARGUMENTS == 'prod'"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("when");
    expect(result.error?.error).toContain("$ARGUMENTS");
  });

  test("accepts $inputs.* in prompt and bash bodies (executor resolves them)", async () => {
    // Sanity: the same restriction does NOT apply to prompt/bash bodies —
    // resolveBody resolves $inputs.* there.
    const yaml = `
name: inputs-in-body
description: inputs in bodies
nodes:
  - id: a
    prompt: "use $inputs.foo"
  - id: b
    bash: "echo $inputs.bar"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).toBeNull();
  });

  test("rejects a node id literally named 'ARGUMENTS' (reserved namespace)", async () => {
    // Same shadowing class as 'inputs': $ARGUMENTS substitution would mask a
    // node literally named ARGUMENTS, so $ARGUMENTS.output would resolve to
    // "<inputs.ARGUMENTS>.output" instead of that node's output.
    const yaml = `
name: reserved-args
description: reserved node id
nodes:
  - id: ARGUMENTS
    bash: "echo hi"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("reserved");
    expect(result.error?.error).toContain("ARGUMENTS");
  });

  test("rejects a node id literally named 'inputs' (reserved namespace)", async () => {
    // Regression: previously a workflow could declare id: inputs even though
    // the executor reserves $inputs.* for workflow inputs — that meant the
    // user's $inputs.foo would silently resolve to the input map, not the
    // node's output. Loader now rejects the collision at parse time.
    const yaml = `
name: reserved
description: reserved node id
nodes:
  - id: inputs
    bash: "echo hi"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toContain("reserved");
    expect(result.error?.error).toContain("inputs");
  });

  test("loader honors \\$X.output escape — literal placeholders in bash bodies parse", async () => {
    // Regression: when bash bodies were added to validateOutputRefs, scripts
    // containing literal \$jq.output (or any escaped placeholder in jq /
    // template snippets) got incorrectly rejected. The loader now uses the
    // same (?<!\\) lookbehind as the executor's substitution.
    const yaml = `
name: escape-ok
description: literal placeholder
nodes:
  - id: cmd
    bash: "echo \\\\$jq.output"
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).toBeNull();
  });

  test("accepts $X.output reference when X IS an ancestor (transitive)", async () => {
    // Sanity: depends_on chain a → b → c lets c reference a.output.
    const yaml = `
name: ok
description: transitive ref
nodes:
  - id: a
    bash: "echo A"
  - id: b
    depends_on: [a]
    bash: "echo B"
  - id: c
    depends_on: [b]
    bash: "echo \\"$a.output\\""
`;
    const result = parseWorkflow(yaml, "inline.yaml");
    expect(result.error).toBeNull();
  });
});

describe("runWorkflow — DAG validation", () => {
  test("cycle throws ExecutorValidationError", async () => {
    const workflow: WorkflowDefinition = {
      name: "cyclic",
      description: "cycle test",
      nodes: [
        { id: "a", bash: "echo a", depends_on: ["b"] } as DagNode,
        { id: "b", bash: "echo b", depends_on: ["a"] } as DagNode,
      ],
    };
    await expect(
      runWorkflow({
        ...baseOpts(workflow),
        handlers: new Map([["bash", echoHandler("bash").handler]]),
      }),
    ).rejects.toThrow(ExecutorValidationError);
  });

  test("duplicate node id throws ExecutorValidationError", async () => {
    const workflow: WorkflowDefinition = {
      name: "dup",
      description: "duplicate id test",
      nodes: [{ id: "same", bash: "echo 1" } as DagNode, { id: "same", bash: "echo 2" } as DagNode],
    };
    await expect(
      runWorkflow({
        ...baseOpts(workflow),
        handlers: new Map([["bash", echoHandler("bash").handler]]),
      }),
    ).rejects.toThrow(ExecutorValidationError);
  });

  test("unknown depends_on throws ExecutorValidationError", async () => {
    const workflow: WorkflowDefinition = {
      name: "missing",
      description: "missing dep test",
      nodes: [{ id: "n", bash: "echo n", depends_on: ["ghost"] } as DagNode],
    };
    await expect(
      runWorkflow({
        ...baseOpts(workflow),
        handlers: new Map([["bash", echoHandler("bash").handler]]),
      }),
    ).rejects.toThrow(ExecutorValidationError);
  });
});

describe("runWorkflow — approval node (W4.6)", () => {
  test("emits node_started → resolver fires → node_done with reply as output", async () => {
    const workflow = parseInline(`
name: pa
description: approval test
nodes:
  - id: gen
    prompt: |
      generate
  - id: review
    depends_on: [gen]
    approval:
      message: please approve
  - id: apply
    depends_on: [review]
    when: "$review.output == 'approve'"
    bash: echo applied
`);
    const approval = makeApprovalHandler({
      awaitApproval: async (_runId, nodeId, message) => {
        expect(nodeId).toBe("review");
        expect(message).toBe("please approve");
        return "approve";
      },
    });
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["prompt", echoHandler("prompt").handler],
        ["approval", approval],
        ["bash", echoHandler("bash").handler],
      ]),
      onEvent,
    });
    // Resolver's reply becomes the node's output.
    expect(summary.nodes.review.state).toBe("completed");
    expect(summary.nodes.review.output).toBe("approve");
    // Downstream `apply` ran because $review.output == 'approve'.
    expect(summary.nodes.apply.state).toBe("completed");
    // node_started for review precedes its node_done in the event stream.
    const reviewStarted = events.findIndex(
      (e) => e.type === "node_started" && e.nodeId === "review",
    );
    const reviewDone = events.findIndex((e) => e.type === "node_done" && e.nodeId === "review");
    expect(reviewStarted).toBeGreaterThan(-1);
    expect(reviewDone).toBeGreaterThan(reviewStarted);
  });

  test("non-approve reply skips downstream nodes via when:", async () => {
    const workflow = parseInline(`
name: pa
description: approval test
nodes:
  - id: review
    approval:
      message: review me
  - id: apply
    depends_on: [review]
    when: "$review.output == 'approve'"
    bash: echo applied
`);
    const approval = makeApprovalHandler({
      awaitApproval: async () => "narrow the regex",
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["approval", approval],
        ["bash", echoHandler("bash").handler],
      ]),
    });
    expect(summary.nodes.review.output).toBe("narrow the regex");
    expect(summary.nodes.apply.state).toBe("skipped");
    expect(summary.status).toBe("succeeded");
  });

  test("abort during pause cancels the run cleanly", async () => {
    const workflow = parseInline(`
name: pa
description: cancel during pause
nodes:
  - id: review
    approval:
      message: review me
  - id: apply
    depends_on: [review]
    bash: echo never
`);
    const abort = new AbortController();
    const approval = makeApprovalHandler({
      awaitApproval: (_runId, _nodeId, _msg, sig) =>
        new Promise<string>((_resolve, reject) => {
          sig.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const promise = runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["approval", approval],
        ["bash", echoHandler("bash").handler],
      ]),
      abortSignal: abort.signal,
    });
    setTimeout(() => abort.abort("cancelled via DELETE"), 5);
    const summary = await promise;
    expect(summary.status).toBe("cancelled");
    // `apply` was downstream of an unfinished review; cancellation
    // shouldn't promote it through.
    expect(summary.nodes.apply.state).toBe("skipped");
  });
});

describe("runWorkflow — converge", () => {
  test("re-runs the converge subgraph until the gate passes", async () => {
    const workflow = parseInline(`
name: converge-pass
description: converge gate passes on round two
converge:
  gate: gate
  max_rounds: 3
nodes:
  - id: prepare
    bash: "prepare round=$converge.round"
  - id: gate
    depends_on: [prepare]
    bash: "gate sees $prepare.output round=$converge.round"
  - id: after
    depends_on: [gate]
    bash: "after gate=$gate.output round=$converge.round"
`);
    const calls: RecordedCall[] = [];
    let prepareCalls = 0;
    let gateCalls = 0;
    const bash: NodeHandler = {
      type: "bash",
      async handle(node, ctx) {
        calls.push({
          nodeId: node.id,
          resolvedBody: ctx.resolvedBody,
          rawBody: ctx.rawBody,
          at: Date.now(),
        });
        if (node.id === "prepare") {
          prepareCalls++;
          return { status: "succeeded", output: { kind: "text", text: `prepare-${prepareCalls}` } };
        }
        if (node.id === "gate") {
          gateCalls++;
          if (gateCalls < 2) {
            return { status: "failed", output: { kind: "text", text: "" }, error: "not ready" };
          }
          return { status: "succeeded", output: { kind: "text", text: `gate-${gateCalls}` } };
        }
        return { status: "succeeded", output: { kind: "text", text: "after" } };
      },
    };

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", bash]]),
    });

    expect(summary.status).toBe("succeeded");
    expect(calls.filter((call) => call.nodeId === "prepare")).toHaveLength(2);
    const gateResolved = calls
      .filter((call) => call.nodeId === "gate")
      .map((call) => call.resolvedBody);
    expect(gateResolved).toEqual(["gate sees prepare-1 round=1", "gate sees prepare-2 round=2"]);
    const afterCalls = calls.filter((call) => call.nodeId === "after");
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0].resolvedBody).toBe("after gate=gate-2 round=");
    expect(summary.nodes.prepare.output).toBe("prepare-2");
    expect(summary.nodes.gate.output).toBe("gate-2");
  });

  test("resume clears seeded converge ancestors before round one when gate is not seeded", async () => {
    const workflow = parseInline(`
name: converge-resume-seed
description: stale converge ancestors are cleared on resume
converge:
  gate: gate
  max_rounds: 1
nodes:
  - id: fix
    bash: "fix round=$converge.round"
  - id: gate
    depends_on: [fix]
    bash: "gate sees $fix.output round=$converge.round"
`);
    const seededOutputs = new Map<string, NodeOutput>([
      [
        "fix",
        {
          state: "completed",
          output: "stale-fix",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1000,
        },
      ],
    ]);
    let fixCalls = 0;
    const gateBodies: string[] = [];
    const bash: NodeHandler = {
      type: "bash",
      async handle(node, ctx) {
        if (node.id === "fix") {
          fixCalls++;
          return { status: "succeeded", output: { kind: "text", text: `fresh-fix-${fixCalls}` } };
        }
        if (node.id === "gate") {
          gateBodies.push(ctx.resolvedBody);
          const passed = ctx.resolvedBody.includes("fresh-fix-1");
          return passed
            ? { status: "succeeded", output: { kind: "text", text: "gate-pass" } }
            : { status: "failed", output: { kind: "text", text: "" }, error: "stale input" };
        }
        return { status: "succeeded", output: { kind: "text", text: "ok" } };
      },
    };

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", bash]]),
      completedNodeOutputs: seededOutputs,
    });

    expect(summary.status).toBe("succeeded");
    expect(fixCalls).toBe(1);
    expect(gateBodies).toEqual(["gate sees fresh-fix-1 round=1"]);
  });

  test("on_exhaust fail leaves the final failed gate output", async () => {
    const workflow = parseInline(`
name: converge-fail
description: converge gate never passes
converge:
  gate: gate
  max_rounds: 2
nodes:
  - id: prepare
    bash: "prepare"
  - id: gate
    depends_on: [prepare]
    bash: "gate"
`);
    let gateCalls = 0;
    const bash: NodeHandler = {
      type: "bash",
      async handle(node) {
        if (node.id === "gate") {
          gateCalls++;
          return { status: "failed", output: { kind: "text", text: "" }, error: "still red" };
        }
        return { status: "succeeded", output: { kind: "text", text: "ok" } };
      },
    };

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", bash]]),
    });

    expect(summary.status).toBe("failed");
    expect(summary.nodes.gate.state).toBe("failed");
    expect(gateCalls).toBe(2);
  });

  test("on_exhaust fail emits a failed gate override when the gate was skipped", async () => {
    const workflow = parseInline(`
name: converge-fail-skipped-gate
description: skipped gate gets synthesized failure
converge:
  gate: gate
  max_rounds: 1
nodes:
  - id: fix
    bash: "fix"
  - id: gate
    depends_on: [fix]
    bash: "gate"
`);
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([
        [
          "bash",
          {
            type: "bash",
            async handle(node) {
              if (node.id === "fix") {
                return {
                  status: "failed",
                  output: { kind: "text", text: "fix failed" },
                  error: "still red",
                };
              }
              return { status: "succeeded", output: { kind: "text", text: "ok" } };
            },
          } satisfies NodeHandler,
        ],
      ]),
      onEvent,
    });

    expect(summary.status).toBe("failed");
    expect(summary.nodes.gate.state).toBe("failed");
    const gateDoneStatuses = events
      .filter(
        (e): e is Extract<RunStreamEvent, { type: "node_done" }> =>
          e.type === "node_done" && e.nodeId === "gate",
      )
      .map((e) => e.result.status);
    expect(gateDoneStatuses).toEqual(["skipped", "failed"]);
  });

  test("on_exhaust approval accepts the failed gate and runs downstream nodes", async () => {
    const workflow = parseInline(`
name: converge-approval
description: exhausted converge can be approved
converge:
  gate: gate
  max_rounds: 1
  on_exhaust: approval
nodes:
  - id: gate
    bash: "gate"
  - id: after
    depends_on: [gate]
    bash: "after gate=$gate.output"
`);
    const approvalCalls: string[] = [];
    const approval = makeApprovalHandler({
      awaitApproval: async (_runId, nodeId, message) => {
        approvalCalls.push(`${nodeId}:${message}`);
        return "approved by human";
      },
    });
    const { handler: bash, calls } = echoHandler("bash");
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        [
          "bash",
          {
            type: "bash",
            async handle(node, ctx) {
              if (node.id === "gate") {
                return { status: "failed", output: { kind: "text", text: "" }, error: "not ready" };
              }
              return bash.handle(node, ctx);
            },
          },
        ],
        ["approval", approval],
      ]),
      onEvent,
    });

    expect(summary.status).toBe("succeeded");
    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0]).toContain("gate__converge_exhaust:");
    expect(summary.nodes.gate).toMatchObject({
      state: "completed",
      output: "approved by human",
    });
    expect(summary.nodes.after.state).toBe("completed");
    expect(calls[0].resolvedBody).toBe("after gate=approved by human");
    const gateDoneStatuses = events
      .filter(
        (e): e is Extract<RunStreamEvent, { type: "node_done" }> =>
          e.type === "node_done" && e.nodeId === "gate",
      )
      .map((e) => e.result.status);
    expect(gateDoneStatuses).toEqual(["failed", "succeeded"]);
  });

  test("on_exhaust approval absorbs failed converge ancestors", async () => {
    const workflow = parseInline(`
name: converge-approval-ancestor-failed
description: ancestor failures are absorbed on approval
converge:
  gate: gate
  max_rounds: 1
  on_exhaust: approval
nodes:
  - id: fix
    bash: "fix"
  - id: gate
    depends_on: [fix]
    bash: "gate"
  - id: after
    depends_on: [gate]
    bash: "after fix=$fix.output gate=$gate.output"
`);
    const approval = makeApprovalHandler({
      awaitApproval: async () => "approved by human",
    });
    const { handler: echoBash, calls } = echoHandler("bash");
    let gateCalls = 0;
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        [
          "bash",
          {
            type: "bash",
            async handle(node, ctx) {
              if (node.id === "fix") {
                return {
                  status: "failed",
                  output: { kind: "text", text: "fix-output" },
                  error: "still red",
                };
              }
              if (node.id === "gate") {
                gateCalls++;
              }
              return echoBash.handle(node, ctx);
            },
          },
        ],
        ["approval", approval],
      ]),
    });

    expect(summary.status).toBe("succeeded");
    expect(gateCalls).toBe(0);
    expect(summary.nodes.fix).toMatchObject({ state: "completed", output: "fix-output" });
    expect(summary.nodes.gate).toMatchObject({
      state: "completed",
      output: "approved by human",
    });
    expect(summary.nodes.after.state).toBe("completed");
    expect(calls[0].resolvedBody).toBe("after fix=fix-output gate=approved by human");
  });

  test("on_exhaust approval does not shadow a real node id collision", async () => {
    const workflow = parseInline(`
name: converge-approval-collision
description: approval node id collision stays safe
converge:
  gate: gate
  max_rounds: 1
  on_exhaust: approval
nodes:
  - id: gate
    bash: "gate"
  - id: gate__converge_exhaust
    depends_on: [gate]
    bash: "real collide node"
  - id: after
    depends_on: [gate__converge_exhaust]
    bash: "after $gate__converge_exhaust.output"
`);
    const approvalNodeIds: string[] = [];
    const approval = makeApprovalHandler({
      awaitApproval: async (_runId, nodeId) => {
        approvalNodeIds.push(nodeId);
        return "approved by human";
      },
    });
    const { handler: echoBash, calls } = echoHandler("bash");
    let collideCalls = 0;
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        [
          "bash",
          {
            type: "bash",
            async handle(node, ctx) {
              if (node.id === "gate") {
                return { status: "failed", output: { kind: "text", text: "" }, error: "not ready" };
              }
              if (node.id === "gate__converge_exhaust") {
                collideCalls++;
                return { status: "succeeded", output: { kind: "text", text: "real-output" } };
              }
              return echoBash.handle(node, ctx);
            },
          },
        ],
        ["approval", approval],
      ]),
    });

    expect(summary.status).toBe("succeeded");
    expect(collideCalls).toBe(1);
    expect(approvalNodeIds).toHaveLength(1);
    expect(approvalNodeIds[0].startsWith("gate__converge_exhaust")).toBe(true);
    expect(approvalNodeIds[0]).not.toBe("gate__converge_exhaust");
    expect(summary.nodes.gate.state).toBe("completed");
    expect(summary.nodes.gate__converge_exhaust).toMatchObject({
      state: "completed",
      output: "real-output",
    });
    expect(calls[0].resolvedBody).toBe("after real-output");
  });

  test("on_exhaust approval rejection leaves the run failed", async () => {
    const workflow = parseInline(`
name: converge-approval-reject
description: exhausted converge can be rejected
converge:
  gate: gate
  max_rounds: 1
  on_exhaust: approval
nodes:
  - id: gate
    bash: "gate"
  - id: after
    depends_on: [gate]
    bash: "after"
`);
    const approval = makeApprovalHandler({
      awaitApproval: async () => {
        throw new Error("rejected");
      },
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["bash", failingHandler("bash", "not ready")],
        ["approval", approval],
      ]),
    });

    expect(summary.status).toBe("failed");
    expect(summary.nodes.gate.state).toBe("failed");
    expect(summary.nodes.after.state).toBe("skipped");
  });

  test("approval inside the converge subgraph pauses once per round after output reset", async () => {
    const workflow = parseInline(`
name: converge-subgraph-approval
description: approval in the converge subgraph repeats each round
converge:
  gate: gate
  max_rounds: 2
nodes:
  - id: review
    approval:
      message: review this round
  - id: gate
    depends_on: [review]
    bash: "gate saw $review.output round=$converge.round"
`);
    const pendingApprovals: Array<{
      nodeId: string;
      message: string;
      resolve: (reply: string) => void;
    }> = [];
    const approval = makeApprovalHandler({
      awaitApproval: (_runId, nodeId, message) =>
        new Promise<string>((resolve) => {
          pendingApprovals.push({ nodeId, message, resolve });
        }),
    });
    const gateCalls: RecordedCall[] = [];
    const bash: NodeHandler = {
      type: "bash",
      async handle(node, ctx) {
        gateCalls.push({
          nodeId: node.id,
          resolvedBody: ctx.resolvedBody,
          rawBody: ctx.rawBody,
          at: Date.now(),
        });
        return { status: "failed", output: { kind: "text", text: "" }, error: "still red" };
      },
    };

    const run = runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map<string, NodeHandler>([
        ["approval", approval],
        ["bash", bash],
      ]),
    });

    await waitFor(() => pendingApprovals.length === 1, "first approval did not pause");
    expect(pendingApprovals[0].nodeId).toBe("review");
    expect(pendingApprovals[0].message).toBe("review this round");
    pendingApprovals[0].resolve("approved-1");

    await waitFor(() => pendingApprovals.length === 2, "second approval did not pause");
    expect(pendingApprovals[1].nodeId).toBe("review");
    expect(pendingApprovals[1].message).toBe("review this round");
    pendingApprovals[1].resolve("approved-2");

    const summary = await run;
    expect(summary.status).toBe("failed");
    expect(summary.nodes.review.output).toBe("approved-2");
    expect(gateCalls.map((call) => call.resolvedBody)).toEqual([
      "gate saw approved-1 round=1",
      "gate saw approved-2 round=2",
    ]);
  });

  test("non-converge workflows keep the single-pass path", async () => {
    const workflow = parseInline(`
name: no-converge
description: baseline
nodes:
  - id: first
    bash: "first round=$converge.round"
  - id: second
    depends_on: [first]
    bash: "second $first.output"
`);
    const { handler, calls } = echoHandler("bash");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
    });

    expect(summary.status).toBe("succeeded");
    expect(calls.map((call) => call.nodeId)).toEqual(["first", "second"]);
    expect(calls[0].resolvedBody).toBe("first round=");
  });
});

// The bundled gate nodes' bash scripts shell out to jq, which the minimal
// supported Windows setup (Git Bash) does not ship — skip rather than fail there.
const hasJq = Bun.which("jq") !== null;

// ---------------------------------------------------------------------------
// smoke-test (every CI-compatible node type)
// ---------------------------------------------------------------------------

import { bashHandler } from "./handlers/bash.ts";
import { makeCancelHandler } from "./handlers/cancel.ts";
import { makeCommandHandler } from "./handlers/command.ts";
import { makeLoopHandler } from "./handlers/loop.ts";
import { makeScriptHandler } from "./handlers/script.ts";

// ---------------------------------------------------------------------------
// finish-pr — drives the real converge loop with its deterministic jq gates
// (triage-gate, reply-gate, converge-check) run for real and the gh/git/CI nodes
// canned. Covers: the converge gate reading the post-CI re-fetch rather than the
// start-of-round thread set, the has_new fan-out into fix/reply, resolve-retry
// re-resolving a fixed-but-unresolved thread without re-replying, fork
// cancellation, and round-cap exhaustion.
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq)("runWorkflow — finish-pr converge loop gates", () => {
  interface Thread {
    threadId: string;
    commentId: number;
  }

  function threadRows(threads: Thread[]): unknown[] {
    return threads.map((t) => ({
      threadId: t.threadId,
      path: "src/a.ts",
      line: 1,
      commentId: t.commentId,
      body: "b",
      author: "copilot",
      replyCount: 0,
    }));
  }

  interface ConvergeOpts {
    isFork?: boolean;
    hasNew: boolean;
    ciStatus: "PASS" | "FAIL";
    threads?: Thread[];
    triage?: { threadId: string; decision: string }[];
    results?: {
      threadId: string;
      commentId: number;
      action: string;
      commit: string | null;
      reply: string;
    }[];
    postCiThreads?: unknown[];
    postCiRetry?: unknown[];
    handled?: unknown[];
    resolveRetry?: Thread[];
    // Node ids to run through the real bash handler in addition to the jq gates
    // (e.g. "resolve-retry" with its live forge side effect stubbed below).
    realBashExtra?: string[];
  }

  // Seeds the artifacts a real round would have produced, cans the gh/git/CI bash
  // nodes (fetch-state returns the JSON summary; await-ci returns the CI_STATUS
  // channel), and runs the real bash handler only for the three deterministic
  // jq gates. A cancel handler trips the run's AbortController so refuse-fork
  // actually cancels.
  function convergeRun(opts: ConvergeOpts) {
    const artifactsDir = mkdtempSync(join(tmpdir(), "cpr-"));
    const threads = opts.threads ?? [];
    const write = (name: string, value: unknown): void =>
      writeFileSync(join(artifactsDir, name), JSON.stringify(value));

    // fetch-state writes .pr-number early and unconditionally; resolve-retry
    // (which depends on it) reads it for the forge resolve call. Seed it so the
    // node's `cat .pr-number` under `set -e` matches production.
    writeFileSync(join(artifactsDir, ".pr-number"), "42");
    write("threads.json", threadRows(threads));
    write("all-unresolved-threads.json", threadRows(threads));
    write("handled.json", opts.handled ?? []);
    write("resolve-retry.json", threadRows(opts.resolveRetry ?? []));
    write("post-ci-threads.json", opts.postCiThreads ?? []);
    write("post-ci-retry.json", opts.postCiRetry ?? []);
    if (opts.triage) {
      write("triage.json", {
        threads: opts.triage.map((t) => ({
          threadId: t.threadId,
          path: "src/a.ts",
          line: 1,
          decision: t.decision,
          reasoning: "r",
          reply_hint: "h",
        })),
      });
    }
    if (opts.results)
      write(
        "results.json",
        opts.results.map((r) => ({ ...r })),
      );

    const fetchStateOutput = JSON.stringify({
      is_fork: opts.isFork ? "true" : "false",
      has_new: opts.hasNew ? "true" : "false",
      new_count: opts.hasNew ? threads.length : 0,
      open_count: threads.length,
      retry_count: 0,
    });

    const approvalCalls: string[] = [];
    let convergeCheckCalls = 0;
    const canned = {
      status: "succeeded" as const,
      output: { kind: "text" as const, text: "ok" },
    };
    const realBashIds = new Set([
      "triage-gate",
      "reply-gate",
      "converge-check",
      ...(opts.realBashExtra ?? []),
    ]);
    const prompt: NodeHandler = { type: "prompt", handle: async () => canned };
    const bash: NodeHandler = {
      type: "bash",
      async handle(node, ctx) {
        if (node.id === "converge-check") convergeCheckCalls++;
        if (realBashIds.has(node.id)) {
          if (node.id === "resolve-retry") {
            return bashHandler.handle(node, {
              ...ctx,
              rawBody: `forge() { return 0; }\n${ctx.rawBody}`,
            });
          }
          return bashHandler.handle(node, ctx);
        }
        if (node.id === "fetch-state") {
          return { status: "succeeded", output: { kind: "text", text: fetchStateOutput } };
        }
        if (node.id === "await-ci") {
          return {
            status: "succeeded",
            output: { kind: "text", text: `watch\nCI_STATUS: ${opts.ciStatus}` },
          };
        }
        return canned;
      },
    };
    const approval: NodeHandler = {
      type: "approval",
      async handle(node) {
        approvalCalls.push(node.id);
        return { status: "succeeded", output: { kind: "text", text: "approve" } };
      },
    };
    const controller = new AbortController();
    const cancel = makeCancelHandler({ requestCancel: () => controller.abort() });
    const run = runWorkflow({
      workflow: loadBundled("finish-pr"),
      runId: "run-cpr",
      inputs: { ARGUMENTS: "converge pr 42" },
      cwd: artifactsDir,
      artifactsDir,
      abortSignal: controller.signal,
      handlers: new Map([
        ["prompt", prompt],
        ["bash", bash],
        ["approval", approval],
        ["cancel", cancel],
      ]),
    });
    return { run, approvalCalls, convergeCheckCalls: () => convergeCheckCalls, artifactsDir };
  }

  test("a new-thread round drives the fix/reply subgraph then converges", async () => {
    const { run, approvalCalls, convergeCheckCalls } = convergeRun({
      hasNew: true,
      ciStatus: "PASS",
      threads: [{ threadId: "t1", commentId: 1 }],
      triage: [{ threadId: "t1", decision: "actionable-code-change" }],
      results: [{ threadId: "t1", commentId: 1, action: "fixed", commit: "c1", reply: "r1" }],
      postCiThreads: [],
    });
    const summary = await run;
    expect(summary.status).toBe("succeeded");
    // has_new drove the whole mutation chain.
    expect(approvalCalls).toEqual(["approve"]);
    expect(summary.nodes.triage.state).toBe("completed");
    expect(summary.nodes.fix.state).toBe("completed");
    expect(summary.nodes.push.state).toBe("completed");
    expect(summary.nodes["reply-gate"].state).toBe("completed");
    expect(summary.nodes["reply-resolve"].state).toBe("completed");
    // Post-CI re-fetch (empty) + CI PASS converge in one round.
    expect(summary.nodes["post-ci-state"].state).toBe("completed");
    expect(summary.nodes["converge-check"].state).toBe("completed");
    expect(summary.nodes.report.state).toBe("completed");
    expect(convergeCheckCalls()).toBe(1);
  });

  test("a clean round with no new threads and CI PASS converges immediately", async () => {
    const { run, approvalCalls, convergeCheckCalls } = convergeRun({
      hasNew: false,
      ciStatus: "PASS",
      threads: [],
      postCiThreads: [],
    });
    const summary = await run;
    expect(summary.status).toBe("succeeded");
    expect(approvalCalls).toEqual([]);
    // No new threads: the fix chain is skipped entirely.
    expect(summary.nodes.triage.state).toBe("skipped");
    expect(summary.nodes.fix.state).toBe("skipped");
    expect(summary.nodes["reply-resolve"].state).toBe("skipped");
    expect(summary.nodes["converge-check"].state).toBe("completed");
    expect(summary.nodes.report.state).toBe("completed");
    expect(convergeCheckCalls()).toBe(1);
  });

  test("converge-check gates on the post-CI set: a thread that landed mid-watch blocks convergence until exhaustion", async () => {
    // fetch-state saw no new threads at the START of the round (has_new false),
    // but the post-CI re-fetch found one → converge-check must NOT declare
    // convergence even though CI passed and threads.json is empty.
    const { run, convergeCheckCalls } = convergeRun({
      hasNew: false,
      ciStatus: "PASS",
      threads: [],
      postCiThreads: threadRows([{ threadId: "late", commentId: 9 }]),
    });
    const summary = await run;
    // Never converges (post-ci NEW_COUNT stays > 0), so the loop runs the cap.
    expect(convergeCheckCalls()).toBe(8);
    expect(summary.status).toBe("succeeded"); // on_exhaust: approval accepted below
  });

  test("a fork PR cancels the run at refuse-fork before CI or the gate run", async () => {
    const { run, convergeCheckCalls } = convergeRun({
      isFork: true,
      hasNew: false,
      ciStatus: "PASS",
      threads: [],
    });
    const summary = await run;
    expect(summary.status).toBe("cancelled");
    expect(summary.nodes["refuse-fork"].state).toBe("failed");
    // The cancel lands before CI is watched or the gate is evaluated.
    expect(summary.nodes["converge-check"].state).not.toBe("completed");
    expect(summary.nodes.report.state).not.toBe("completed");
    expect(convergeCheckCalls()).toBe(0);
  });

  test("a persistently failing gate exhausts the round cap then hits the exhaust approval", async () => {
    const { run, approvalCalls, convergeCheckCalls } = convergeRun({
      hasNew: false,
      ciStatus: "FAIL",
      threads: [],
      postCiThreads: [],
    });
    const summary = await run;
    // converge-check ran once per round for the full cap, then on_exhaust paused.
    expect(convergeCheckCalls()).toBe(8);
    expect(approvalCalls).toContain("converge-check__converge_exhaust");
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.report.state).toBe("completed");
  });

  test("a fixed-but-unresolved thread is re-resolved without a second reply", async () => {
    // A prior round posted the reply and committed the fix, but resolveReviewThread
    // failed, so the ledger holds { replied: true, resolved: false }. This round
    // must retry the resolve only — never re-triage or re-reply the thread — and
    // flip the ledger once the resolve succeeds. resolve-retry runs for real; a
    // successful shell function stands in for the live GraphQL resolve so the
    // node's own retry + ledger-flip logic executes.
    const { run, approvalCalls, artifactsDir } = convergeRun({
      hasNew: false,
      ciStatus: "PASS",
      threads: [],
      postCiThreads: [],
      postCiRetry: [],
      resolveRetry: [{ threadId: "T_fix", commentId: 7 }],
      handled: [
        {
          threadId: "T_fix",
          commentId: 7,
          action: "fixed",
          decision: "actionable-code-change",
          commit: "c9",
          reply: "done",
          replied: true,
          resolved: false,
          round: 1,
        },
      ],
      realBashExtra: ["resolve-retry"],
    });
    const summary = await run;
    expect(summary.status).toBe("succeeded");
    // A retry thread has a ledger entry, so it is not "new": the triage/reply
    // path never runs for it — no duplicate public comment.
    expect(approvalCalls).toEqual([]);
    expect(summary.nodes.triage.state).toBe("skipped");
    expect(summary.nodes["reply-resolve"].state).toBe("skipped");
    // resolve-retry re-attempted the resolve and, on success, flipped the ledger.
    expect(summary.nodes["resolve-retry"].state).toBe("completed");
    const ledger = JSON.parse(readFileSync(join(artifactsDir, "handled.json"), "utf8")) as Array<{
      threadId: string;
      resolved: boolean;
    }>;
    expect(ledger.find((e) => e.threadId === "T_fix")?.resolved).toBe(true);
  });
});

// Bundled smoke-test is Bun-only (no `runtime: uv` nodes), so this suite runs unconditionally.
describe("runWorkflow — smoke-test (every node type)", () => {
  test("all active nodes succeed and the final assert prints PASS", async () => {
    const workflow = loadBundled("smoke-test");

    // Canned prompt responses for prompt-node / command-node / loop iterations.
    const promptHandler: NodeHandler = {
      type: "prompt",
      async handle(node, _ctx) {
        if (node.id === "prompt-node") {
          return { status: "succeeded", output: { kind: "text", text: "ok" } };
        }
        // Synthesized command-node prompt: the file content from
        // e2e-echo-command.md is what we see in resolvedBody.
        if (node.id === "command-node") {
          return {
            status: "succeeded",
            output: { kind: "text", text: "command-echo: smoke" },
          };
        }
        // Loop iterations come in as ids of the form `loop-node#1`,
        // `loop-node#2`. Return DONE on the first iteration to exit
        // early.
        if (node.id.startsWith("loop-node#")) {
          return { status: "succeeded", output: { kind: "text", text: "DONE" } };
        }
        return {
          status: "failed",
          output: { kind: "text", text: "" },
          error: `unexpected node id in smoke prompt handler: ${node.id}`,
        };
      },
    };

    const handlers = new Map<string, NodeHandler>([
      ["bash", bashHandler],
      ["prompt", promptHandler],
      ["command", makeCommandHandler({ promptHandler })],
      ["loop", makeLoopHandler({ promptHandler })],
      ["script", makeScriptHandler()],
    ]);

    // Seed a throwaway home from the bundled assets so the command/script
    // nodes resolve `e2e-echo-command` and `echo-args` from <cwd>/.keelson/,
    // the same files production seeds into the real home on first run.
    const cwd = mkdtempSync(join(tmpdir(), "keelson-smoke-"));
    seedStarterAssets(join(cwd, ".keelson"));
    const summary = await runWorkflow({
      workflow,
      runId: "smoke-1",
      inputs: { ARGUMENTS: "smoke" },
      handlers,
      cwd,
    });

    expect(summary.status).toBe("succeeded");
    for (const node of workflow.nodes) {
      expect(summary.nodes[node.id]?.state).toBe("completed");
    }
    expect(summary.nodes.assert.output).toContain("PASS: all node types verified");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// memory: block
// ---------------------------------------------------------------------------

interface RecallCallRecord {
  req: Record<string, unknown>;
}
interface WritebackCallRecord {
  req: Record<string, unknown>;
}

function mockMemory(
  opts: {
    recallItems?: readonly Record<string, unknown>[];
    recallTraceId?: string;
    recallShouldThrow?: boolean;
    writebackWritten?: readonly { memoryId: string }[];
    writebackBlocked?: readonly { reason: string; summary: string }[];
    writebackShouldThrow?: boolean;
  } = {},
): {
  tools: MemoryTools;
  recalls: RecallCallRecord[];
  writebacks: WritebackCallRecord[];
} {
  const recalls: RecallCallRecord[] = [];
  const writebacks: WritebackCallRecord[] = [];
  const tools: MemoryTools = {
    recall: async (req): Promise<RecallResponseLike> => {
      recalls.push({ req: req as Record<string, unknown> });
      if (opts.recallShouldThrow) throw new Error("recall blew up");
      return {
        items: opts.recallItems ?? [],
        trace: {
          traceId: opts.recallTraceId ?? "trace-1",
          returned: (opts.recallItems ?? []).length,
        },
      };
    },
    writeback: async (req): Promise<WritebackResponseLike> => {
      writebacks.push({ req: req as Record<string, unknown> });
      if (opts.writebackShouldThrow) throw new Error("writeback blew up");
      return {
        written: opts.writebackWritten ?? [{ memoryId: "mem-1" }],
        blocked: opts.writebackBlocked ?? [],
      };
    },
  };
  return { tools, recalls, writebacks };
}

describe("runWorkflow — memory: block", () => {
  const promptWorkflowYaml = (memoryBlock: string, body = "Body: $memory.recall.items") => `
name: memory-recall-test
description: memory block inline fixture
nodes:
  - id: think
    prompt: |
      ${body}
    memory:
${memoryBlock}
`;

  test("recall fires before substitution and populates $memory.recall.items", async () => {
    const workflow = parseInline(
      promptWorkflowYaml(
        `      recall:\n        query: prior fixes\n        limits: { maxItems: 3 }`,
        "Prior: $memory.recall.items / trace=$memory.recall.trace",
      ),
    );
    const items = [
      { memoryId: "m1", summary: "first" },
      { memoryId: "m2", summary: "second" },
    ];
    const mem = mockMemory({ recallItems: items, recallTraceId: "trace-xyz" });
    const { handler, calls } = echoHandler("prompt");

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(summary.status).toBe("succeeded");
    expect(mem.recalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // Substitution: $memory.recall.items → JSON-stringified array, $memory.recall.trace → trace id
    expect(calls[0]?.resolvedBody).toContain(JSON.stringify(items));
    expect(calls[0]?.resolvedBody).toContain("trace=trace-xyz");
  });

  test("recall query is resolved against inputs before recall is called", async () => {
    const workflow = parseInline(
      promptWorkflowYaml(`      recall:\n        query: "prior fixes for $inputs.cve"`),
    );
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      inputs: { cve: "CVE-2026-1234" },
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.recalls[0]?.req.query).toBe("prior fixes for CVE-2026-1234");
  });

  test("recall failure emits run_warning and substitutes $memory.recall.items as []", async () => {
    const workflow = parseInline(promptWorkflowYaml(`      recall:\n        query: anything`));
    const mem = mockMemory({ recallShouldThrow: true });
    const { handler, calls } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
      onEvent,
    });

    expect(summary.status).toBe("succeeded");
    expect(calls[0]?.resolvedBody).toContain("Body: []");
    const warning = events.find(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("memory recall failed");
  });

  test("writeback fires after node success when on: success", async () => {
    const workflow = parseInline(`
name: wb-success
description: test
nodes:
  - id: think
    prompt: do the thing
    memory:
      writeback:
        on: success
        type: decision
        summary: result
        content: hello world
`);
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(summary.status).toBe("succeeded");
    expect(mem.writebacks).toHaveLength(1);
    const draft = (mem.writebacks[0]?.req.memories as Record<string, unknown>[])?.[0];
    expect(draft?.type).toBe("decision");
    expect(draft?.content).toBe("hello world");
    // Evidence-default invariant: executor hard-codes "generated" regardless
    // of any author-supplied value (the schema doesn't expose provenance).
    expect(draft?.provenance).toBe("generated");
  });

  test("writeback does NOT fire after node failure when on: success", async () => {
    const workflow = parseInline(`
name: wb-skip
description: test
nodes:
  - id: fail
    prompt: doomed
    memory:
      writeback:
        on: success
        type: failure
        summary: should not write
        content: should not write
`);
    const mem = mockMemory();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", failingHandler("prompt", "kaboom")]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(0);
  });

  test("writeback fires after node failure when on: always", async () => {
    const workflow = parseInline(`
name: wb-always
description: test
nodes:
  - id: fail
    prompt: doomed
    memory:
      writeback:
        on: always
        type: failure
        summary: failure note
        content: it failed
`);
    const mem = mockMemory();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", failingHandler("prompt", "kaboom")]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(1);
  });

  test("writeback task.taskId is qualified by workflow name (cross-workflow dedup safety)", async () => {
    // Per-row dedupe key is `${task.runtime}:${task.taskId}:${type}:${contentHash}` — flowId
    // and the envelope idempotencyKey are excluded. The executor qualifies taskId with the
    // workflow name so two workflows sharing a node id + content can't collide.
    const workflow = parseInline(`
name: alpha-workflow
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      writeback:
        on: success
        type: decision
        summary: s
        content: c
`);
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(1);
    const task = mem.writebacks[0]?.req.task as Record<string, unknown>;
    expect(task.taskId).toBe("alpha-workflow:think");
    expect(task.runtime).toBe("workflow");
  });

  test("recall task.taskId is qualified by workflow name", async () => {
    const workflow = parseInline(`
name: beta-workflow
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: stuff
`);
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.recalls).toHaveLength(1);
    const task = mem.recalls[0]?.req.task as Record<string, unknown>;
    expect(task.taskId).toBe("beta-workflow:think");
  });

  test("idempotencyKey is stable across identical content but distinct across nodes", async () => {
    const workflow = parseInline(`
name: idem
description: test
nodes:
  - id: a
    prompt: a-prompt
    memory:
      writeback:
        on: success
        type: decision
        summary: same
        content: same content
  - id: b
    prompt: b-prompt
    memory:
      writeback:
        on: success
        type: decision
        summary: same
        content: same content
`);
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(2);
    const keyA = mem.writebacks[0]?.req.idempotencyKey;
    const keyB = mem.writebacks[1]?.req.idempotencyKey;
    expect(typeof keyA).toBe("string");
    expect(typeof keyB).toBe("string");
    expect(keyA).not.toBe(keyB); // distinct node ids
    expect(keyA).toContain(":a:"); // node id is part of key
    expect(keyB).toContain(":b:");
  });

  test("workflows without memory: never call the memoryTools adapter", async () => {
    const workflow = parseInline(`
name: no-memory
description: test
nodes:
  - id: a
    prompt: hello
`);
    const mem = mockMemory();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.recalls).toHaveLength(0);
    expect(mem.writebacks).toHaveLength(0);
  });

  test("emits memory_recalled and memory_written events on the node_event channel", async () => {
    const workflow = parseInline(`
name: events
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: stuff
      writeback:
        on: success
        type: lesson
        summary: s
        content: c
`);
    const mem = mockMemory({
      recallItems: [{ memoryId: "m1" }],
      recallTraceId: "tr-1",
      writebackWritten: [{ memoryId: "mem-out" }],
    });
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
      onEvent,
    });

    const recalled = events
      .filter((e): e is Extract<RunStreamEvent, { type: "node_event" }> => e.type === "node_event")
      .map((e) => e.event)
      .find((ev) => ev.type === "memory_recalled");
    expect(recalled).toEqual({ type: "memory_recalled", traceId: "tr-1", returned: 1 });

    const written = events
      .filter((e): e is Extract<RunStreamEvent, { type: "node_event" }> => e.type === "node_event")
      .map((e) => e.event)
      .find((ev) => ev.type === "memory_written");
    expect(written).toEqual({ type: "memory_written", memoryId: "mem-out" });
  });

  test("writeback blocked[] surfaces as run_warning, not as a node failure", async () => {
    const workflow = parseInline(`
name: blocked
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      writeback:
        on: success
        type: lesson
        summary: s
        content: c
`);
    const mem = mockMemory({
      writebackWritten: [],
      writebackBlocked: [{ reason: "potential_secret", summary: "s" }],
    });
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
      onEvent,
    });

    expect(summary.status).toBe("succeeded");
    const warning = events.find(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warning?.message).toContain("blocked: potential_secret");
  });

  test("memory: blocks are no-ops when no memoryTools adapter is provided", async () => {
    const workflow = parseInline(`
name: no-adapter
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: anything
      writeback:
        on: success
        type: lesson
        summary: s
        content: c
`);
    const { handler, calls } = echoHandler("prompt");
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      // memoryTools intentionally omitted
    });

    expect(summary.status).toBe("succeeded");
    // $memory.recall.items resolves to "[]" via the "no context" default,
    // confirming the hook short-circuited rather than ran with empty results.
    expect(calls[0]?.resolvedBody).toContain("hello");
  });

  test("writeback templates can reference $memory.recall.items (recall context propagates to writeback)", async () => {
    // Codex-flagged gap: runPostWriteback was resolving summary/content
    // without the per-node memoryRecall context, so a writeback body that
    // referenced the recalled items would substitute against the empty
    // default. Threading memoryRecall through the post-writeback path is
    // load-bearing for "persist what we did with the recalled items"
    // patterns.
    const workflow = parseInline(`
name: recall-into-writeback
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: prior
      writeback:
        on: success
        type: decision
        summary: "saw $memory.recall.trace"
        content: "items: $memory.recall.items"
`);
    const items = [{ memoryId: "m1" }];
    const mem = mockMemory({ recallItems: items, recallTraceId: "rtid-7" });
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(1);
    const draft = (mem.writebacks[0]?.req.memories as Record<string, unknown>[])?.[0];
    expect(draft?.summary).toBe("saw rtid-7");
    expect(draft?.content).toBe(`items: ${JSON.stringify(items)}`);
  });

  test("writeback fires when handler throws and on: always", async () => {
    // Codex-flagged gap: the executor's catch block only synthesized a
    // failed NodeResult without invoking runPostWriteback, so `on: always`
    // missed thrown-handler failures (subprocess crash, abort propagation,
    // custom handler bugs).
    const workflow = parseInline(`
name: throw-always
description: test
nodes:
  - id: doomed
    prompt: please throw
    memory:
      writeback:
        on: always
        type: failure
        summary: "captured failure"
        content: "thrown handler"
`);
    const throwingHandler: NodeHandler = {
      type: "prompt",
      async handle() {
        throw new Error("kaboom");
      },
    };
    const mem = mockMemory();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", throwingHandler]]),
      memoryTools: mem.tools,
    });

    expect(summary.status).toBe("failed");
    expect(mem.writebacks).toHaveLength(1);
    expect((mem.writebacks[0]?.req.memories as Record<string, unknown>[])?.[0]?.summary).toBe(
      "captured failure",
    );
  });

  test("writeback does NOT fire when handler throws and on: success", async () => {
    // The success-gated companion: thrown failures should still be
    // excluded from `on: success` writebacks.
    const workflow = parseInline(`
name: throw-success
description: test
nodes:
  - id: doomed
    prompt: please throw
    memory:
      writeback:
        on: success
        type: lesson
        summary: should not write
        content: should not write
`);
    const throwingHandler: NodeHandler = {
      type: "prompt",
      async handle() {
        throw new Error("kaboom");
      },
    };
    const mem = mockMemory();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", throwingHandler]]),
      memoryTools: mem.tools,
    });

    expect(mem.writebacks).toHaveLength(0);
  });

  test("ctx.memory exposes the adapter so custom handlers can call recall/writeback imperatively", async () => {
    // ctx.memory must surface the same adapter the declarative hooks use, so handlers
    // doing imperative recall/writeback (rib tools, ad-hoc loops) see a wired tools object,
    // not undefined, when RunOptions.memoryTools is set.
    const workflow = parseInline(`
name: ctx-memory-tools
description: test
nodes:
  - id: think
    prompt: hello
`);
    let observed: MemoryTools | undefined;
    const inspectingHandler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        observed = ctx.memory;
        // Exercise the handle end-to-end — a custom handler should be
        // able to recall directly via ctx.memory without going through
        // the declarative memory: block.
        if (ctx.memory) {
          const res = await ctx.memory.recall({ query: "imperative" });
          return {
            status: "succeeded",
            output: { kind: "text", text: `traceId=${res.trace.traceId}` },
          };
        }
        return { status: "succeeded", output: { kind: "text", text: "no adapter" } };
      },
    };
    const mem = mockMemory({ recallTraceId: "imp-trace" });

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", inspectingHandler]]),
      memoryTools: mem.tools,
    });

    expect(observed).toBe(mem.tools);
    expect(mem.recalls).toHaveLength(1);
    expect(summary.nodes.think?.output).toBe("traceId=imp-trace");
  });

  test("ctx.memory is undefined when no memoryTools adapter is wired", async () => {
    const workflow = parseInline(`
name: ctx-memory-absent
description: test
nodes:
  - id: think
    prompt: hello
`);
    let observed: MemoryTools | undefined = "sentinel" as unknown as MemoryTools;
    const inspectingHandler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        observed = ctx.memory;
        return { status: "succeeded", output: { kind: "text", text: "" } };
      },
    };

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", inspectingHandler]]),
      // memoryTools intentionally omitted
    });

    expect(observed).toBeUndefined();
  });

  test("memoryRecall is exposed on NodeContext for handlers that re-substitute", async () => {
    // Codex-flagged gap: handlers re-resolving nested bodies (command file
    // contents, loop.prompt) only got memoryRecall if it was threaded
    // through NodeContext. This test exercises that propagation via a
    // custom handler that reads ctx.memoryRecall directly.
    const workflow = parseInline(`
name: ctx-memory
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: stuff
`);
    let observedItems: unknown[] | undefined;
    let observedTraceId: string | null | undefined;
    const inspectingHandler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        observedItems = ctx.memoryRecall ? [...ctx.memoryRecall.items] : undefined;
        observedTraceId = ctx.memoryRecall?.traceId;
        return { status: "succeeded", output: { kind: "text", text: "" } };
      },
    };
    const items = [{ memoryId: "m1" }, { memoryId: "m2" }];
    const mem = mockMemory({ recallItems: items, recallTraceId: "ctx-trace" });

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", inspectingHandler]]),
      memoryTools: mem.tools,
    });

    expect(observedItems).toEqual(items);
    expect(observedTraceId).toBe("ctx-trace");
  });

  test("loop.prompt per-iteration substitution sees $memory.recall.items", async () => {
    // The loop handler builds iterationPrompt via resolveBody on
    // loop.prompt each iteration. Without forwarding ctx.memoryRecall the
    // declared memory.recall: would silently no-op for loop nodes.
    const workflow = parseInline(`
name: loop-recall
description: test
nodes:
  - id: looper
    loop:
      prompt: |
        Items: $memory.recall.items
        END
      max_iterations: 1
      until: COMPLETE
    memory:
      recall:
        query: stuff
`);
    const promptResolvedBodies: string[] = [];
    const promptHandler: NodeHandler = {
      type: "prompt",
      async handle(_node, ctx) {
        promptResolvedBodies.push(ctx.resolvedBody);
        // Emit COMPLETE so the loop stops cleanly after iteration 1.
        return { status: "succeeded", output: { kind: "text", text: "COMPLETE" } };
      },
    };
    const items = [{ memoryId: "m-loop" }];
    const mem = mockMemory({ recallItems: items });

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([
        ["prompt", promptHandler],
        ["loop", makeLoopHandler({ promptHandler })],
      ]),
      memoryTools: mem.tools,
    });

    expect(summary.status).toBe("succeeded");
    expect(promptResolvedBodies).toHaveLength(1);
    expect(promptResolvedBodies[0]).toContain(JSON.stringify(items));
  });
});

// ---------------------------------------------------------------------------
// notebook: block
// ---------------------------------------------------------------------------

interface NotebookAppendRecord {
  entry: string;
  section?: string;
}

function mockNotebook(opts: { full?: boolean; appendThrows?: boolean } = {}): {
  notebook: NotebookAdapter;
  appends: NotebookAppendRecord[];
} {
  const appends: NotebookAppendRecord[] = [];
  const notebook: NotebookAdapter = {
    read: () => undefined,
    append(entry, section) {
      appends.push(section !== undefined ? { entry, section } : { entry });
      if (opts.appendThrows) throw new Error("notebook adapter blew up");
      return { ok: !opts.full };
    },
  };
  return { notebook, appends };
}

describe("runWorkflow — notebook: block", () => {
  test("append fires after node success and resolves $node.output", async () => {
    const workflow = parseInline(`
name: nb-success
description: test
nodes:
  - id: think
    prompt: do the thing
    notebook:
      append: "result: $think.output"
      section: Workflow Log
`);
    const nb = mockNotebook();
    const { handler } = echoHandler("prompt");

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      notebook: nb.notebook,
    });

    expect(summary.status).toBe("succeeded");
    expect(nb.appends).toHaveLength(1);
    expect(nb.appends[0]?.entry).toBe("result: echo:think:do the thing");
    expect(nb.appends[0]?.section).toBe("Workflow Log");
  });

  test("on defaults to success — no append after node failure", async () => {
    const workflow = parseInline(`
name: nb-default
description: test
nodes:
  - id: fail
    prompt: doomed
    notebook:
      append: should not write
`);
    const nb = mockNotebook();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", failingHandler("prompt", "kaboom")]]),
      notebook: nb.notebook,
    });

    expect(nb.appends).toHaveLength(0);
  });

  test("on: always appends even after node failure (incl. a thrown handler)", async () => {
    const workflow = parseInline(`
name: nb-always
description: test
nodes:
  - id: doomed
    prompt: please throw
    notebook:
      append: failure note
      on: always
`);
    const throwingHandler: NodeHandler = {
      type: "prompt",
      async handle() {
        throw new Error("kaboom");
      },
    };
    const nb = mockNotebook();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", throwingHandler]]),
      notebook: nb.notebook,
    });

    expect(summary.status).toBe("failed");
    expect(nb.appends).toHaveLength(1);
    expect(nb.appends[0]?.entry).toBe("failure note");
  });

  test("emits a notebook_written event on the node_event channel", async () => {
    const workflow = parseInline(`
name: nb-event
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: note
      section: Decisions
`);
    const nb = mockNotebook();
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      notebook: nb.notebook,
      onEvent,
    });

    const written = events
      .filter((e): e is Extract<RunStreamEvent, { type: "node_event" }> => e.type === "node_event")
      .map((e) => e.event)
      .find((ev) => ev.type === "notebook_written");
    expect(written).toEqual({ type: "notebook_written", section: "Decisions" });
  });

  test("a full notebook warns and the node still succeeds", async () => {
    const workflow = parseInline(`
name: nb-full
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: note
`);
    const nb = mockNotebook({ full: true });
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      notebook: nb.notebook,
      onEvent,
    });

    expect(summary.status).toBe("succeeded");
    expect(nb.appends).toHaveLength(1);
    const warning = events.find(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warning?.message).toContain("notebook");
    expect(warning?.message).toContain("full");
  });

  test("a throwing append adapter warns and the node still succeeds", async () => {
    const workflow = parseInline(`
name: nb-throw
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: note
`);
    const nb = mockNotebook({ appendThrows: true });
    const { handler } = echoHandler("prompt");
    const { events, onEvent } = recordEvents();

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      notebook: nb.notebook,
      onEvent,
    });

    expect(summary.status).toBe("succeeded");
    const warning = events.find(
      (e): e is Extract<RunStreamEvent, { type: "run_warning" }> => e.type === "run_warning",
    );
    expect(warning?.message).toContain("notebook append failed");
  });

  test("notebook: blocks are no-ops when no notebook adapter is wired", async () => {
    const workflow = parseInline(`
name: nb-no-adapter
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: note
`);
    const { handler } = echoHandler("prompt");

    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      // notebook intentionally omitted
    });

    expect(summary.status).toBe("succeeded");
  });

  test("workflows without notebook: never call the adapter", async () => {
    const workflow = parseInline(`
name: nb-none
description: test
nodes:
  - id: think
    prompt: hello
`);
    const nb = mockNotebook();
    const { handler } = echoHandler("prompt");

    await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["prompt", handler]]),
      notebook: nb.notebook,
    });

    expect(nb.appends).toHaveLength(0);
  });
});

describe("resolveBody — structured $nodeId.output addressing", () => {
  const structured = (value: unknown): NodeOutput => ({
    state: "completed",
    output: JSON.stringify(value),
  });

  test("object and array sections JSON-encode for a downstream body", () => {
    const outputs = new Map<string, NodeOutput>([
      ["collect", structured({ nodes: [{ id: "a" }], tags: ["x", "y"] })],
    ]);
    expect(resolveBody("g=$collect.output.nodes", {}, outputs)).toBe('g=[{"id":"a"}]');
    expect(resolveBody("t=$collect.output.tags", {}, outputs)).toBe('t=["x","y"]');
  });

  test("scalars stay plain; null renders as null; absent field stays empty", () => {
    const outputs = new Map<string, NodeOutput>([
      ["c", structured({ count: 2, name: "topo", flag: null })],
    ]);
    expect(resolveBody("n=$c.output.count name=$c.output.name", {}, outputs)).toBe("n=2 name=topo");
    expect(resolveBody("f=$c.output.flag x=$c.output.missing", {}, outputs)).toBe("f=null x=");
  });

  test("whole $nodeId.output returns the raw JSON string", () => {
    const value = { nodes: [], edges: [] };
    const outputs = new Map<string, NodeOutput>([["c", structured(value)]]);
    expect(resolveBody("$c.output", {}, outputs)).toBe(JSON.stringify(value));
  });

  test("non-JSON output with a field ref resolves to empty", () => {
    const outputs = new Map<string, NodeOutput>([["c", { state: "completed", output: "plain" }]]);
    expect(resolveBody("v=$c.output.field", {}, outputs)).toBe("v=");
  });

  test("prototype-named fields are treated as missing (own-property only)", () => {
    const outputs = new Map<string, NodeOutput>([["c", structured({ a: 1 })]]);
    expect(resolveBody("p=$c.output.__proto__ k=$c.output.constructor", {}, outputs)).toBe("p= k=");
    // an own property literally named __proto__ still resolves
    const own = new Map<string, NodeOutput>([
      ["c", { state: "completed", output: '{"__proto__":5}' }],
    ]);
    expect(resolveBody("v=$c.output.__proto__", {}, own)).toBe("v=5");
  });

  test("$converge.round resolves only when a converge round is present", () => {
    expect(resolveBody("round=$converge.round", {}, new Map(), { convergeRound: 2 })).toBe(
      "round=2",
    );
    expect(resolveBody("round=$converge.round", {}, new Map())).toBe("round=");
  });
});

describe("runWorkflow — output_schema validation (fail-closed)", () => {
  function structuredHandler(value: unknown, type = "prompt"): NodeHandler {
    return {
      type,
      async handle() {
        return { status: "succeeded", output: { kind: "structured", value } };
      },
    };
  }

  const graphWorkflow = () =>
    parseInline(`
name: t
description: test
nodes:
  - id: produce
    prompt: "make a graph"
    output_schema:
      type: object
      required: [nodes, edges]
      properties:
        nodes: { type: array }
        edges: { type: array }
`);

  test("valid structured output passes and records completed", async () => {
    const summary = await runWorkflow({
      ...baseOpts(graphWorkflow()),
      handlers: new Map([["prompt", structuredHandler({ nodes: [], edges: [] })]]),
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.produce.state).toBe("completed");
  });

  test("malformed structured output fails closed with a schema error + run_warning", async () => {
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(graphWorkflow()),
      handlers: new Map([["prompt", structuredHandler({ nodes: [] })]]),
      onEvent,
    });
    expect(summary.status).toBe("failed");
    const produce = summary.nodes.produce;
    expect(produce.state).toBe("failed");
    if (produce.state === "failed") {
      expect(produce.error).toContain("output_schema validation failed");
      expect(produce.error).toContain("missing required property 'edges'");
    }
    const warned = events.some(
      (e) => e.type === "run_warning" && e.message.includes("output_schema validation failed"),
    );
    expect(warned).toBe(true);
  });

  test("structured value with a nested undefined required key fails after serialization", async () => {
    // edges:undefined passes a live-object presence check but JSON.stringify
    // drops it, so bodyToSchemaOutput records {"nodes":[]} and downstream
    // $produce.output.edges is empty — validation must agree and fail closed.
    const summary = await runWorkflow({
      ...baseOpts(graphWorkflow()),
      handlers: new Map([["prompt", structuredHandler({ nodes: [], edges: undefined })]]),
    });
    const produce = summary.nodes.produce;
    expect(produce.state).toBe("failed");
    if (produce.state === "failed") {
      expect(produce.error).toContain("missing required property 'edges'");
    }
  });

  test("text output that JSON-parses is validated as structured", async () => {
    const wf = parseInline(`
name: t
description: test
nodes:
  - id: produce
    bash: echo json
    output_schema:
      type: object
      required: [k]
`);
    const ok = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", cannedHandler({ produce: '{"k":1}' }, "bash")]]),
    });
    expect(ok.nodes.produce.state).toBe("completed");

    const bad = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", cannedHandler({ produce: "not json" }, "bash")]]),
    });
    expect(bad.nodes.produce.state).toBe("failed");
  });

  test("text output with output_schema is upgraded to a structured node_done (drives the snapshot publish bridge)", async () => {
    const wf = parseInline(`
name: t
description: test
nodes:
  - id: produce
    bash: echo json
    output_schema:
      type: object
      required: [nodes, edges]
`);
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([
        ["bash", cannedHandler({ produce: '{"nodes":[{"id":"a"}],"edges":[]}' }, "bash")],
      ]),
      onEvent,
    });
    expect(summary.nodes.produce.state).toBe("completed");
    const done = events.find((e) => e.type === "node_done" && e.nodeId === "produce");
    expect(done?.type).toBe("node_done");
    if (done?.type === "node_done") {
      expect(done.result.output.kind).toBe("structured");
      if (done.result.output.kind === "structured") {
        expect(done.result.output.value).toEqual({ nodes: [{ id: "a" }], edges: [] });
      }
    }
  });

  test("the structured upgrade is gated on output_schema — JSON stdout without a schema stays text", async () => {
    const wf = parseInline(`
name: t
description: test
nodes:
  - id: produce
    bash: echo json
`);
    const { events, onEvent } = recordEvents();
    await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", cannedHandler({ produce: '{"k":1}' }, "bash")]]),
      onEvent,
    });
    const done = events.find((e) => e.type === "node_done" && e.nodeId === "produce");
    expect(done?.type).toBe("node_done");
    if (done?.type === "node_done") {
      expect(done.result.output.kind).toBe("text");
    }
  });
});

describe("runWorkflow — node usage survives executor rewraps", () => {
  test("output_schema text→structured promotion keeps result.usage on node_done", async () => {
    const wf = parseInline(`
name: t
description: test
nodes:
  - id: produce
    prompt: "emit json"
    output_schema:
      type: object
      required: [k]
`);
    const usage = { inputTokens: 99, outputTokens: 11 };
    const handler: NodeHandler = {
      type: "prompt",
      async handle() {
        return { status: "succeeded", output: { kind: "text", text: '{"k":1}' }, usage };
      },
    };
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["prompt", handler]]),
      onEvent,
    });
    expect(summary.nodes.produce.state).toBe("completed");
    const done = events.find((e) => e.type === "node_done" && e.nodeId === "produce");
    expect(done).toBeDefined();
    if (done && done.type === "node_done") {
      expect(done.result.output.kind).toBe("structured");
      expect(done.result.usage).toEqual(usage);
    }
  });

  test("output_schema validation failure keeps result.usage — the failed turn still spent tokens", async () => {
    const wf = parseInline(`
name: t
description: test
nodes:
  - id: produce
    prompt: "emit json"
    output_schema:
      type: object
      required: [missing_key]
`);
    const usage = { inputTokens: 7, outputTokens: 3 };
    const handler: NodeHandler = {
      type: "prompt",
      async handle() {
        return { status: "succeeded", output: { kind: "text", text: '{"k":1}' }, usage };
      },
    };
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["prompt", handler]]),
      onEvent,
    });
    expect(summary.nodes.produce.state).toBe("failed");
    const done = events.find((e) => e.type === "node_done" && e.nodeId === "produce");
    if (done && done.type === "node_done") {
      expect(done.result.status).toBe("failed");
      expect(done.result.usage).toEqual(usage);
    }
  });
});

describe("runWorkflow — re-entry with completedNodeOutputs", () => {
  test("seeded upstream node's handler is NOT called, downstream node sees seeded output", async () => {
    const wf = parseInline(`
name: resume-test
description: test
nodes:
  - id: upstream
    bash: "echo upstream"
  - id: downstream
    bash: "echo $upstream.output"
    depends_on: [upstream]
`);
    const upstreamOutput = "upstream-result";
    const { handler: bash, calls } = echoHandler("bash");
    const completedNodeOutputs = new Map<string, NodeOutput>([
      [
        "upstream",
        {
          state: "completed",
          output: upstreamOutput,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 100,
        },
      ],
    ]);
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", bash]]),
      completedNodeOutputs,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.upstream.output).toBe(upstreamOutput);
    expect(summary.nodes.downstream.state).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("downstream");
    expect(calls[0].resolvedBody).toContain(upstreamOutput);
  });

  test("seeded node with downstream when: condition sees seeded output", async () => {
    const wf = parseInline(`
name: resume-test-when
description: test
nodes:
  - id: classify
    bash: "echo FEATURE"
  - id: label-feature
    bash: "label feature"
    depends_on: [classify]
    when: $classify.output == 'FEATURE'
`);
    const classifyOutput = "FEATURE";
    const { handler: bash, calls } = echoHandler("bash");
    const completedNodeOutputs = new Map<string, NodeOutput>([
      [
        "classify",
        {
          state: "completed",
          output: classifyOutput,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 50,
        },
      ],
    ]);
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", bash]]),
      completedNodeOutputs,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes["label-feature"].state).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("label-feature");
  });

  test("skipped seeded node is preserved", async () => {
    const wf = parseInline(`
name: resume-skipped
description: test
nodes:
  - id: n1
    bash: "echo n1"
  - id: n2
    bash: "echo n2"
`);
    const { handler: bash, calls } = echoHandler("bash");
    const completedNodeOutputs = new Map<string, NodeOutput>([
      ["n1", { state: "skipped", output: "" }],
    ]);
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", bash]]),
      completedNodeOutputs,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.n1.state).toBe("skipped");
    expect(summary.nodes.n2.state).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("n2");
  });

  test("a non-terminal seeded state (running) is ignored — the node still runs", async () => {
    const wf = parseInline(`
name: resume-bad-seed
description: test
nodes:
  - id: n1
    bash: "echo n1"
`);
    const { handler: bash, calls } = echoHandler("bash");
    // Only completed/skipped seeds suppress a node; a running/failed seed must not.
    const completedNodeOutputs = new Map<string, NodeOutput>([
      ["n1", { state: "running", output: "partial" }],
    ]);
    const summary = await runWorkflow({
      ...baseOpts(wf),
      handlers: new Map([["bash", bash]]),
      completedNodeOutputs,
    });
    expect(summary.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("n1");
  });
});

describe("runWorkflow — node retry", () => {
  const wf = (retry: string): WorkflowDefinition =>
    parseInline(
      `name: r\ndescription: |\n  Use when: t\nnodes:\n  - id: work\n    bash: echo hi\n${retry}`,
    );

  test("re-runs a transient failure and the node succeeds", async () => {
    const workflow = wf("    retry:\n      max_attempts: 2\n      delay_ms: 1000\n");
    const { handler, attempts } = flakyHandler("bash", {
      failTimes: 1,
      error: "network error: ETIMEDOUT",
    });
    const { events, onEvent } = recordEvents();
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      onEvent,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.nodes.work.state).toBe("completed");
    expect(attempts()).toBe(2); // 1 transient fail + 1 success
    expect(events.some((e) => e.type === "run_warning" && /retry 1\/2/.test(e.message))).toBe(true);
  });

  test("on_error transient does NOT retry a non-transient failure", async () => {
    const workflow = wf("    retry:\n      max_attempts: 3\n      delay_ms: 1000\n");
    const { handler, attempts } = flakyHandler("bash", {
      failTimes: 5,
      error: "permission denied",
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
    });
    expect(summary.status).toBe("failed");
    expect(attempts()).toBe(1);
  });

  test("on_error all retries a non-transient failure", async () => {
    const workflow = wf(
      "    retry:\n      max_attempts: 1\n      delay_ms: 1000\n      on_error: all\n",
    );
    const { handler, attempts } = flakyHandler("bash", {
      failTimes: 1,
      error: "permission denied",
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
    });
    expect(summary.status).toBe("succeeded");
    expect(attempts()).toBe(2);
  });

  test("a persistent transient failure fails after exhausting retries", async () => {
    const workflow = wf("    retry:\n      max_attempts: 1\n      delay_ms: 1000\n");
    const { handler, attempts } = flakyHandler("bash", {
      failTimes: 5,
      error: "rate limit exceeded (429)",
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
    });
    expect(summary.status).toBe("failed");
    expect(attempts()).toBe(2); // initial + 1 retry, both fail
  });

  test("a user cancel is never retried, even with on_error all", async () => {
    const workflow = wf(
      "    retry:\n      max_attempts: 3\n      delay_ms: 1000\n      on_error: all\n",
    );
    const controller = new AbortController();
    const { handler, attempts } = flakyHandler("bash", {
      failTimes: 5,
      error: "aborted",
      abortOnFirstCall: controller,
    });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      abortSignal: controller.signal,
    });
    expect(attempts()).toBe(1); // aborted mid-turn → no retry
    expect(summary.status).not.toBe("succeeded");
  });

  test("a cancel during the retry backoff is not followed by another handler call", async () => {
    const workflow = wf(
      "    retry:\n      max_attempts: 3\n      delay_ms: 1000\n      on_error: all\n",
    );
    const controller = new AbortController();
    // Would retry forever, but the cancel lands during the first backoff wait.
    const { handler, attempts } = flakyHandler("bash", { failTimes: 99, error: "network error" });
    setTimeout(() => controller.abort(), 100);
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
      abortSignal: controller.signal,
    });
    expect(attempts()).toBe(1); // cancelled mid-backoff → handler not called again
    expect(summary.status).not.toBe("succeeded");
  });

  test("without a retry config a failure is not retried (opt-in)", async () => {
    const workflow = wf("");
    const { handler, attempts } = flakyHandler("bash", { failTimes: 5, error: "network error" });
    const summary = await runWorkflow({
      ...baseOpts(workflow),
      handlers: new Map([["bash", handler]]),
    });
    expect(summary.status).toBe("failed");
    expect(attempts()).toBe(1);
  });
});

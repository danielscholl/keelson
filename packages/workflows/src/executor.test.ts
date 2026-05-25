// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutorValidationError,
  type NodeHandler,
  type RunOptions,
  type RunStreamEvent,
  runWorkflow,
} from "./executor.ts";
import { makeApprovalHandler } from "./handlers/approval.ts";
import { parseWorkflow } from "./loader.ts";
import type { DagNode, WorkflowDefinition } from "./schema/index.ts";

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

function recordEvents(): { events: RunStreamEvent[]; onEvent: (e: RunStreamEvent) => void } {
  const events: RunStreamEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function loadStarter(name: string): WorkflowDefinition {
  const root = join(import.meta.dir, "..", "..", "..", ".keelson", "workflows", `${name}.yaml`);
  const yaml = readFileSync(root, "utf-8");
  const result = parseWorkflow(yaml, root);
  if (result.error) throw new Error(`fixture load failed: ${result.error.error}`);
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
    // W1 contract: all substitutions are raw. $X.output is treated the same as
    // $ARGUMENTS and $inputs.foo for bash. Author must wrap in single quotes
    // in the YAML (e.g. `bash: "echo '$X.output'"`) to defang upstream output.
    // Safer interpolation against hostile output (env / argv) is a W2 concern;
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
    // unhandled rejection. W2-style consumers using onEvent for SQLite
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

// ---------------------------------------------------------------------------
// smoke-test (every CI-compatible node type)
// ---------------------------------------------------------------------------

import { bashHandler } from "./handlers/bash.ts";
import { makeCommandHandler } from "./handlers/command.ts";
import { makeLoopHandler } from "./handlers/loop.ts";
import { makeScriptHandler } from "./handlers/script.ts";

async function uvOnPath(): Promise<boolean> {
  try {
    const p = Bun.spawn(["uv", "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

const UV_PRESENT = await uvOnPath();

// The smoke YAML uses a `script-python-node` (runtime: uv). Skip the full
// run when uv is missing — the discovery + handler tests already cover the
// uv-not-on-PATH path with a clear error.
describe.if(UV_PRESENT)("runWorkflow — smoke-test (every node type)", () => {
  test("all 10 active nodes succeed and the final assert prints PASS", async () => {
    const workflow = loadStarter("smoke-test");

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

    const cwd = join(import.meta.dir, "..", "..", "..");
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

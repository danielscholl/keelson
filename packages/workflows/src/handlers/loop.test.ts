// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { NodeContext, NodeHandler, NodeResult } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";
import { makeLoopHandler } from "./loop.ts";

interface SeenPrompt {
  prompt: string;
  resolvedBody: string;
  nodeId: string;
}

function makeRecorderHandler(responder: (call: SeenPrompt, callIndex: number) => NodeResult): {
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

function buildCtx(
  opts: { abortSignal?: AbortSignal; workflowInteractive?: boolean } = {},
): NodeContext {
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
    // Default to interactive: true so the existing pause/resume tests (which
    // were written before the workflow-level gate landed) keep exercising
    // the pause path. Tests that need to exercise the autonomous-workflow
    // rejection path opt in via `workflowInteractive: false`.
    workflow: {
      name: "t",
      description: "",
      nodes: [],
      interactive: opts.workflowInteractive ?? true,
    } as unknown as WorkflowDefinition,
  };
}

function loopNode(
  overrides: Partial<{ max_iterations: number; until: string; interactive: boolean }>,
) {
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

describe("makeLoopHandler — interactive/until_bash wiring required", () => {
  test("interactive: true with no awaitInteraction wired fails fast", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "should not run" },
    }));
    const handler = makeLoopHandler({ promptHandler });
    const result = await handler.handle(loopNode({ interactive: true }), buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("interactive loops require server-side pause wiring");
    expect(seen).toHaveLength(0);
  });

  test("interactive: true in an autonomous workflow (interactive !== true) fails fast", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "should not run" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      awaitInteraction: async () => "ignored",
    });
    const result = await handler.handle(
      loopNode({ interactive: true }),
      buildCtx({ workflowInteractive: false }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("workflow-level 'interactive: true'");
    expect(seen).toHaveLength(0);
  });

  test("until_bash with no probe runner wired fails fast", async () => {
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
    expect(result.error).toContain("server-side probe wiring");
    expect(seen).toHaveLength(0);
  });
});

describe("makeLoopHandler — loop marker substitution is single-pass", () => {
  test("prev iteration output containing literal $LOOP_USER_INPUT is NOT re-substituted", async () => {
    // Regression: a previous iteration may emit text that mentions
    // `$LOOP_USER_INPUT` (e.g. quoting the prompt back to the user). The
    // second iteration's prompt resolution must NOT see that token and
    // replace it with the (empty) user-input value — that would corrupt
    // the prior output as it flows into $LOOP_PREV_OUTPUT.
    const literalToken = "the literal token is $LOOP_USER_INPUT";
    const { handler: promptHandler, seen } = makeRecorderHandler((_, i) =>
      i === 0
        ? { status: "succeeded", output: { kind: "text", text: literalToken } }
        : { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } },
    );
    const handler = makeLoopHandler({ promptHandler });
    const node = {
      id: "summarize",
      loop: {
        prompt: "prev=[$LOOP_PREV_OUTPUT] user=[$LOOP_USER_INPUT]",
        until: "DONE",
        max_iterations: 3,
        fresh_context: false,
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    await handler.handle(node, buildCtx());
    expect(seen).toHaveLength(2);
    // Iter 2's prompt sees iter 1's full output verbatim — including the
    // literal $LOOP_USER_INPUT token — and substitutes the user-input slot
    // separately (empty here, non-interactive loop).
    expect(seen[1].prompt).toBe(`prev=[${literalToken}] user=[]`);
  });

  test("token-prefix lookalikes are not greedily matched (upper/lower/digit suffixes)", async () => {
    // `$LOOP_PREV_OUTPUT_TAIL`, `$LOOP_USER_INPUTfoo`, `$LOOP_USER_INPUT9`
    // are all longer identifiers that share the marker prefix. The boundary
    // anchor must stop the match before the substitution; otherwise the
    // suffix gets stranded as literal text glued to the substituted value.
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "<promise>DONE</promise>" },
    }));
    const handler = makeLoopHandler({ promptHandler });
    const literalLine = "$LOOP_PREV_OUTPUT_TAIL $LOOP_USER_INPUTfoo $LOOP_USER_INPUT9 keep";
    const node = {
      id: "summarize",
      loop: {
        prompt: literalLine,
        until: "DONE",
        max_iterations: 1,
        fresh_context: false,
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    await handler.handle(node, buildCtx());
    expect(seen[0].prompt).toBe(literalLine);
  });
});

describe("makeLoopHandler — interactive loops", () => {
  test("pauses between iterations and threads the user's reply into $LOOP_USER_INPUT", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler((_, i) => {
      if (i === 0) {
        return { status: "succeeded", output: { kind: "text", text: "first turn output" } };
      }
      if (i === 1) {
        return { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } };
      }
      return { status: "succeeded", output: { kind: "text", text: "should not reach" } };
    });
    const awaitCalls: Array<{
      runId: string;
      nodeId: string;
      message: string;
      iteration: number;
    }> = [];
    const handler = makeLoopHandler({
      promptHandler,
      awaitInteraction: async (runId, nodeId, message, iteration) => {
        awaitCalls.push({ runId, nodeId, message, iteration });
        return "user said: keep going";
      },
    });
    const node = {
      id: "explore",
      loop: {
        prompt: "step | prev=$LOOP_PREV_OUTPUT | user=$LOOP_USER_INPUT",
        until: "DONE",
        max_iterations: 5,
        fresh_context: false,
        interactive: true,
        gate_message: "answer or say done",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    expect(seen[0].prompt).toBe("step | prev= | user=");
    expect(seen[1].prompt).toBe("step | prev=first turn output | user=user said: keep going");
    expect(awaitCalls).toHaveLength(1);
    expect(awaitCalls[0].iteration).toBe(1);
    expect(awaitCalls[0].message).toBe("answer or say done");
  });

  test("does not pause after the final iteration when max_iterations is hit", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "still working" },
    }));
    let pauseCalls = 0;
    const handler = makeLoopHandler({
      promptHandler,
      awaitInteraction: async () => {
        pauseCalls++;
        return "go";
      },
    });
    const node = {
      id: "explore",
      loop: {
        prompt: "step",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        interactive: true,
        gate_message: "answer",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    // One pause between iter 1 and iter 2; no pause after iter 2 (final).
    expect(pauseCalls).toBe(1);
  });

  test("resolves $ARGUMENTS in gate_message before pausing", async () => {
    const { handler: promptHandler } = makeRecorderHandler((_, i) =>
      i === 0
        ? { status: "succeeded", output: { kind: "text", text: "still working" } }
        : { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } },
    );
    const gates: string[] = [];
    const handler = makeLoopHandler({
      promptHandler,
      awaitInteraction: async (_runId, _nodeId, message) => {
        gates.push(message);
        return "";
      },
    });
    const node = {
      id: "explore",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 3,
        fresh_context: false,
        interactive: true,
        gate_message: "user said: $ARGUMENTS",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const ctx = { ...buildCtx(), inputs: { ARGUMENTS: "hello world" } };
    await handler.handle(node, ctx);
    expect(gates).toEqual(["user said: hello world"]);
  });

  test("aborted pause returns a failed result with 'aborted' error", async () => {
    const ac = new AbortController();
    const { handler: promptHandler } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "still working" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      awaitInteraction: async () => {
        ac.abort();
        throw new Error("aborted");
      },
    });
    const node = {
      id: "explore",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 3,
        fresh_context: false,
        interactive: true,
        gate_message: "answer",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx({ abortSignal: ac.signal }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });
});

describe("makeLoopHandler — until_bash probe", () => {
  test("exit 0 ends the loop on a SUCCESS with the stripped output", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "iteration result" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "do work",
        until: "DONE",
        max_iterations: 5,
        fresh_context: false,
        until_bash: "test -f /tmp/done",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ kind: "text", text: "iteration result" });
    expect(seen).toHaveLength(1);
  });

  test("non-zero exit keeps iterating", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "step" },
    }));
    let probeCalls = 0;
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => {
        probeCalls++;
        // Always fail — let max_iterations cap the loop.
        return { exitCode: 1, stdout: "", stderr: "still failing" };
      },
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "do work",
        until: "DONE",
        max_iterations: 3,
        fresh_context: false,
        until_bash: "false",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(3);
    expect(probeCalls).toBe(3);
  });

  test("timeout (timedOut: true with non-zero exit) keeps iterating", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "step" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => ({
        exitCode: 124,
        stdout: "",
        stderr: "timeout",
        timedOut: true,
      }),
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "do work",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        until_bash: "sleep 99",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
  });

  test("aborted probe (aborted: true with exit code 0) returns failed, not succeeded", async () => {
    // Regression: a probe that traps SIGTERM and exits 0 AFTER the run
    // was cancelled must not be misread as a successful completion. The
    // abort propagates via the result's `aborted` flag (and ctx's signal
    // — checked independently as belt-and-suspenders).
    const { handler: promptHandler } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "step" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        aborted: true,
      }),
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "do work",
        until: "DONE",
        max_iterations: 5,
        fresh_context: false,
        until_bash: "trap '' TERM; sleep 99",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("aborted");
  });

  test("timeout (timedOut: true with exit code 0) still keeps iterating", async () => {
    // Regression: a probe that traps SIGTERM and exits 0 after the
    // timeout signal would otherwise be misread as a successful
    // completion. Treat the timeout as authoritative.
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "step" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "do work",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        until_bash: "trap '' TERM; sleep 99",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, buildCtx());
    // 2 iterations cap → succeeded with the last stripped output; the
    // probe's exitCode 0 must NOT short-circuit iteration 1.
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
  });

  test("probe receives the script body verbatim — no substitution into the shell source", async () => {
    const { handler: promptHandler } = makeRecorderHandler((_, i) =>
      i === 0
        ? { status: "succeeded", output: { kind: "text", text: "first" } }
        : { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } },
    );
    const seenScripts: string[] = [];
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async (script) => {
        seenScripts.push(script);
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    const rawScript = "echo prev=$LOOP_PREV_OUTPUT args=$ARGUMENTS";
    const node = {
      id: "retry",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        until_bash: rawScript,
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const ctx = { ...buildCtx(), inputs: { ARGUMENTS: "hello" } };
    await handler.handle(node, ctx);
    // Script body MUST be passed unmodified — variable resolution happens
    // shell-side via the env channel. Anything else would let model output
    // containing `$(...)` execute on the next probe.
    expect(seenScripts[0]).toBe(rawScript);
  });

  test("probe env channel carries loop + workflow + artifactsDir vars; not script-substituted", async () => {
    const { handler: promptHandler } = makeRecorderHandler((_, i) =>
      i === 0
        ? { status: "succeeded", output: { kind: "text", text: "iter1-result" } }
        : { status: "succeeded", output: { kind: "text", text: "<promise>DONE</promise>" } },
    );
    interface ProbeCall {
      script: string;
      env: Readonly<Record<string, string>> | undefined;
      inputs: Readonly<Record<string, string>>;
      artifactsDir: string | undefined;
    }
    const calls: ProbeCall[] = [];
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async (script, opts) => {
        calls.push({
          script,
          env: opts.env,
          inputs: opts.inputs,
          artifactsDir: opts.artifactsDir,
        });
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        until_bash: "test -f sentinel",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const ctx = {
      ...buildCtx(),
      inputs: { ARGUMENTS: "hello", lane: "stable" },
      artifactsDir: "/tmp/run-artifacts",
    };
    await handler.handle(node, ctx);
    // First probe fires after iter 1 — LOOP_PREV_OUTPUT empty (no prior
    // iteration), LOOP_USER_INPUT empty (no interactive resume).
    expect(calls[0].env?.LOOP_PREV_OUTPUT).toBe("");
    expect(calls[0].env?.LOOP_USER_INPUT).toBe("");
    expect(calls[0].inputs.ARGUMENTS).toBe("hello");
    expect(calls[0].inputs.lane).toBe("stable");
    expect(calls[0].artifactsDir).toBe("/tmp/run-artifacts");
    // Script body untouched.
    expect(calls[0].script).toBe("test -f sentinel");
  });

  test("hostile prior-iteration output is NOT executed as command substitution in the script", async () => {
    // Regression: prior model output containing `$(touch …)` must reach the
    // probe as literal text via the env channel, not be concatenated into
    // the script source. Sentinel filesystem effect would fire if the body
    // were executed.
    const sentinelPath = "/tmp/__keelson_until_bash_injection_canary__";
    // Best-effort cleanup before the test in case a prior run leaked.
    try {
      await Bun.$`rm -f ${sentinelPath}`.quiet();
    } catch {
      // best-effort
    }
    const hostileOutput = `bad $(touch ${sentinelPath})`;
    const { handler: promptHandler } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: hostileOutput },
    }));
    const probeEnvPrevs: (string | undefined)[] = [];
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async (_script, opts) => {
        probeEnvPrevs.push(opts.env?.LOOP_PREV_OUTPUT);
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    const node = {
      id: "retry",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 3,
        fresh_context: false,
        until_bash: 'echo "$LOOP_PREV_OUTPUT"',
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    await handler.handle(node, buildCtx());
    // Probe fires after each iteration; iter 1's probe sees empty
    // LOOP_PREV_OUTPUT (no prior iteration), iter 2+'s probe receives the
    // hostile output VERBATIM via env — not executed as command
    // substitution into the script.
    expect(probeEnvPrevs[0]).toBe("");
    expect(probeEnvPrevs[1]).toBe(hostileOutput);
    expect(probeEnvPrevs[2]).toBe(hostileOutput);
    const canaryExists = await Bun.file(sentinelPath)
      .exists()
      .catch(() => false);
    expect(canaryExists).toBe(false);
  });

  test("probe runner throws — surfaces a warning and keeps iterating", async () => {
    const { handler: promptHandler, seen } = makeRecorderHandler(() => ({
      status: "succeeded",
      output: { kind: "text", text: "step" },
    }));
    const handler = makeLoopHandler({
      promptHandler,
      runUntilBashProbe: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    const warnings: string[] = [];
    const ctx: NodeContext = {
      ...buildCtx(),
      emit: (e) => {
        if (e.type === "node_warning") warnings.push(e.message);
      },
    };
    const node = {
      id: "retry",
      loop: {
        prompt: "go",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
        until_bash: "bogus",
      },
    } as unknown as Parameters<typeof handler.handle>[0];
    const result = await handler.handle(node, ctx);
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    expect(warnings.some((w) => w.includes("spawn ENOENT"))).toBe(true);
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

describe("makeLoopHandler — output_format is filtered from iteration prompts", () => {
  test("synthesized iteration node does NOT carry output_format from the loop node", async () => {
    // Forcing JSON-only replies would mask the plain-text `until` signal the
    // loop relies on for completion detection.
    const seenNodes: Array<Record<string, unknown>> = [];
    const promptHandler: NodeHandler = {
      type: "prompt",
      async handle(node): Promise<NodeResult> {
        seenNodes.push(node as Record<string, unknown>);
        return { status: "succeeded", output: { kind: "text", text: "DONE" } };
      },
    };
    const node = {
      id: "summarize",
      model: "claude-sonnet-4-6",
      output_format: {
        type: "object",
        required: ["kind"],
        properties: { kind: { type: "string" } },
      },
      loop: {
        prompt: "do work: $LOOP_PREV_OUTPUT",
        until: "DONE",
        max_iterations: 2,
        fresh_context: false,
      },
    } as unknown as DagNode;
    const handler = makeLoopHandler({ promptHandler });
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(seenNodes).toHaveLength(1);
    expect("output_format" in seenNodes[0]).toBe(false);
    // The model field should still come through — only output_format is filtered.
    expect(seenNodes[0].model).toBe("claude-sonnet-4-6");
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
        prompt: "args=$ARGUMENTS lane=$inputs.lane prior=$producer.output prev=$LOOP_PREV_OUTPUT",
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
    expect(seen[0].prompt).toBe("args=u-msg lane=stable prior=upstream-text prev=");
  });
});

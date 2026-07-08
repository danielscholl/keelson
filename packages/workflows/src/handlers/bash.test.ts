// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { NodeContext, NodeStreamEvent } from "../executor.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "../schema/index.ts";
import { bashHandler, makeBashHandler } from "./bash.ts";

interface BuildCtxOptions {
  resolvedBody: string;
  inputs?: Record<string, string>;
  upstream?: Map<string, NodeOutput>;
  abortSignal?: AbortSignal;
  onEvent?: (event: NodeStreamEvent) => void;
}

function buildCtx(opts: BuildCtxOptions): NodeContext {
  return {
    runId: "test-run",
    nodeId: "n1",
    inputs: opts.inputs ?? {},
    upstreamOutputs: opts.upstream ?? new Map(),
    cwd: process.cwd(),
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    emit: (event) => opts.onEvent?.(event),
    resolvedBody: opts.resolvedBody,
    rawBody: opts.resolvedBody,
    workflow: { name: "test", description: "", nodes: [] } as unknown as WorkflowDefinition,
  };
}

const stubNode = { id: "n1", bash: "" } as unknown as DagNode;

function completedUpstream(text: string): NodeOutput {
  return {
    state: "completed",
    output: text,
    startedAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T00:00:01.000Z",
    durationMs: 1000,
  };
}

describe("bashHandler", () => {
  test("upstream output is NOT shell-evaluated when accessed via env var", async () => {
    // The whole point of the env-var channel: an upstream node that
    // emitted `$(echo PWNED)` must surface as literal text, not as a
    // shell-evaluated command. The handler must dispatch from rawBody
    // (not resolvedBody) so text-substitution cannot turn upstream data
    // into shell code.
    const upstream = new Map<string, NodeOutput>([["evil", completedUpstream("$(echo PWNED)")]]);
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: `echo "got=$KEELSON_NODE_evil_OUTPUT"`,
        upstream,
      }),
    );
    expect(result.status).toBe("succeeded");
    const text = result.output.kind === "text" ? result.output.text : "";
    expect(text).toContain("got=$(echo PWNED)");
    // The forbidden payload must NOT have been executed (its result
    // would be the literal "PWNED" without the surrounding $(...)
    // chars; assert the unevaluated literal form is present and the
    // evaluated form is not).
    expect(text).not.toMatch(/got=PWNED$/m);
  });

  test("bash receives rawBody — executor's text-substitution does not run shell code", async () => {
    // Tests that the handler reads ctx.rawBody, not ctx.resolvedBody.
    // We pass different values for the two to verify.
    const handler = bashHandler;
    const node = stubNode;
    // Bypass buildCtx so resolvedBody and rawBody diverge.
    const result = await handler.handle(node, {
      runId: "r",
      nodeId: "n",
      inputs: {},
      upstreamOutputs: new Map(),
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      emit: () => undefined,
      resolvedBody: "echo INJECTED",
      rawBody: "echo SAFE",
      workflow: { name: "t", description: "", nodes: [] } as unknown as WorkflowDefinition,
    });
    expect(result.status).toBe("succeeded");
    const text = result.output.kind === "text" ? result.output.text : "";
    expect(text).toContain("SAFE");
    expect(text).not.toContain("INJECTED");
  });

  test("drain is bounded even if a child escapes the process group (setsid)", async () => {
    // `setsid` puts the child in a new session/pgroup that our kill can't
    // reach. The drain deadline must still bound the handler so abort
    // and timeout remain meaningful. macOS doesn't ship `setsid` by
    // default, so prefer it when available and otherwise approximate by
    // double-forking and using bash job control.
    const setsidProbe = await Bun.$`command -v setsid`.text().catch(() => "");
    const detacher =
      setsidProbe.trim().length > 0
        ? `setsid sleep 5 >/tmp/keelson-detached-out 2>&1 &`
        : // macOS fallback: nohup + & detaches from controlling tty but
          // stays in the same pgroup. Use a Python helper if available
          // for true setsid semantics; otherwise skip this scenario
          // (the test still validates the deadline path via the bg
          // child since SIGKILL would normally reap it).
          `python3 -c 'import os, time; os.setsid(); time.sleep(5)' >/tmp/keelson-detached-out 2>&1 &`;
    const start = Date.now();
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: `${detacher}\necho launched\nexit 0`,
      }),
    );
    const elapsed = Date.now() - start;
    expect(result.status).toBe("succeeded");
    // Must complete in well under the 5s sleep — the drain deadline is
    // 500ms, so total wall time is dominated by bash startup + drain.
    expect(elapsed).toBeLessThan(3_000);
    // Best-effort cleanup of any escaped child so tests don't leak.
    try {
      await Bun.$`pkill -f "sleep 5"`.quiet();
    } catch {
      /* nothing to kill */
    }
  });

  test("background child that outlives bash is reaped — drain doesn't hang", async () => {
    // `sleep 30 &` backgrounds the sleep and bash exits immediately. The
    // inherited stdout fd would otherwise block our reader.read() until
    // sleep exits 30s later. The post-exit pgroup SIGKILL must reap it.
    const start = Date.now();
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({ resolvedBody: "sleep 30 &\necho started\nexit 0" }),
    );
    const elapsed = Date.now() - start;
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" && result.output.text).toContain("started");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("happy path: captures stdout and reports succeeded", async () => {
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({ resolvedBody: "echo 'hello from bash'" }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.output.kind).toBe("text");
    expect(result.output.kind === "text" && result.output.text).toContain("hello from bash");
    expect(result.error).toBeUndefined();
  });

  test("non-zero exit code surfaces stderr tail in error", async () => {
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: "echo 'oops' >&2; exit 7",
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exit code 7/);
    expect(result.error).toMatch(/oops/);
  });

  test("emits node_log per stdout line", async () => {
    const lines: string[] = [];
    const onEvent = (event: NodeStreamEvent): void => {
      if (event.type === "node_log") lines.push(event.line);
    };
    await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: "printf 'one\\ntwo\\nthree\\n'",
        onEvent,
      }),
    );
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("exposes inputs and upstream as env vars (out-of-band channel)", async () => {
    const upstream = new Map<string, NodeOutput>([
      ["collect", completedUpstream("UPSTREAM_VALUE")],
    ]);
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody:
          'echo "args=$KEELSON_ARGUMENTS"; echo "in=$KEELSON_INPUTS_FOO"; echo "up=$KEELSON_NODE_collect_OUTPUT"',
        inputs: { ARGUMENTS: "hi", FOO: "bar" },
        upstream,
      }),
    );
    expect(result.status).toBe("succeeded");
    const text = result.output.kind === "text" ? result.output.text : "";
    expect(text).toContain("args=hi");
    expect(text).toContain("in=bar");
    expect(text).toContain("up=UPSTREAM_VALUE");
  });

  test("normalizes hyphenated upstream ids to underscores in env names", async () => {
    const upstream = new Map<string, NodeOutput>([["label-feature", completedUpstream("FEATURE")]]);
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: 'echo "$KEELSON_NODE_label_feature_OUTPUT"',
        upstream,
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" && result.output.text).toContain("FEATURE");
  });

  test("timeout returns failed with timeout message", async () => {
    const handler = makeBashHandler({ timeoutMs: 50 });
    const result = await handler.handle(stubNode, buildCtx({ resolvedBody: "sleep 2" }));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/bash timeout after/);
  });

  test("per-node `timeout` overrides factory default", async () => {
    // Factory says 30 minutes, node says 100ms — node wins.
    const handler = makeBashHandler({ timeoutMs: 30 * 60 * 1000 });
    const nodeWithTimeout = { id: "n1", bash: "", timeout: 100 } as unknown as DagNode;
    const start = Date.now();
    const result = await handler.handle(nodeWithTimeout, buildCtx({ resolvedBody: "sleep 30" }));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/bash timeout after/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("abort signal kills the subprocess and returns failed", async () => {
    const ac = new AbortController();
    const promise = bashHandler.handle(
      stubNode,
      buildCtx({ resolvedBody: "sleep 2", abortSignal: ac.signal }),
    );
    setTimeout(() => ac.abort(), 25);
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });

  test("SIGTERM-trapping script is escalated to SIGKILL within the grace window", async () => {
    // `trap '' TERM` makes the bash wrapper ignore SIGTERM. Without
    // escalation, the timeout would fire SIGTERM and `await proc.exited`
    // would hang forever. The escalation timer must SIGKILL after the
    // grace window so the handler always honors its advertised timeout.
    const handler = makeBashHandler({ timeoutMs: 100 });
    const start = Date.now();
    const result = await handler.handle(
      stubNode,
      buildCtx({
        resolvedBody: `trap '' TERM; sleep 30`,
      }),
    );
    const elapsed = Date.now() - start;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/bash timeout after/);
    // Timeout (100ms) + SIGTERM-to-SIGKILL grace (2000ms) + a little
    // scheduling slack — must complete in well under the sleep 30.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("line buffer caps at LINE_BUFFER_MAX_BYTES — large no-newline output flushes", async () => {
    // Bun's `head -c <N> /dev/zero` produces NULs (binary). For a portable
    // no-newline check, use `printf` with a long literal and assert that
    // at least one node_log line fires even though the script never
    // emits "\n". The exact buffer-flush threshold is bash.ts's
    // LINE_BUFFER_MAX_BYTES (64KB).
    const lines: string[] = [];
    const result = await bashHandler.handle(
      stubNode,
      buildCtx({
        resolvedBody: `python3 -c 'import sys; sys.stdout.write("x" * 200000); sys.stdout.flush()' 2>/dev/null || perl -e 'print "x" x 200000'`,
        onEvent: (e) => {
          if (e.type === "node_log") lines.push(e.line);
        },
      }),
    );
    expect(result.status).toBe("succeeded");
    // At least one synthetic-line flush should have fired (200KB / 64KB
    // cap = 3 flushes). The final trailing piece may also be emitted.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Each emitted chunk respects the cap.
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(64 * 1024);
    }
  }, 15000);

  // The grandchild-reaping guarantee is asserted here through POSIX-only
  // mechanics: a shared `/tmp` view between bash and Node, plus `process.kill(
  // pid, 0)` against the PIDs bash reports via `$!`. On Windows bash's `/tmp`
  // and its MSYS PIDs don't map onto Node's filesystem / Win32 PIDs, so the
  // scenario can't be asserted this way. Tree termination on abort is still
  // covered on Windows by the taskkill-based "abort signal kills the
  // subprocess" and "background child ... is reaped" tests above.
  test.skipIf(process.platform === "win32")(
    "abort reaps grandchild processes via process-group kill",
    async () => {
      // Stage two long-lived sleeps in the background and write their PIDs
      // to a temp file so we can verify they're dead AFTER the handler
      // returns. Without `detached: true` + `process.kill(-pid)`, the bash
      // wrapper dies but the child sleeps survive past abort (the bug Codex
      // flagged in round 1).
      const tmpFile = `/tmp/keelson-bash-pgrp-${crypto.randomUUID()}.txt`;
      const ac = new AbortController();
      const body = `
			sleep 30 &
			echo $! >> ${tmpFile}
			sleep 30 &
			echo $! >> ${tmpFile}
			wait
		`;
      const promise = bashHandler.handle(
        stubNode,
        buildCtx({ resolvedBody: body, abortSignal: ac.signal }),
      );
      // Give bash a beat to fork the children and write the pidfile.
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      const result = await promise;
      expect(result.status).toBe("failed");

      const fs = await import("node:fs");
      const pids = fs
        .readFileSync(tmpFile, "utf-8")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      fs.unlinkSync(tmpFile);
      expect(pids.length).toBeGreaterThanOrEqual(2);

      // Give SIGTERM a tick to propagate then verify both grandchildren
      // are gone. `process.kill(pid, 0)` throws ESRCH if the pid is dead.
      await new Promise((r) => setTimeout(r, 100));
      for (const pidStr of pids) {
        const pid = Number(pidStr);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        // Best-effort cleanup if the assertion would have failed —
        // don't leak sleepers into the host even on regression.
        if (alive) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* race */
          }
        }
        expect(alive).toBe(false);
      }
    },
  );

  test("runs with workflow cwd", async () => {
    // Git Bash reports POSIX paths (`/c/Users/...`); `pwd -W` prints the Windows
    // form so the assertion can line up with process.cwd() on both platforms.
    const body = process.platform === "win32" ? "pwd -W" : "pwd";
    const result = await bashHandler.handle(stubNode, buildCtx({ resolvedBody: body }));
    expect(result.status).toBe("succeeded");
    const actual = result.output.kind === "text" ? result.output.text.trim() : "";
    if (process.platform === "win32") {
      expect(actual.replace(/\\/g, "/").toLowerCase()).toBe(
        process.cwd().replace(/\\/g, "/").toLowerCase(),
      );
    } else {
      expect(actual).toBe(process.cwd());
    }
  });
});

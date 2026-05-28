// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `loop` NodeHandler. Synthesizes a `PromptNode` per iteration, dispatches to
 * the injected prompt handler, and stops on `until` signal, on `until_bash`
 * exit 0, on `max_iterations`, or on a failed iteration. When
 * `loop.interactive` is true, pauses between iterations via the injected
 * `awaitInteraction` callback and threads the user's reply into the next
 * iteration's prompt as `$LOOP_USER_INPUT`.
 *
 * `fresh_context` is read but does not yet alter provider behavior — sessions
 * are not threaded across iterations today (both registered providers declare
 * `sessionResume: false`). Iterations always start fresh; the field exists for
 * Archon-compatibility and to forward-declare the semantics for the
 * provider-side session-threading slice.
 */

import { type NodeHandler, type NodeResult, resolveBody } from "../executor.ts";
import { isLoopNode, type NodeOutput } from "../schema/index.ts";
import type { AwaitInteraction } from "./approval.ts";
import {
  detectCompletionSignal,
  failed,
  stripCompletionTags,
  synthesizePromptNode,
} from "./helpers.ts";
import { buildSubprocessEnv, runSubprocess, SubprocessSpawnError } from "./subprocess.ts";

/** Per-iteration timeout for the `loop.until_bash` completion probe. Matches Archon. */
export const UNTIL_BASH_TIMEOUT_MS = 120_000;

export interface UntilBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /**
   * True when the subprocess was killed by the abort signal (run cancel /
   * DELETE during a long-running probe). Set independently of `exitCode`
   * because a script that traps SIGTERM may still exit 0 after the kill,
   * which would otherwise be misread as a successful completion.
   */
  aborted?: boolean;
}

export interface RunUntilBashProbeOptions {
  cwd: string;
  signal: AbortSignal;
  /**
   * Loop-scoped overlay variables (`LOOP_PREV_OUTPUT`, `LOOP_USER_INPUT`).
   * Applied AFTER the standard subprocess channel built from `inputs` /
   * `upstreamOutputs` / `artifactsDir`, so probe scripts can reference
   * `$LOOP_PREV_OUTPUT` and `$KEELSON_INPUTS_X` in the same body.
   */
  env?: Readonly<Record<string, string>>;
  /** Workflow inputs — projected as `KEELSON_INPUTS_<key>` + `KEELSON_ARGUMENTS`. */
  inputs: Readonly<Record<string, string>>;
  /** Upstream node outputs — projected as `KEELSON_NODE_<id>_OUTPUT`. */
  upstreamOutputs: ReadonlyMap<string, NodeOutput>;
  /** Per-run scratch dir — projected as `KEELSON_ARTIFACTS_DIR` + `ARTIFACTS_DIR`. */
  artifactsDir?: string;
}

export type RunUntilBashProbe = (
  script: string,
  opts: RunUntilBashProbeOptions,
) => Promise<UntilBashResult>;

/**
 * Default `runUntilBashProbe` — spawns `bash -c <script>` inside the shared
 * subprocess machinery (kill-group / abort / timeout). The script body is
 * passed UNSUBSTITUTED: workflow data flows in through the env channel via
 * `buildSubprocessEnv`, matching the bash/script handlers' discipline. This
 * prevents model- or user-controlled text in `$LOOP_PREV_OUTPUT` /
 * `$LOOP_USER_INPUT` from injecting command substitution into the probe.
 *
 * Exposed so composition roots can wire it directly without reimplementing
 * the safety properties; a test harness or in-process CLI fallback can pass
 * a stub instead.
 */
export const defaultRunUntilBashProbe: RunUntilBashProbe = async (script, opts) => {
  const env = buildSubprocessEnv(opts.inputs, opts.upstreamOutputs, {
    ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
  });
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) env[k] = v;
  }
  try {
    const outcome = await runSubprocess({
      cmd: "bash",
      args: ["-c", script],
      cwd: opts.cwd,
      env,
      timeoutMs: UNTIL_BASH_TIMEOUT_MS,
      abortSignal: opts.signal,
      // The probe emits no node_log lines — we only care about the exit
      // code. A noop emit drops everything on the floor without paying
      // the chunk-coalescing cost.
      emit: () => undefined,
    });
    return {
      exitCode: outcome.exitCode ?? 1,
      stdout: outcome.stdoutText,
      stderr: outcome.stderrTail,
      timedOut: outcome.killReason === "timeout",
      aborted: outcome.killReason === "abort",
    };
  } catch (err) {
    if (err instanceof SubprocessSpawnError) {
      return { exitCode: 127, stdout: "", stderr: err.message };
    }
    throw err;
  }
};

export interface MakeLoopHandlerOptions {
  promptHandler: NodeHandler;
  /** Optional pause callback. When absent, `loop.interactive: true` fails fast. */
  awaitInteraction?: AwaitInteraction;
  /** Optional bash probe runner. When absent, `loop.until_bash` fails fast. */
  runUntilBashProbe?: RunUntilBashProbe;
}

// Single-pass loop-marker substitution. The executor's `resolveBody` has
// already substituted workflow markers (`$ARGUMENTS`, `$inputs.*`, etc.) in
// one pass; the loop-only markers are layered on top in a second pass that
// MUST also be single-pass — chaining two `.replace()` calls would let a
// `prevOutput` containing the literal `$LOOP_USER_INPUT` be re-matched and
// substituted by the next replace, corrupting data that happens to contain
// the marker text. The boundary lookahead rejects any continuing identifier
// character (upper, lower, digit, underscore) so `$LOOP_PREV_OUTPUT_TAIL`,
// `$LOOP_USER_INPUTfoo`, and `$LOOP_USER_INPUT9` all pass through untouched.
const LOOP_MARKER_PATTERN = /\$LOOP_(PREV_OUTPUT|USER_INPUT)(?![A-Za-z0-9_])/g;

function substituteLoopMarkers(body: string, prevOutput: string, userInput: string): string {
  return body.replace(LOOP_MARKER_PATTERN, (_match, marker: string) =>
    marker === "PREV_OUTPUT" ? prevOutput : userInput,
  );
}

export function makeLoopHandler(opts: MakeLoopHandlerOptions): NodeHandler {
  const { promptHandler, awaitInteraction, runUntilBashProbe } = opts;
  return {
    type: "loop",
    async handle(node, ctx): Promise<NodeResult> {
      if (!isLoopNode(node)) {
        return failed(`Loop node '${node.id}': missing 'loop' config`);
      }
      const loop = node.loop;

      if (loop.interactive === true && awaitInteraction === undefined) {
        return failed(
          `Loop node '${node.id}': interactive loops require server-side pause wiring (run via the server, not the in-process CLI fallback)`,
        );
      }
      // Honor workflow-level interactive. A workflow declared autonomous
      // (interactive !== true) MUST NOT pause for user input mid-run —
      // otherwise CI / cron consumers block indefinitely on a workflow
      // they thought was headless. Authors opt in with workflow-level
      // `interactive: true`; the loader's `interactive_loop_in_non_interactive_workflow`
      // warning fires for the mis-config so it surfaces at validate time.
      if (loop.interactive === true && ctx.workflow.interactive !== true) {
        return failed(
          `Loop node '${node.id}': loop.interactive: true requires workflow-level 'interactive: true'; this workflow is declared autonomous`,
        );
      }
      if (typeof loop.until_bash === "string" && runUntilBashProbe === undefined) {
        return failed(
          `Loop node '${node.id}': 'loop.until_bash' requires server-side probe wiring (run via the server, not the in-process CLI fallback)`,
        );
      }

      let prevOutput = "";
      let lastStripped = "";
      let userInput = "";

      for (let i = 1; i <= loop.max_iterations; i++) {
        if (ctx.abortSignal.aborted) {
          return failed(`Loop node '${node.id}': aborted`, prevOutput);
        }

        ctx.emit({
          type: "node_log",
          line: `iteration ${i} of ${loop.max_iterations}`,
        });

        // Substitution pipeline matches what the executor applies to
        // top-level string bodies; $LOOP_PREV_OUTPUT (previous stripped
        // output, empty on iteration 1) and $LOOP_USER_INPUT (the user's
        // reply on the iteration immediately after a resume, empty
        // otherwise) are loop-only extensions layered on top. `memoryRecall`
        // is forwarded so `$memory.recall.items` inside loop.prompt
        // substitutes against the executor's pre-run recall on every
        // iteration, not just the (skipped) outer pass.
        const substituted = resolveBody(loop.prompt, ctx.inputs, ctx.upstreamOutputs, {
          ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
          ...(ctx.memoryRecall !== undefined ? { memoryRecall: ctx.memoryRecall } : {}),
        });
        const iterationPrompt = substituteLoopMarkers(substituted, prevOutput, userInput);

        const synthesized = synthesizePromptNode(node, {
          id: `${node.id}#${String(i)}`,
          prompt: iterationPrompt,
        });

        const iterCtx = {
          ...ctx,
          resolvedBody: iterationPrompt,
          rawBody: iterationPrompt,
        };

        const result = await promptHandler.handle(synthesized, iterCtx);
        if (result.status !== "succeeded") return result;

        const text =
          result.output.kind === "text" ? result.output.text : JSON.stringify(result.output.value);

        const stripped = stripCompletionTags(text, loop.until);
        lastStripped = stripped;

        if (detectCompletionSignal(text, loop.until)) {
          return { status: "succeeded", output: { kind: "text", text: stripped } };
        }

        // Schema already enforces min(1) on until_bash, but guard at the
        // runtime boundary too — a blank script would `bash -c ""` to
        // exit 0 and silently terminate the loop after iteration 1.
        if (
          typeof loop.until_bash === "string" &&
          loop.until_bash.trim().length > 0 &&
          runUntilBashProbe !== undefined
        ) {
          // Script body is passed UNSUBSTITUTED to `bash -c` — author-controlled
          // markers like `$LOOP_PREV_OUTPUT` / `$KEELSON_INPUTS_X` reach the shell
          // literally and resolve through the env channel. Mirrors the bash /
          // script handlers' discipline: model- or user-controlled text never
          // gets concatenated into the script source, otherwise prior-iteration
          // output containing `$(...)` or backticks would execute as command
          // substitution on the next probe.
          try {
            const probe = await runUntilBashProbe(loop.until_bash, {
              cwd: ctx.cwd,
              signal: ctx.abortSignal,
              env: {
                LOOP_PREV_OUTPUT: prevOutput,
                LOOP_USER_INPUT: userInput,
              },
              inputs: ctx.inputs,
              upstreamOutputs: ctx.upstreamOutputs,
              ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
            });
            // Order matters: abort > timeout > exit 0. A probe that traps
            // SIGTERM and exits 0 after the kill must NOT be misread as a
            // successful loop completion. Abort propagates through the
            // signal too; the next iteration's top-of-loop check would
            // catch it, but short-circuiting here returns a failed result
            // with the right error message instead of looping once more.
            if (probe.aborted === true || ctx.abortSignal.aborted) {
              return failed(`Loop node '${node.id}': aborted`, stripped);
            }
            if (probe.timedOut === true) {
              ctx.emit({
                type: "node_log",
                line: `until_bash probe timed out (iteration ${String(i)}) — continuing`,
              });
            } else if (probe.exitCode === 0) {
              return { status: "succeeded", output: { kind: "text", text: stripped } };
            }
            // Non-zero (and timeouts) keep iterating — matches Archon's
            // behavior: the probe is a hint, not a fatal check.
          } catch (err) {
            // Probe runner threw (subprocess spawn failure, etc.). Surface
            // as a warning and keep iterating — the model's `until` signal
            // is still a valid termination path.
            ctx.emit({
              type: "node_warning",
              message: `until_bash probe failed (iteration ${String(i)}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        }

        // Last iteration — don't pause for input we'll never use.
        if (i === loop.max_iterations) break;

        if (loop.interactive === true && awaitInteraction !== undefined) {
          // gate_message is schema-required when interactive: true; resolve
          // it through the same substitution pipeline as loop.prompt so
          // authors can interpolate $ARGUMENTS / $LOOP_PREV_OUTPUT / etc.
          // into the pause copy. Schema enforces presence; '' fallback is
          // defensive.
          const rawGate = loop.gate_message ?? "";
          const gateMsg = substituteLoopMarkers(
            resolveBody(rawGate, ctx.inputs, ctx.upstreamOutputs, {
              ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
              ...(ctx.memoryRecall !== undefined ? { memoryRecall: ctx.memoryRecall } : {}),
            }),
            stripped,
            userInput,
          );

          try {
            userInput = await awaitInteraction(
              ctx.runId,
              ctx.nodeId,
              gateMsg,
              i,
              undefined,
              ctx.abortSignal,
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
              status: "failed",
              output: { kind: "text", text: stripped },
              error: ctx.abortSignal.aborted ? "aborted" : reason,
            };
          }
        }

        prevOutput = stripped;
      }

      // Hit max_iterations without seeing `until` — SUCCESS with the last
      // iteration's stripped output (matches Archon's behavior).
      return { status: "succeeded", output: { kind: "text", text: lastStripped } };
    },
  };
}

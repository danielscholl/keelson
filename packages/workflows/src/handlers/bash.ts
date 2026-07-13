// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `bash` NodeHandler. Authors reach inputs and upstream outputs through the
 * safe-quoted env-var channel (`"$KEELSON_NODE_<id>_OUTPUT"`,
 * `"$KEELSON_INPUTS_<key>"`, `"$KEELSON_ARGUMENTS"`); authors who want raw
 * text-substitution can keep using `$collect.output` directly (see
 * executor.ts §resolveBody for the trade-off it documents). Dispatch reads
 * `ctx.rawBody` deliberately: the executor's resolveBody expands refs by
 * raw text-replace, which would make `$(...)` and backticks in upstream
 * output executable when bash parses the body.
 */

import { type NodeHandler, type NodeResult, resolveConvergeRound } from "../executor.ts";
import { bundledBinDir, forgeShimPath } from "../seed.ts";
import { prependPath, resolveBash } from "./shell.ts";
import {
  buildSubprocessEnv,
  runSubprocess,
  SUBPROCESS_DEFAULT_TIMEOUT_MS,
  type SubprocessOutcome,
  SubprocessSpawnError,
} from "./subprocess.ts";

export interface MakeBashHandlerOptions {
  timeoutMs?: number;
}

export function makeBashHandler(opts: MakeBashHandlerOptions = {}): NodeHandler {
  const factoryTimeoutMs = opts.timeoutMs ?? SUBPROCESS_DEFAULT_TIMEOUT_MS;
  return {
    type: "bash",
    async handle(node, ctx): Promise<NodeResult> {
      const nodeTimeout = (node as { timeout?: unknown }).timeout;
      const timeoutMs =
        typeof nodeTimeout === "number" && Number.isFinite(nodeTimeout) && nodeTimeout > 0
          ? nodeTimeout
          : factoryTimeoutMs;

      let outcome: SubprocessOutcome;
      try {
        const bash = resolveBash();
        const shellBody = resolveConvergeRound(ctx.rawBody, {
          preserveEscaped: true,
          ...(ctx.convergeRound !== undefined ? { convergeRound: ctx.convergeRound } : {}),
        });
        const nodeEnv = buildSubprocessEnv(ctx.inputs, ctx.upstreamOutputs, {
          ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
        });
        nodeEnv.KEELSON_FORGE_BIN = forgeShimPath();
        // Live-splice the operator's forge selection: buildSubprocessEnv copies a
        // module-load env snapshot, so a value set after boot (or by a future
        // config path) wouldn't otherwise reach the node.
        if (process.env.KEELSON_FORGE?.trim()) nodeEnv.KEELSON_FORGE = process.env.KEELSON_FORGE;
        outcome = await runSubprocess({
          cmd: bash.cmd,
          args: ["-c", shellBody],
          cwd: ctx.cwd,
          // The bundled bin dir goes first so a bare `forge` resolves to the shim.
          env: prependPath(nodeEnv, [bundledBinDir(), ...bash.pathDirs]),
          timeoutMs,
          abortSignal: ctx.abortSignal,
          emit: ctx.emit,
        });
      } catch (err) {
        if (err instanceof SubprocessSpawnError) {
          return {
            status: "failed",
            output: { kind: "text", text: "" },
            error: `bash spawn failed: ${err.message}`,
          };
        }
        throw err;
      }

      const { stdoutText, stderrTail, exitCode, killReason } = outcome;

      if (killReason === "abort") {
        return {
          status: "failed",
          output: { kind: "text", text: stdoutText },
          error: "aborted",
        };
      }
      if (killReason === "timeout") {
        return {
          status: "failed",
          output: { kind: "text", text: stdoutText },
          error: `bash timeout after ${Math.round(timeoutMs / 1000)}s`,
        };
      }
      if (exitCode !== 0) {
        return {
          status: "failed",
          output: { kind: "text", text: stdoutText },
          error: stderrTail ? `exit code ${exitCode}: ${stderrTail}` : `exit code ${exitCode}`,
        };
      }
      return { status: "succeeded", output: { kind: "text", text: stdoutText } };
    },
  };
}

export const bashHandler: NodeHandler = makeBashHandler();

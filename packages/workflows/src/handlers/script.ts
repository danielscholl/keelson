// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `script` NodeHandler. Runs TypeScript/JavaScript via `bun` or Python via
 * `uv run`. Dispatch on `isInlineScript`: a bare identifier resolves through
 * `.keelson/scripts/`; anything else runs as inline code. The named-script branch lets the file extension veto
 * the runtime declared on the node — `runtime: bun` will not run a `.py`.
 *
 * Inline bodies dispatch from `ctx.rawBody` (pre-substitution). Splicing
 * substituted values into `bun -e` / `python -c` would make any character in
 * user input or upstream output executable as code (a `";process.exit(1)//`
 * payload via `$inputs.foo` would crash the subprocess; a more careful one
 * could exfiltrate secrets). Authors reach inputs and upstream output via the
 * `KEELSON_INPUTS_*`, `KEELSON_NODE_*_OUTPUT`, `KEELSON_ARGUMENTS` env channel that
 * `buildSubprocessEnv` populates — same contract the bash handler uses.
 */

import { type NodeHandler, type NodeResult, resolveConvergeRound } from "../executor.ts";
import { resolveScript, type ScriptRuntime } from "./discovery.ts";
import { failed, formatSubprocessFailure, isInlineScript } from "./helpers.ts";
import {
  buildSubprocessEnv,
  runSubprocess,
  SUBPROCESS_DEFAULT_TIMEOUT_MS,
  type SubprocessOutcome,
  SubprocessSpawnError,
} from "./subprocess.ts";

export interface MakeScriptHandlerOptions {
  timeoutMs?: number;
}

interface ScriptNodeLike {
  runtime: ScriptRuntime;
  deps?: readonly string[];
  timeout?: number;
}

interface SpawnSpec {
  cmd: string;
  args: string[];
}

function buildSpawnSpec(
  runtime: ScriptRuntime,
  body: string,
  resolvedPath: string | null,
  deps: readonly string[],
): SpawnSpec {
  const withFlags = deps.flatMap((d) => ["--with", d]);
  if (resolvedPath === null) {
    // Inline.
    // --no-env-file prevents Bun from auto-loading .env from the target
    // repo, which would otherwise leak repo secrets into the subprocess.
    if (runtime === "bun") return { cmd: "bun", args: ["--no-env-file", "-e", body] };
    return { cmd: "uv", args: ["run", ...withFlags, "python", "-c", body] };
  }
  if (runtime === "bun") return { cmd: "bun", args: ["--no-env-file", resolvedPath] };
  return { cmd: "uv", args: ["run", ...withFlags, resolvedPath] };
}

export function makeScriptHandler(opts: MakeScriptHandlerOptions = {}): NodeHandler {
  const factoryTimeoutMs = opts.timeoutMs ?? SUBPROCESS_DEFAULT_TIMEOUT_MS;
  return {
    type: "script",
    async handle(node, ctx): Promise<NodeResult> {
      const sn = node as unknown as ScriptNodeLike & { id: string };
      const runtime = sn.runtime;
      if (runtime !== "bun" && runtime !== "uv") {
        return failed(`Script node '${node.id}': invalid runtime '${String(runtime)}'`);
      }

      const timeoutMs =
        typeof sn.timeout === "number" && Number.isFinite(sn.timeout) && sn.timeout > 0
          ? sn.timeout
          : factoryTimeoutMs;

      // rawBody — see file header for the injection trade-off.
      const scriptBody = resolveConvergeRound(ctx.rawBody, {
        ...(ctx.convergeRound !== undefined ? { convergeRound: ctx.convergeRound } : {}),
      }).trim();
      if (!scriptBody) {
        return failed(`Script node '${node.id}': empty script body`);
      }

      let spec: SpawnSpec;
      if (isInlineScript(scriptBody)) {
        spec = buildSpawnSpec(runtime, scriptBody, null, sn.deps ?? []);
      } else {
        const resolved = await resolveScript(scriptBody, runtime, ctx.cwd);
        if (!resolved) {
          return failed(
            `Script node '${node.id}': named script '${scriptBody}' not found in .keelson/scripts/ for runtime '${runtime}'`,
          );
        }
        spec = buildSpawnSpec(runtime, scriptBody, resolved.path, sn.deps ?? []);
      }

      let outcome: SubprocessOutcome;
      try {
        outcome = await runSubprocess({
          cmd: spec.cmd,
          args: spec.args,
          cwd: ctx.cwd,
          env: buildSubprocessEnv(ctx.inputs, ctx.upstreamOutputs, {
            ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
          }),
          timeoutMs,
          abortSignal: ctx.abortSignal,
          emit: ctx.emit,
          trimTrailingNewline: true,
        });
      } catch (err) {
        if (err instanceof SubprocessSpawnError) {
          const detail = err.message;
          if (/ENOENT/.test(detail)) {
            const hint =
              runtime === "uv"
                ? " (install: https://docs.astral.sh/uv/)"
                : " (install: https://bun.sh/)";
            return failed(
              `Script node '${node.id}': '${spec.cmd}' executable not found in PATH${hint}`,
            );
          }
          return failed(`Script node '${node.id}': spawn failed: ${detail}`);
        }
        throw err;
      }

      const { stdoutText, stderrTail, exitCode, killReason } = outcome;
      const label = `Script node '${node.id}' (${runtime})`;

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
          error: `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
        };
      }
      if (exitCode !== 0) {
        return {
          status: "failed",
          output: { kind: "text", text: stdoutText },
          error: formatSubprocessFailure(label, {
            cmd: spec.cmd,
            exitCode,
            stderrTail,
          }),
        };
      }
      return { status: "succeeded", output: { kind: "text", text: stdoutText } };
    },
  };
}

export const scriptHandler: NodeHandler = makeScriptHandler();

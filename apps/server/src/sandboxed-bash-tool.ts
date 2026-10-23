// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import {
  createSandboxLaunchDir,
  disposeSandboxLaunchDir,
  prependPath,
  resolveBash,
  runSubprocess,
  type SandboxPolicy,
  SubprocessSpawnError,
  writeSandboxBody,
} from "@keelson/workflows";
import { z } from "zod";

// Mirrors pi's built-in bash: last 2000 lines or 50 KB of combined output.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const bashInputSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe("Timeout in seconds (optional, no default timeout)"),
});

export interface SandboxedBashToolOptions {
  policy: SandboxPolicy;
  // Per-conversation scratch: home/, tmp/, caches, and each call's script.
  scratchDir: string;
  // Env the sandboxed shell starts from before the policy filters it; defaults
  // to this process's env.
  baseEnv?: Readonly<Record<string, string>>;
  defaultTimeoutSec: number;
}

function definedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function truncateTail(text: string): string {
  let lines = text.split("\n");
  let truncated = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(-MAX_LINES);
    truncated = true;
  }
  let out = lines.join("\n");
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(-MAX_BYTES).toString("utf8");
    truncated = true;
  }
  return truncated ? `${out}\n\n[Output truncated to the last ${MAX_LINES} lines or 50KB]` : out;
}

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// Replaces pi's built-in `bash` on a sandboxed turn: same name, parameters, and
// output shape, but every command runs under the bash/script default profile
// (secrets and keelson state denied, network off) through the runtime's launcher.
export function createSandboxedBashTool(opts: SandboxedBashToolOptions): ToolDefinition {
  return {
    name: "bash",
    description:
      "Execute a bash command in the current working directory, inside the Keelson sandbox (network off; credentials and keelson state unreadable). Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB. Optionally provide a timeout in seconds.",
    inputSchema: bashInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const { command, timeout } = bashInputSchema.parse(input);
      const resolution = opts.policy.resolve({ enabled: true }, { cwd: ctx.cwd });
      if (resolution.fail !== undefined || resolution.profile === null) {
        emitResult(ctx, resolution.fail ?? "sandbox unavailable", true);
        return;
      }
      const profile = resolution.profile;
      const bash = resolveBash();
      const launchDir = createSandboxLaunchDir();
      // stderr is folded into stdout so the result reads like pi's own bash.
      const script = writeSandboxBody(launchDir, "command.sh", `exec 2>&1\n${command}\n`);
      const timeoutSec = timeout ?? opts.defaultTimeoutSec;
      try {
        const outcome = await runSubprocess({
          cmd: bash.cmd,
          args: [script],
          cwd: ctx.cwd,
          env: opts.policy.envFor(
            prependPath({ ...(opts.baseEnv ?? definedEnv()) }, bash.pathDirs),
            profile,
            opts.scratchDir,
          ),
          timeoutMs: timeoutSec * 1000,
          abortSignal: ctx.abortSignal,
          emit: () => undefined,
          trimTrailingNewline: true,
          stdoutCapture: "tail",
          launcher: opts.policy.launcherFor(profile, opts.scratchDir, launchDir),
        });
        // The child's stderr is in stdout; what reaches stderr is the runtime's
        // own launch failure, which the model needs to see.
        const combined = [outcome.stdoutText, outcome.stderrTail].filter((t) => t.length > 0);
        const text = truncateTail(combined.join("\n")) || "(no output)";
        const shown = text === "(no output)" ? "" : `${text}\n\n`;
        if (outcome.killReason === "abort") {
          emitResult(ctx, `${shown}Command aborted`, true);
        } else if (outcome.killReason === "timeout") {
          emitResult(ctx, `${shown}Command timed out after ${timeoutSec} seconds`, true);
        } else if (outcome.exitCode !== 0) {
          emitResult(ctx, `${shown}Command exited with code ${outcome.exitCode}`, true);
        } else {
          emitResult(ctx, text);
        }
      } catch (err) {
        if (!(err instanceof SubprocessSpawnError)) throw err;
        emitResult(ctx, `sandbox launch failed: ${err.message}`, true);
      } finally {
        disposeSandboxLaunchDir(launchDir);
      }
    },
  };
}

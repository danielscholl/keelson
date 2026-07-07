// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Shared subprocess runner for `bash` and `script` handlers.
 *
 * Encapsulates the kill-group dance (SIGTERM → SIGKILL grace → orphan reap),
 * the stdout line-streamer (with per-line cap + soft byte cap on captured
 * text), the stderr tail capture, the timeout + abort wiring, and the
 * bounded drain race. Both handlers share the same safety properties — a
 * daemonizing child that escapes the process group can't pin runtime past
 * the documented timeout, and a script that traps SIGTERM can't deadlock
 * the run.
 *
 * The env channel (`KEELSON_INPUTS_*`, `KEELSON_NODE_*_OUTPUT`, `KEELSON_ARGUMENTS`)
 * is the contract documented in `bash.ts` — single source here so future
 * additions (e.g. `KEELSON_RUN_ID`) reach both surfaces.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { mkdirSync, writeFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { join } from "node:path";

import type { NodeStreamEvent } from "../executor.ts";
import type { NodeOutput } from "../schema/index.ts";

export const SUBPROCESS_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const STDERR_TAIL_MAX_CHARS = 400;
const STDOUT_CAPTURE_MAX_BYTES = 1_000_000;
const KILL_GRACE_MS = 2_000;
const LINE_BUFFER_MAX_BYTES = 64 * 1024;
const DRAIN_DEADLINE_MS = 500;

export type SubprocessKillReason = "timeout" | "abort" | null;

export interface SubprocessOptions {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  abortSignal: AbortSignal;
  emit: (event: NodeStreamEvent) => void;
  /** Trim a single trailing newline from captured stdout before returning. */
  trimTrailingNewline?: boolean;
}

export interface SubprocessOutcome {
  stdoutText: string;
  stderrTail: string;
  exitCode: number | null;
  killReason: SubprocessKillReason;
}

export class SubprocessSpawnError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SubprocessSpawnError";
  }
}

const IS_WINDOWS = process.platform === "win32";

// Windows exposes the search path as `Path`; Bun.spawn resolves a bare command
// against `PATH` (uppercase) when handed an explicit env, so an env derived from
// `process.env` (which only carries `Path`) fails ENOENT for `bun`/`uv`/etc.
// Mirror the value onto `PATH`. No-op on POSIX and when `PATH` is already set.
function ensureSpawnPath(env: Record<string, string>): Record<string, string> {
  if (!IS_WINDOWS || env.PATH !== undefined) return env;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      env.PATH = env[key] as string;
      break;
    }
  }
  return env;
}

/**
 * Spawn a subprocess with the shared timeout/abort/drain machinery. Caller
 * decides how to render the result into a `NodeResult` (label/runtime/exit
 * formatting differ between bash and script).
 *
 * Throws `SubprocessSpawnError` synchronously if `Bun.spawn` itself fails
 * (typically ENOENT for a missing executable). Otherwise resolves with the
 * captured stdout, stderr tail, exit code, and kill reason.
 */
export async function runSubprocess(opts: SubprocessOptions): Promise<SubprocessOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.cmd, ...opts.args], {
      cwd: opts.cwd,
      env: ensureSpawnPath({ ...opts.env }),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // POSIX-only: a new process group lets the kill-group dance below reap a
      // daemonizing grandchild that escapes the immediate child. Windows has no
      // POSIX process groups, and Bun's `detached` there suppresses stdout/stderr
      // capture (empty output) — so omit it on Windows and lean on `taskkill /T`
      // for tree termination instead.
      // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
      // @ts-ignore
      detached: !IS_WINDOWS,
    });
  } catch (err) {
    throw new SubprocessSpawnError(err);
  }

  let killReason: SubprocessKillReason = null;
  let escalateTimer: ReturnType<typeof setTimeout> | null = null;

  const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (IS_WINDOWS) {
      // No POSIX process groups: terminate the whole child tree by pid. `/t`
      // walks children (the grandchildren a bare proc.kill would miss); `/f`
      // forces it on the SIGKILL escalation. SIGTERM stays best-effort/graceful.
      try {
        const args = ["/pid", String(proc.pid), "/t"];
        if (signal === "SIGKILL") args.push("/f");
        Bun.spawnSync(["taskkill", ...args], { stdout: "ignore", stderr: "ignore" });
      } catch {
        // taskkill unavailable or the pid is already gone
      }
      try {
        proc.kill();
      } catch {
        // already exited
      }
      return;
    }
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  const killOnce = (reason: "timeout" | "abort"): void => {
    if (killReason !== null) return;
    killReason = reason;
    signalGroup("SIGTERM");
    escalateTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
  };

  const timer = setTimeout(() => killOnce("timeout"), opts.timeoutMs);
  const onAbort = (): void => killOnce("abort");
  opts.abortSignal.addEventListener("abort", onAbort);
  if (opts.abortSignal.aborted) onAbort();

  const stdoutCapture: string[] = [];
  let stdoutBytes = 0;
  const stdoutPromise = streamLines(
    proc.stdout as ReadableStream<Uint8Array> | null,
    (line) => opts.emit({ type: "node_log", line }),
    (chunk) => {
      if (stdoutBytes < STDOUT_CAPTURE_MAX_BYTES) {
        stdoutCapture.push(chunk);
        stdoutBytes += chunk.length;
      }
    },
  );

  const stderrBox = { text: "" };
  const stderrPromise = streamStderr(proc.stderr as ReadableStream<Uint8Array> | null, stderrBox);

  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
    if (escalateTimer !== null) clearTimeout(escalateTimer);
    opts.abortSignal.removeEventListener("abort", onAbort);
  }
  signalGroup("SIGKILL");
  await Promise.race([
    Promise.allSettled([stdoutPromise, stderrPromise]),
    new Promise<void>((resolve) => setTimeout(resolve, DRAIN_DEADLINE_MS)),
  ]);

  const rawStdout = stdoutCapture.join("");
  // Strip an optional CR before the trailing LF: a native Windows program
  // (e.g. Python via `uv`) terminates output with `\r\n`, and trimming only the
  // `\n` would leave a stray `\r` on the captured value.
  const stdoutText = opts.trimTrailingNewline ? rawStdout.replace(/\r?\n$/, "") : rawStdout;
  const stderrTail = stderrBox.text.slice(-STDERR_TAIL_MAX_CHARS).trim();

  return { stdoutText, stderrTail, exitCode, killReason };
}

// ---------------------------------------------------------------------------
// Env channel
// ---------------------------------------------------------------------------

// Snapshot of the parent env at module load. Re-copying `process.env` on
// every spawn is wasteful; servers rarely mutate it after boot.
const PARENT_ENV: Readonly<Record<string, string>> = (() => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
})();

// Per-value cap on the env channel. The executor hands every completed node's
// output to each downstream subprocess, so a long DAG whose mid-run nodes emit
// large outputs (full test transcripts run 400KB+) can push the combined env
// past the platform spawn limit — macOS caps argv+env at ~1MiB total and Linux
// caps a single "KEY=value" string at 128KiB — failing posix_spawn with E2BIG.
// 16KiB/value keeps a 25-node closure near 400KiB worst case. Truncation keeps
// head + tail (leaders like `PLAN_FILE=` and trailers like `VALIDATION_STATUS:`
// are what bash nodes grep); the full text is spilled to an artifacts file.
export const ENV_VALUE_MAX_CHARS = 16 * 1024;
const ENV_VALUE_HEAD_CHARS = 8 * 1024;
const ENV_VALUE_TAIL_CHARS = 8 * 1024;

function truncateEnvValue(value: string, note: string): string {
  return `${value.slice(0, ENV_VALUE_HEAD_CHARS)}\n[keelson: ${note}]\n${value.slice(-ENV_VALUE_TAIL_CHARS)}`;
}

/**
 * Build the env block for a workflow subprocess. Layers `KEELSON_INPUTS_*`,
 * `KEELSON_NODE_*_OUTPUT`, `KEELSON_ARGUMENTS`, and (when provided) the per-run
 * `KEELSON_ARTIFACTS_DIR` onto a snapshot of the parent env. Non-alphanumeric
 * chars in keys/node ids are normalized to `_` so the resulting names are
 * valid POSIX env-var identifiers.
 *
 * Values over `ENV_VALUE_MAX_CHARS` are head+tail truncated with an inline
 * marker. A truncated node output is additionally spilled in full to
 * `<artifactsDir>/node-outputs/<id>.txt`, with the path published as
 * `KEELSON_NODE_<id>_OUTPUT_FILE` (omitted when there is no artifacts dir or
 * the write fails — the truncated env value is always still set).
 */
export function buildSubprocessEnv(
  inputs: Readonly<Record<string, string>>,
  upstream: ReadonlyMap<string, NodeOutput>,
  options?: { artifactsDir?: string },
): Record<string, string> {
  const env: Record<string, string> = { ...PARENT_ENV };
  // PARENT_ENV is captured at module load — if the operator's shell had
  // KEELSON_ARTIFACTS_DIR / ARTIFACTS_DIR set (or a parent process from a
  // prior run set them), they would leak into every subprocess unless we
  // clear them here. Set-back happens below when the caller provides a
  // per-run value.
  delete env.KEELSON_ARTIFACTS_DIR;
  delete env.ARTIFACTS_DIR;
  const capInput = (v: string): string =>
    v.length <= ENV_VALUE_MAX_CHARS
      ? v
      : truncateEnvValue(v, `input truncated — ${v.length} chars total`);
  for (const [k, v] of Object.entries(inputs)) {
    env[`KEELSON_INPUTS_${envSafe(k)}`] = capInput(v);
  }
  env.KEELSON_ARGUMENTS = capInput(inputs.ARGUMENTS ?? "");
  for (const [id, out] of upstream.entries()) {
    const full = out.output ?? "";
    const name = `KEELSON_NODE_${envSafe(id)}_OUTPUT`;
    if (full.length <= ENV_VALUE_MAX_CHARS) {
      env[name] = full;
      continue;
    }
    let fileNote = "";
    if (options?.artifactsDir !== undefined) {
      try {
        const dir = join(options.artifactsDir, "node-outputs");
        mkdirSync(dir, { recursive: true });
        const spillPath = join(dir, `${envSafe(id)}.txt`);
        writeFileSync(spillPath, full);
        env[`${name}_FILE`] = spillPath;
        fileNote = `; full output at $${name}_FILE`;
      } catch {
        // Spill is best-effort: an unwritable artifacts dir must not fail the
        // node, and the truncated env value below still carries head + tail.
      }
    }
    env[name] = truncateEnvValue(full, `output truncated — ${full.length} chars total${fileNote}`);
  }
  // Two env vars for the same path: `KEELSON_ARTIFACTS_DIR` is the prefixed
  // channel that matches the rest of our env contract (KEELSON_INPUTS_*,
  // KEELSON_NODE_*_OUTPUT). `ARTIFACTS_DIR` is the unprefixed name authors
  // reach for when porting workflows from Archon — and crucially, bash /
  // script nodes execute `ctx.rawBody` (pre-substitution, for command-
  // injection safety), so a body like `cd "$ARTIFACTS_DIR"` reaches the
  // shell literally and depends on env lookup. Without the unprefixed
  // var, that path resolves to empty and the command writes to `/`.
  if (options?.artifactsDir !== undefined) {
    env.KEELSON_ARTIFACTS_DIR = options.artifactsDir;
    env.ARTIFACTS_DIR = options.artifactsDir;
  }
  return env;
}

function envSafe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Stream readers
// ---------------------------------------------------------------------------

async function streamLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      // Defensive cap: a child producing many bytes without ever emitting
      // a newline (e.g. `head -c 100M /dev/zero`) would otherwise grow buf
      // unbounded.
      while (buf.length >= LINE_BUFFER_MAX_BYTES) {
        onLine(buf.slice(0, LINE_BUFFER_MAX_BYTES));
        buf = buf.slice(LINE_BUFFER_MAX_BYTES);
      }
    }
    if (buf.length > 0) onLine(buf);
  } catch {
    // reader closed mid-read; captured prefix is what we have
  }
}

async function streamStderr(
  stream: ReadableStream<Uint8Array> | null,
  out: { text: string },
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.text += decoder.decode(value, { stream: true });
      if (out.text.length > STDERR_TAIL_MAX_CHARS * 4) {
        out.text = out.text.slice(-STDERR_TAIL_MAX_CHARS * 2);
      }
    }
  } catch {
    // reader closed mid-read; whatever we captured is what we report
  }
}

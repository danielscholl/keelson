// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export type ExecResult<T> =
  | { ok: true; data: T; exitCode?: number | null }
  | { ok: false; error: string; code: number | null };

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  // Some commands print valid output AND exit non-zero to signal a logical
  // state. When true, a non-zero exit is returned as `ok: true` with
  // `exitCode` set; callers branch on `exitCode` (or the parsed payload)
  // if they care.
  acceptNonZeroExit?: boolean;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export async function runText(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult<string>> {
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([cmd, ...args], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      signal: ctrl.signal,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      if (opts.acceptNonZeroExit) {
        return { ok: true, data: stdout, exitCode: code };
      }
      const firstLine = stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      const reason = firstLine ?? `exit ${code}`;
      return { ok: false, error: reason.slice(0, 200), code };
    }
    return { ok: true, data: stdout, exitCode: 0 };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `timed out after ${timeoutMs}ms`, code: null };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|posix_spawnp|not found|No such file/i.test(msg)) {
      return { ok: false, error: `${cmd} not found`, code: null };
    }
    return { ok: false, error: msg.slice(0, 200), code: null };
  } finally {
    clearTimeout(timer);
  }
}

// Strip leading non-JSON garbage so warnings printed before the JSON payload
// (e.g. "Updating GitLab API token...") don't break parsing.
function findJsonStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}

export async function runJSON<T = unknown>(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult<T>> {
  const r = await runText(cmd, args, opts);
  if (!r.ok) return r;
  const start = findJsonStart(r.data);
  if (start < 0) {
    return { ok: false, error: "no JSON found in output", code: null };
  }
  try {
    return {
      ok: true,
      data: JSON.parse(r.data.slice(start)) as T,
      exitCode: r.exitCode,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `invalid JSON: ${msg}`.slice(0, 200), code: null };
  }
}

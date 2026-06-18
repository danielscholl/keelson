// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { runText as defaultRunText, type ExecResult } from "@keelson/shared/exec";
import { type ResolvedBash, resolveBash as resolveBashDefault } from "@keelson/workflows";

import type { CategoryResult, CheckResult } from "./types.ts";

export type RunText = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult<string>>;

export interface ToolchainDeps {
  runText?: RunText;
  resolveBash?: () => ResolvedBash;
}

interface Probe {
  cmd: string;
  args: string[];
  hint: string;
}

// Keelson core only requires bun on PATH. Ribs that need additional CLIs
// declare their own toolchain probes; this list stays minimal so a fresh
// install reports a clean baseline.
const PROBES: Probe[] = [
  {
    cmd: "bun",
    args: ["--version"],
    hint: "install Bun (https://bun.sh/) — the harness runtime",
  },
];

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

// bash powers the `bash` node and the loop `until_bash` probe. It's optional —
// prompt/command/script nodes don't need it — so a missing or WSL-shim bash is
// a warning, not a failure. On Windows the bare PATH `bash` is usually the WSL
// launcher (resolveBash only falls back to it when no Git Bash is found), and it
// runs in a separate filesystem namespace where the Windows cwd and the
// KEELSON_* paths a workflow projects don't resolve.
async function runBashCheck(exec: RunText, resolve: () => ResolvedBash): Promise<CheckResult> {
  const name = "bash (workflow shell)";
  const onWindows = process.platform === "win32";
  const hint = onWindows
    ? "powers `bash`/`loop` nodes — install Git for Windows (https://git-scm.com/download/win) or set KEELSON_BASH"
    : "powers `bash`/`loop` nodes — install bash or set KEELSON_BASH";
  const resolved = resolve();
  const r = await exec(resolved.cmd, ["--version"], { timeoutMs: 3000 });
  if (!r.ok) {
    return { name, status: "warn", detail: r.error, hint };
  }
  if (onWindows && resolved.cmd === "bash") {
    return {
      name,
      status: "warn",
      detail: "PATH `bash` (likely the WSL shim — can't see Windows paths)",
      hint,
    };
  }
  return { name, status: "ok", detail: firstLine(r.data) };
}

export async function runToolchainCheck(deps: ToolchainDeps = {}): Promise<CategoryResult> {
  const exec = deps.runText ?? defaultRunText;
  const resolveBash = deps.resolveBash ?? resolveBashDefault;
  const probeChecks: CheckResult[] = await Promise.all(
    PROBES.map(async (p): Promise<CheckResult> => {
      const r = await exec(p.cmd, p.args, { timeoutMs: 3000 });
      const name = `${p.cmd} ${p.args.join(" ")}`;
      if (r.ok) {
        return { name, status: "ok", detail: firstLine(r.data) };
      }
      return { name, status: "warn", detail: r.error, hint: p.hint };
    }),
  );
  const bash = await runBashCheck(exec, resolveBash);
  return { category: "toolchain", checks: [...probeChecks, bash] };
}

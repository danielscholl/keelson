// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { runText as defaultRunText, type ExecResult } from "@keelson/shared/exec";

import type { CategoryResult, CheckResult } from "./types.ts";

export type RunText = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult<string>>;

export interface ToolchainDeps {
  runText?: RunText;
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
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

export async function runToolchainCheck(
  deps: ToolchainDeps = {},
): Promise<CategoryResult> {
  const exec = deps.runText ?? defaultRunText;
  const checks: CheckResult[] = await Promise.all(
    PROBES.map(async (p): Promise<CheckResult> => {
      const r = await exec(p.cmd, p.args, { timeoutMs: 3000 });
      const name = `${p.cmd} ${p.args.join(" ")}`;
      if (r.ok) {
        return { name, status: "ok", detail: firstLine(r.data) };
      }
      return { name, status: "warn", detail: r.error, hint: p.hint };
    }),
  );
  return { category: "toolchain", checks };
}

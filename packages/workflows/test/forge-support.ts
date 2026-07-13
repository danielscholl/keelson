// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Shared helpers for the `forge` shim tests: spawn the shim with a controlled
// PATH, and stand up fake `gh`/`glab` executables so the GitLab translation and
// the GitHub byte-for-byte passthrough can be exercised without a live forge.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeShimPath } from "../src/seed.ts";

export const SHIM = forgeShimPath();

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runForge(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): RunResult {
  const proc = Bun.spawnSync({
    cmd: [SHIM, ...args],
    cwd: opts.cwd ?? process.cwd(),
    env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

// Write fake executables (bash bodies, or full scripts starting with `#!`) into
// a fresh temp dir and return the dir, to prepend onto PATH.
export function fakeBinDir(fakes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-forge-fake-"));
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(dir, name);
    writeFileSync(p, body.startsWith("#!") ? body : `#!/usr/bin/env bash\n${body}`);
    chmodSync(p, 0o755);
  }
  return dir;
}

// Put a fake-bin dir first on PATH (so its gh/glab shadow the real ones).
export function pathWith(dir: string): string {
  return `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
}

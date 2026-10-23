// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ensureSpawnPath } from "./exec.ts";

// `@keelson/workflows` mirrors these three types structurally in
// `handlers/launcher.ts` (it has no dependency on this package); keep them in step.

export interface SpawnSpec {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface ProcessLauncher {
  readonly id: "host" | "mxc";
  // Throws synchronously when the process cannot start (ENOENT and the like).
  spawn(spec: SpawnSpec): SpawnHandle;
}

const IS_WINDOWS = process.platform === "win32";

export const hostLauncher: ProcessLauncher = {
  id: "host",
  spawn(spec) {
    return Bun.spawn([spec.cmd, ...spec.args], {
      cwd: spec.cwd,
      env: ensureSpawnPath({ ...spec.env }),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
      // A POSIX process group lets the caller signal `-pid` to reap a daemonizing
      // grandchild. On Windows Bun's `detached` drops piped stdout/stderr, so it stays off.
      // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
      // @ts-ignore
      detached: !IS_WINDOWS,
    });
  },
};

// POSIX `sh` quoting: every token single-quoted, an embedded `'` closed, escaped, reopened.
export function shellJoin(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

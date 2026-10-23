// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Structural mirror of `@keelson/shared/launcher`; this package takes no
// dependency on shared, so the types are repeated and must stay assignable.

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

export const hostLauncher: ProcessLauncher = {
  id: "host",
  spawn(spec) {
    return Bun.spawn([spec.cmd, ...spec.args], {
      cwd: spec.cwd,
      env: ensureSpawnPath({ ...spec.env }),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // The backgrounded server has no console on Windows (detached launch), so
      // an unhidden console child would flash a visible window on every spawn.
      windowsHide: true,
      // POSIX-only: a new process group lets the kill-group dance in
      // runSubprocess reap a daemonizing grandchild that escapes the immediate
      // child. Windows has no POSIX process groups, and Bun's `detached` there
      // suppresses stdout/stderr capture (empty output) — so omit it on Windows
      // and lean on `taskkill /T` for tree termination instead.
      // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
      // @ts-ignore
      detached: !IS_WINDOWS,
    });
  },
};

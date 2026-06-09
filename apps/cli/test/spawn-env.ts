// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Build an env for spawning the CLI under test. On Windows `process.env` carries
// the search path as `Path`; Bun.spawn resolves a bare command (`bun`) against
// `PATH` (uppercase) when handed an explicit env, so a plain spread of
// `process.env` fails ENOENT. Mirror the value onto `PATH`. This is the
// test-side analog of the production guard in `@keelson/shared/exec.ts` and the
// `@keelson/workflows` subprocess runner.
export function spawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env, ...overrides } as Record<string, string>;
  if (process.platform === "win32" && env.PATH === undefined) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") {
        env.PATH = env[key] as string;
        break;
      }
    }
  }
  return env;
}

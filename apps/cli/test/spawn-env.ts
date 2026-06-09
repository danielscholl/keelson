// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { ensureSpawnPath } from "@keelson/shared/exec";

// Build an env for spawning the CLI under test. On Windows `process.env`
// carries the search path as `Path`; Bun.spawn resolves a bare command (`bun`)
// against `PATH` (uppercase) when handed an explicit env, so a plain spread of
// `process.env` fails ENOENT — same guard the production spawn sites use.
export function spawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return ensureSpawnPath({ ...process.env, ...overrides } as Record<string, string>);
}

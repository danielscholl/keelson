// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

/**
 * Rib — Keelson's extension contract.
 *
 * The name comes from shipbuilding: the keelson is the longitudinal beam
 * that runs along the keel; ribs are the structural members that fasten
 * to it and give the hull its shape. In Keelson, the harness is the beam
 * and ribs are the units that register tools, contribute capabilities,
 * and own external-system integrations.
 *
 * Ribs ship as their own packages and repos:
 *   - npm:    `@keelson/rib-<name>`
 *   - GitHub: `keelson-rib-<name>`
 *   - path:   `packages/rib-<name>/` (in-tree, when bundled)
 *
 * Activation is embedder-wired: the composition root imports the rib package
 * and passes it to `bootstrapRibs({ available })`. The `KEELSON_RIBS` env var
 * (comma-separated) filters which manifest entries actually activate; unset
 * means activate all of them. Dynamic discovery from
 * `node_modules/@keelson/rib-*` is reserved for a follow-up release.
 */

// Rib IDs cross process boundaries via the KEELSON_RIBS env var and the
// operator CLI. Lock them to lowercase kebab-case so values stay URL-safe
// and predictable. The matching displayName schema gates the human-readable
// label that may surface in the UI.
export const ribIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, {
    message: "rib id must be lowercase kebab-case",
  });

export const ribDisplayNameSchema = z.string().min(1).max(80);

// Result discriminant shared by both exec helpers.
export type RibExecResult<T> =
  | { ok: true; data: T; exitCode?: number | null }
  | { ok: false; error: string; code: number | null };

export interface RibExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  acceptNonZeroExit?: boolean;
}

// Process-exec surface every rib can rely on.
export interface RibExec {
  runJSON<T = unknown>(
    cmd: string,
    args: string[],
    opts?: RibExecOptions,
  ): Promise<RibExecResult<T>>;
  runText(cmd: string, args: string[], opts?: RibExecOptions): Promise<RibExecResult<string>>;
}

// Dependency-injection surface the harness passes to every rib. The
// `getSidecar` resolver intentionally returns `unknown` — each rib declares
// its own structural narrowing and casts at the registration boundary.
// This keeps @keelson/shared free of back-deps on host packages.
export interface RibContext {
  getSidecar?: () => Promise<unknown> | unknown;
  getExec: () => RibExec;
}

// The harness/rib contract. Implementations live in @keelson/rib-* packages.
//
// All lifecycle hooks are optional; a rib can implement any subset.
// `composeBundle` is reserved for the future snapshot-infra capability and
// is a no-op today — declare it on your rib if you want forward-compat.
export interface Rib {
  // Stable identifier matching the package basename
  // (e.g. "my-rib" → @keelson/rib-my-rib). Gated by KEELSON_RIBS.
  id: string;
  displayName: string;
  registerTools?(ctx: RibContext): { registered: string[] };
  composeBundle?(ctx: RibContext): Promise<unknown>;
  // Sync or async — the harness awaits the returned promise (if any)
  // during shutdown so ribs holding sockets, watchers, or child
  // processes can tear down cleanly before db close.
  dispose?(): void | Promise<void>;
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { canvasKindSchema } from "./canvas.ts";

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
 * Activation: `bootstrapRibs()` discovers installed `@keelson/rib-*` packages
 * from `node_modules/@keelson/` at boot; embedders can bypass discovery by
 * passing an explicit `bootstrapRibs({ available })` map. The `KEELSON_RIBS`
 * env var (comma-separated) filters which discovered ribs actually activate;
 * unset means activate all of them.
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

// Extract the owning rib id from a rib-namespaced key (`rib:<id>` or
// `rib:<id>:*`), or null when the key isn't in any rib's namespace. Mirrors the
// server-side `assertInNamespace` rule so the SPA can route a board's actions to
// the rib that published it.
export function ribIdFromKey(key: string): string | null {
  return /^rib:([a-z][a-z0-9-]*)(?::|$)/.exec(key)?.[1] ?? null;
}

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
//
// `getSnapshotManager` is optional so test contexts that don't care about
// snapshots can construct a minimal RibContext.
export interface RibContext {
  getSidecar?: () => Promise<unknown> | unknown;
  getExec: () => RibExec;
  getSnapshotManager?: () => import("./snapshots.ts").SnapshotManager;
  // Resolves a credential scoped to THIS rib's own namespace (read-only). A
  // rib reads only the secrets stored under its id; the harness rejects any
  // attempt to reach another rib's keys. Optional so minimal test contexts
  // without a credential store still satisfy the interface.
  getCredential?: (serviceId: string) => Promise<string | undefined>;
}

// A view a rib declares so the harness surfaces a live canvas for one of the
// rib's snapshot keys with no per-rib UI code. `canvasKind` is the closed
// base enum; the payload published under `key` must satisfy the matching
// renderer (the client gate fail-closes on a mismatch). Static metadata, not
// a hook — the manifest is built without invoking rib code.
export const ribViewDescriptorSchema = z
  .object({
    key: z.string().min(1),
    canvasKind: canvasKindSchema,
    title: z.string().optional(),
  })
  .strict();
export type RibViewDescriptor = z.infer<typeof ribViewDescriptorSchema>;

// A rib's primary surface: one top-level nav tab laying out region-bound boards
// (G1 stays "one panel"; the surface owns columns/header/footer). Each region
// `key` must live under the rib's namespace, like view keys. Only the header
// and footer collapse — banner and row columns always render full.
const surfaceRegionSchema = z.object({ key: z.string().min(1) }).strict();
const collapsibleRegionSchema = z
  .object({
    key: z.string().min(1),
    collapsible: z.boolean().optional(),
    collapsed: z.boolean().optional(),
  })
  .strict();
export const ribSurfaceDescriptorSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    layout: z
      .object({
        header: collapsibleRegionSchema.optional(),
        banner: surfaceRegionSchema.optional(),
        rows: z.array(z.object({ columns: z.array(surfaceRegionSchema).min(1) }).strict()),
        footer: collapsibleRegionSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RibSurfaceDescriptor = z.infer<typeof ribSurfaceDescriptorSchema>;

// A button the Ribs panel renders; clicking it dispatches `type` to onAction.
export const ribActionDescriptorSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();
export type RibActionDescriptor = z.infer<typeof ribActionDescriptorSchema>;

// Inbound action a rib receives over POST /api/ribs/:id/action. The base never
// enumerates `type` (a rib-defined verb); `payload` stays opaque and the rib
// narrows at its edge. The capability-token envelope + outbound dispatcher are
// a later milestone — today this path is loopback-trusted.
export const ribActionSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .strict();
export type RibAction = z.infer<typeof ribActionSchema>;

export type RibActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

// Result of a rib's auth-status probe. The probe is not expected to throw; a
// throwing probe is caught at the seam and reported as
// `{ authenticated: false, statusMessage: <error> }`.
export const ribAuthStatusSchema = z
  .object({
    authenticated: z.boolean(),
    statusMessage: z.string().optional(),
  })
  .strict();
export type RibAuthStatus = z.infer<typeof ribAuthStatusSchema>;

// A workflow the rib contributes to the catalog at activation, optionally
// bound so its structured run output republishes to a rib-namespaced snapshot
// key. `definition` stays `unknown` at the contract floor — @keelson/shared
// must not depend on @keelson/workflows; the server validates it against the
// workflow schema when it merges the contribution.
export interface RibWorkflowContribution {
  definition: unknown;
  bindSnapshotKey?: string;
  // Producer-side fail-closed validator for the bound key (e.g. a zod
  // `.parse`). Runs before the frame is cached/broadcast — an invalid payload
  // is dropped and the prior value kept, so a bad workflow output never
  // reaches a trusted renderer.
  validate?: (data: unknown) => unknown;
}

// The harness/rib contract. Implementations live in @keelson/rib-* packages.
//
// All lifecycle hooks are optional; a rib can implement any subset.
//
// If `composeBundle` is declared, the harness registers it as the snapshot
// composer under `rib.id` after `registerTools` returns. The closure is
// invoked LAZILY — only when something calls `SnapshotManager.recompose(rib.id)`,
// not eagerly at boot. Ribs that want a warm initial snapshot should call
// `ctx.getSnapshotManager?.().recompose(rib.id)` from inside `registerTools`.
// Ribs can also register additional snapshots imperatively via
// `ctx.getSnapshotManager?.().register(key, …)`.
export interface Rib {
  // Stable identifier matching the package basename
  // (e.g. "my-rib" → @keelson/rib-my-rib). Gated by KEELSON_RIBS.
  id: string;
  displayName: string;
  registerTools?(ctx: RibContext): { registered: string[] };
  composeBundle?(ctx: RibContext): Promise<unknown>;
  // Static view descriptors honored by the canvas-kind registry / Ribs panel.
  // Each `key` must live under the rib's namespace (`rib:<id>` or
  // `rib:<id>:*`); the harness rejects out-of-namespace keys at activation.
  views?: readonly RibViewDescriptor[];
  // Static action descriptors the Ribs panel renders as buttons. Each `type`
  // is dispatched to `onAction`.
  actions?: readonly RibActionDescriptor[];
  // Static surface descriptors — primary nav tabs that lay out region-bound
  // boards. Each region `key` must live under the rib's namespace, like view
  // keys; the harness rejects out-of-namespace keys at activation.
  surfaces?: readonly RibSurfaceDescriptor[];
  // Workflow definitions the rib contributes to the catalog at activation,
  // optionally each bound to a rib-namespaced snapshot key.
  contributeWorkflows?(ctx: RibContext): readonly RibWorkflowContribution[];
  // Inbound action handler reached via POST /api/ribs/:id/action.
  onAction?(action: RibAction, ctx: RibContext): Promise<RibActionResult> | RibActionResult;
  // Auth-status probe surfaced in GET /api/ribs (and, optionally, doctor).
  authStatus?(ctx: RibContext): Promise<RibAuthStatus> | RibAuthStatus;
  // Sync or async — the harness awaits the returned promise (if any)
  // during shutdown so ribs holding sockets, watchers, or child
  // processes can tear down cleanly before db close.
  dispose?(): void | Promise<void>;
}

// Wire shape for GET /api/ribs — what the SPA consumes to discover active ribs
// without an App.tsx edit. `views`/`actions`/`surfaces` are always present
// (possibly empty); `auth` is present only when the rib declares an
// `authStatus` probe.
export const ribSummarySchema = z
  .object({
    id: ribIdSchema,
    displayName: ribDisplayNameSchema,
    registered: z.array(z.string()),
    views: z.array(ribViewDescriptorSchema),
    actions: z.array(ribActionDescriptorSchema),
    surfaces: z.array(ribSurfaceDescriptorSchema),
    hasOnAction: z.boolean(),
    auth: ribAuthStatusSchema.optional(),
  })
  .strict();
export type RibSummary = z.infer<typeof ribSummarySchema>;

export const listRibsResponseSchema = z.object({ ribs: z.array(ribSummarySchema) }).strict();
export type ListRibsResponse = z.infer<typeof listRibsResponseSchema>;

// Wire shape for the POST /api/ribs/:id/action response — the discriminated
// RibActionResult the rib's onAction returns.
export const ribActionResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type RibActionResponse = z.infer<typeof ribActionResponseSchema>;

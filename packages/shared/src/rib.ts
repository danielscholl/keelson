// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { canvasKindSchema, canvasToneSchema } from "./canvas.ts";
import type { MessageChunk } from "./chat.ts";
import type { CommandCompletion, CommandInvokeResult, RibCommandDescriptor } from "./commands.ts";
import type { Policy } from "./policy.ts";
import type { ToolDefinition } from "./tools.ts";

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

// ---------------------------------------------------------------------------
// Agent invocation — a rib runs one agent turn through the harness.
//
// Types only, no `@keelson/providers` back-dep: `MessageChunk` is the shared
// chat streaming unit. The host routes the turn through the provider registry,
// so a rib inherits provider pinning / redaction / credentials behind this one
// signature.
// ---------------------------------------------------------------------------

export interface RibAgentTurnRequest {
  prompt: string;
  system?: string;
  // A HINT, not a pin: undefined resolves to KEELSON_WORKFLOW_PROVIDER, then the
  // first non-stub registered provider.
  provider?: string;
  model?: string;
  // Omit for a text-only turn (the room default — no Bash/Edit between turns).
  tools?: readonly { name: string; [k: string]: unknown }[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  // The room's dispose() aborts in-flight turns via this signal.
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  // Accepted now, inert until provider capabilities allow session resumption.
  resumeSessionId?: string;
}

export interface RibAgentTurnResult {
  status: "ok" | "aborted" | "timeout" | "error";
  text: string;
  error?: string;
  // The provider id the turn resolved to.
  providerId?: string;
  sessionId?: string;
}

// A settled dual-handle, NOT a bare AsyncGenerator: `stream` is live progress,
// `result` settles exactly once after the stream completes. `result` is the
// source of truth; the stream is derived from it (full text, then a terminal
// `done`).
export interface RibAgentTurn {
  stream: AsyncIterable<MessageChunk>;
  result: Promise<RibAgentTurnResult>;
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
  // Absolute path to THIS rib's private data directory under the keelson home,
  // named `rib-<id>` (`<home>/rib-<rib-id>`); path only — the rib creates it when
  // it writes. Optional, like the accessors above, so an older harness can omit it.
  getDataDir?: () => string;
  // Run one agent turn. Optional, like the accessors above, so a rib that
  // needs rooms but finds it absent fails closed. Provider routing is global,
  // not namespace-scoped. See RibAgentTurn for the stream/result contract.
  runAgentTurn?: (req: RibAgentTurnRequest) => RibAgentTurn;
  // Add a region (a snapshot-backed panel) to one of THIS rib's statically
  // declared surfaces at runtime, returning an unregister handle. Layout-only:
  // the rib still registers the region's snapshot key itself. The harness
  // appends the region to the surface's layout (grouped by `region.group`) and
  // nudges the SPA to re-fetch the manifest. `surfaceId` must name a surface the
  // rib declared; `region.key` must be under `rib:<id>:*`. Optional so a rib
  // built against an older harness degrades to no dynamic regions, not a throw.
  registerRegion?: (surfaceId: string, region: RibSurfaceRegion) => () => void;
}

// The harness-owned snapshot key the SPA subscribes to as a manifest-revision
// beacon: every runtime region add/remove bumps it, prompting a /api/ribs
// re-fetch. Not under a `rib:*` namespace — the harness registers it on the base
// snapshot manager, never a scoped one.
export const RIBS_VERSION_SNAPSHOT_KEY = "keelson:ribs:version";

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
// and footer collapse — banner and row columns always render full. `workflow`,
// when set, is the catalog workflow a region's refresh re-runs to repopulate its
// key (vs. a plain re-read of the cached frame). `title`/`glyph` give the region
// a static identity (a lane name + a toned glyph chip) shown in its head even
// before data arrives — distinct from the board's own dynamic title. `cadenceMs`,
// when set, is the auto-refresh interval (ms) the SPA re-runs `workflow` on while
// the surface is open (on open and on a ~30s heartbeat); floored to 30s.
const regionGlyphSchema = z
  .object({ char: z.string().min(1), tone: canvasToneSchema.optional() })
  .strict();
export const surfaceRegionSchema = z
  .object({
    key: z.string().min(1),
    workflow: z.string().min(1).optional(),
    cadenceMs: z.number().int().min(30000).optional(),
    title: z.string().min(1).optional(),
    glyph: regionGlyphSchema.optional(),
    // Clustering hint for regions added at runtime via RibContext.registerRegion:
    // the GET /api/ribs merge keeps regions sharing a `group` contiguous so two
    // producers' panels on one surface (e.g. lenses vs rooms) don't interleave by
    // arrival order. Inert for statically-declared regions.
    group: z.string().min(1).optional(),
  })
  .strict();
export type RibSurfaceRegion = z.infer<typeof surfaceRegionSchema>;
const collapsibleRegionSchema = z
  .object({
    key: z.string().min(1),
    workflow: z.string().min(1).optional(),
    cadenceMs: z.number().int().min(30000).optional(),
    title: z.string().min(1).optional(),
    glyph: regionGlyphSchema.optional(),
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

// Inbound action a rib receives over POST /api/ribs/:id/action. The base never
// enumerates `type` (a rib-defined verb); `payload` stays opaque and the rib
// narrows at its edge. The capability-token envelope + outbound dispatcher are
// not yet wired; today this path is loopback-trusted.
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
  // Returns the rib's chat/workflow tools. The harness registers them into the
  // shared tool registry at boot, so they reach the chat agent (and workflow
  // `prompt` nodes) through the provider tool adapters with no per-rib wiring.
  // Tool names are global; a name already claimed by another rib is skipped
  // with a warning. The factory receives the per-rib `ctx` so a tool's
  // `execute` can close over the rib's exec/sidecar/credential resolvers — the
  // same data layer its `composeBundle` snapshot draws from.
  registerTools?(ctx: RibContext): readonly ToolDefinition[];
  composeBundle?(ctx: RibContext): Promise<unknown>;
  // Static view descriptors honored by the canvas-kind registry. Each `key` must
  // live under the rib's namespace (`rib:<id>` or `rib:<id>:*`); the harness
  // rejects out-of-namespace keys at activation.
  views?: readonly RibViewDescriptor[];
  // Static surface descriptors — primary nav tabs that lay out region-bound
  // boards. Each region `key` must live under the rib's namespace, like view
  // keys; the harness rejects out-of-namespace keys at activation.
  surfaces?: readonly RibSurfaceDescriptor[];
  // Workflow definitions the rib contributes to the catalog at activation,
  // optionally each bound to a rib-namespaced snapshot key.
  contributeWorkflows?(ctx: RibContext): readonly RibWorkflowContribution[];
  // Policies the rib contributes to the harness governance stack at activation.
  // The harness composes them with its builtins behind one engine and evaluates
  // them at every turn path's hook points (see `Policy`). Collected once at boot,
  // like `contributeWorkflows`.
  contributePolicies?(ctx: RibContext): readonly Policy[];
  // Inbound action handler reached via POST /api/ribs/:id/action.
  onAction?(action: RibAction, ctx: RibContext): Promise<RibActionResult> | RibActionResult;
  // Agents the rib offers for direct chat — named, reusable turn templates
  // (a system prompt plus an optional model), surfaced at GET /api/agents.
  // `listAgents` is cheap (no system prompt assembled); `resolveAgent` lazily
  // builds one slug's seed on selection, returning null for an unknown slug. A
  // rib's slash command or a board action resolves one and opens it as a seeded
  // chat.
  listAgents?(ctx: RibContext): readonly AgentSummary[] | Promise<readonly AgentSummary[]>;
  resolveAgent?(
    slug: string,
    ctx: RibContext,
  ): (OpenChatSeed | null) | Promise<OpenChatSeed | null>;
  // Slash commands the rib contributes to the chat composer, surfaced at
  // GET /api/commands. `listCommands` is cheap (static descriptors). `invokeCommand`
  // runs one server-side and returns a closed CommandEffect the surface performs
  // (open one of the rib's agents, run a workflow, or show a message), keeping the
  // rib's logic off the trusted surfaces. It MUST be a side-effect-free resolver —
  // it decides WHICH effect to perform; the SURFACE performs it, and may gate or
  // defer that (e.g. refuse `open-agent` mid-turn), so the rib must not have
  // mutated state by the time invoke returns. `completeCommand` (optional) backs the
  // argument type-ahead for a command whose descriptor sets `argument.completes`.
  // It MUST return the full candidate set for an empty `prefix`: surfaces fetch
  // once with `prefix=""` and filter client-side (so the completer is called at
  // most once per command, not per keystroke), then narrow `prefix` themselves.
  listCommands?(
    ctx: RibContext,
  ): readonly RibCommandDescriptor[] | Promise<readonly RibCommandDescriptor[]>;
  invokeCommand?(
    name: string,
    arg: string,
    ctx: RibContext,
  ): CommandInvokeResult | Promise<CommandInvokeResult>;
  completeCommand?(
    name: string,
    prefix: string,
    ctx: RibContext,
  ): readonly CommandCompletion[] | Promise<readonly CommandCompletion[]>;
  // Auth-status probe surfaced in GET /api/ribs (and, optionally, doctor).
  authStatus?(ctx: RibContext): Promise<RibAuthStatus> | RibAuthStatus;
  // Sync or async — the harness awaits the returned promise (if any)
  // during shutdown so ribs holding sockets, watchers, or child
  // processes can tear down cleanly before db close.
  dispose?(): void | Promise<void>;
}

// Wire shape for GET /api/ribs — what the SPA consumes to discover active ribs
// without an App.tsx edit. `views`/`surfaces` are always present (possibly
// empty); `auth` is present only when the rib declares an `authStatus` probe.
export const ribSummarySchema = z
  .object({
    id: ribIdSchema,
    displayName: ribDisplayNameSchema,
    registered: z.array(z.string()),
    views: z.array(ribViewDescriptorSchema),
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

// A seed for a fresh, seeded chat — the systemPrompt and name capped at the
// server's createConversation limits so a directive can be rejected client-side
// rather than 400 at create. `openingPrompt` is optional: omitted means the chat
// opens without an auto-fired first turn. `model`/`providerId` are the agent's
// configured model reference, carried so entering an agent uses its own model
// rather than the surface's session default. Pin `providerId` alongside `model`
// when the model belongs to a specific provider — otherwise the surface keeps
// its current provider, which can't serve a model from a different one.
export const openChatSeedSchema = z
  .object({
    systemPrompt: z.string().min(1).max(8000),
    name: z.string().min(1).max(80),
    openingPrompt: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
  })
  .strict();
export type OpenChatSeed = z.infer<typeof openChatSeedSchema>;

// A directive a rib's onAction success MAY carry inside `data` to ask the SPA to
// perform a client-side effect. Generic across ribs/actions; `RibActionResult.data`
// stays `unknown` — this is an optional recognized shape, not a narrowing.
// `open-chat` opens a fresh conversation seeded with `seed` (the path the ✦
// "Explore in chat" button uses); `run-workflow` starts a catalog workflow run,
// the same launch path the slash-command run-workflow effect takes. `workflow` is
// an open string (the catalog name / `:name` path segment) — rib-contributed
// names aren't known here; `args` maps onto the run API's `inputs`.
export const ribClientEffectSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("open-chat"), seed: openChatSeedSchema }).strict(),
  z
    .object({
      effect: z.literal("run-workflow"),
      workflow: z.string().min(1),
      args: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
export type RibClientEffect = z.infer<typeof ribClientEffectSchema>;

// An agent a rib offers for direct chat — the cheap descriptor `listAgents`
// returns (no system prompt assembled here). `slug` is slash-safe so it can ride
// a slash command. `resolveAgent(slug)` later builds the full seed.
export const agentSummarySchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric/dash"),
    name: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
  })
  .strict();
export type AgentSummary = z.infer<typeof agentSummarySchema>;

// The aggregated wire shape from GET /api/agents — each summary namespaced
// with its owning rib so the client can route a resolve back and disambiguate a
// slug two ribs both expose.
export const agentRefSchema = agentSummarySchema.extend({ ribId: ribIdSchema }).strict();
export type AgentRef = z.infer<typeof agentRefSchema>;

export const listAgentsResponseSchema = z.object({ agents: z.array(agentRefSchema) }).strict();
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;

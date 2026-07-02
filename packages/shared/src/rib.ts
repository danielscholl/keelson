// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { canvasKindSchema, canvasToneSchema } from "./canvas.ts";
import type { MessageChunk, TokenUsage } from "./chat.ts";

import type { CommandCompletion, CommandInvokeResult, RibCommandDescriptor } from "./commands.ts";
import type { MemoryTools } from "./memory.ts";
import type { Policy } from "./policy.ts";
import type { Project } from "./projects.ts";
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
  // Confinement roots for this turn; absent means unconfined.
  allowedDirectories?: readonly string[];
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
  // The provider's final usage-bearing chunk, coerced. Undefined when the
  // provider never reported one (a text-only stream, or a turn that failed
  // before the stream reached that point).
  usage?: TokenUsage;
}

// A settled dual-handle, NOT a bare AsyncGenerator: `stream` is live progress,
// `result` settles exactly once after the stream completes. `result` is the
// source of truth; the stream is derived from it (full text, then a terminal
// `done`).
export interface RibAgentTurn {
  stream: AsyncIterable<MessageChunk>;
  result: Promise<RibAgentTurnResult>;
}

// The settled result of RibContext.runWorkflow — a structural mirror of the
// executor's run summary, kept local so @keelson/shared stays free of a
// @keelson/workflows dependency (the same rule RibWorkflowContribution.definition
// follows). `nodes` maps each node id to its terminal state + output; `status` is
// the run's terminal status; `error` is set when the run could not start (an invalid
// definition) or failed outright.
export interface RibWorkflowRunResult {
  status: "succeeded" | "failed" | "cancelled";
  nodes: Record<string, { state: string; output: string; error?: string }>;
  error?: string;
}

// A registered provider, surfaced to a rib so it can make provider-aware choices
// (e.g. assign a member's vendor at cast time) without a back-dep on
// @keelson/providers. The minimal shape: the `id` a rib pins on a
// RibAgentTurnRequest, plus a human label.
export interface RibProviderInfo {
  readonly id: string;
  readonly displayName: string;
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
  // Read-only snapshot of the operator's Project records (each carries a validated
  // rootPath) at call time, so a rib can offer project selection and run an agent
  // turn with `cwd = project.rootPath` (pass it as RibAgentTurnRequest.cwd) — the
  // same path-as-context binding chat and workflows use. This is working context,
  // NOT a sandbox: it confines nothing; a turn can still pin any cwd. Optional so a
  // rib built against an older harness degrades to no project selection, not a throw.
  getProjects?: () => readonly Project[];
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
  // Re-run THIS rib's own snapshot-bound producer workflow by name on demand;
  // fresh structured output republishes to the bound key through the same
  // publish->recompose bridge the cadence/heartbeat refresh uses. Resolves
  // (never throws) for an unknown name or a failed run. Optional so a rib built
  // against an older harness degrades to cadence-only refresh, not a throw.
  refreshWorkflow?: (workflowName: string) => Promise<void>;
  // Execute a workflow DAG the rib hands in (an in-memory definition — the same
  // shape `contributeWorkflows` uses), with optional string `inputs`, and resolve to
  // its terminal result. The harness validates the definition against the workflow
  // schema and runs it on the shared executor (provider, memory, and policy gates
  // already wired); `opts.cwd` sets the working dir (e.g. a project root), defaulting
  // to the keelson home. `definition` stays `unknown` at the contract floor so
  // @keelson/shared need not depend on @keelson/workflows. Resolves (never throws)
  // for an invalid definition or a failed run — `status`/`error` carry the outcome.
  // The CALLER owns trusting the definition: a workflow's bash/script nodes run as
  // given. Optional so a rib built against an older harness degrades, not throws.
  runWorkflow?: (
    definition: unknown,
    inputs?: Record<string, string>,
    opts?: { cwd?: string },
  ) => Promise<RibWorkflowRunResult>;
  // Governed-memory handle: recall prior decisions/lessons/work-log rows and write new
  // ones back to the keelson memory ledger — the same `MemoryTools` the workflow
  // executor binds to. recall/writeback are scoped by each request's `scope` (project +
  // visibility); the CALLER owns passing the right scope, the same way runWorkflow's
  // caller owns trusting its definition. The server-side guardrails still hold: a rib's
  // writeback is evidence-default and review-gated — it CANNOT mint an instruction-grade
  // / always-inject row. Optional so a rib built against an older harness degrades to no
  // governed memory (recall it can fold in), not a throw.
  getMemory?: () => MemoryTools;
  // Read-only snapshot of the providers registered at call time, so a rib can make
  // availability-aware provider choices (e.g. assign a member's vendor at cast). This
  // only LISTS what's registered; it grants no access beyond the existing runAgentTurn
  // path, where provider routing is global, not namespace-scoped. Optional so a rib
  // built against an older harness degrades to no provider awareness (it can still pin
  // a provider and let the turn resolve or fail), not a throw.
  getProviders?: () => readonly RibProviderInfo[];
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
// `key` must live under the rib's namespace, like view keys. Header, footer,
// and row-column regions can collapse; only the banner always renders full. `workflow`,
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
    // Section heading for a `group`: the merge stamps the first non-empty
    // groupTitle among a group's regions onto every row that group forms (as the
    // row's `zoneTitle`), so a long index of per-room/per-lens regions renders as
    // a titled zone rather than adjacent ungrouped cards. Inert without `group`.
    groupTitle: z.string().min(1).max(120).optional(),
    // A scope/context line shown beneath the region head's title (e.g. a lens's
    // subject). Distinct from `title` — the lane name — and from the board's own
    // dynamic header.
    byline: z.string().min(1).max(200).optional(),
    // Collapse the region to its head strip. Honored on header/footer and on
    // row-column regions; a banner stays full (see ribSurfaceDescriptorSchema).
    collapsible: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    // Opt-in live-streaming affordance: the region head carries a freshness dot
    // the host pulses while frames arrive over the snapshot WS (streaming is
    // derived from frame cadence, not a rib field) and quiets when they stop.
    // Default off — regions that omit it render unchanged.
    live: z.boolean().optional(),
  })
  .strict();
export type RibSurfaceRegion = z.infer<typeof surfaceRegionSchema>;
// Banner regions never collapse, so a banner can't carry collapse flags even
// though every other slot's region shares the one region schema.
const bannerRegionSchema = surfaceRegionSchema.omit({ collapsible: true, collapsed: true });
export const ribSurfaceDescriptorSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().min(1).max(200).optional(),
    // Opt the surface into the host's first-class project picker: the SPA renders
    // the shared ProjectChip in the surface header and, on select, dispatches the
    // rib's `select-project` action with the chosen project id (or absent for the
    // no-project/shared scope). A rib that owns per-project scope sets this instead
    // of hand-rolling a picker board section. Absent = no host picker (default).
    projectScoped: z.boolean().optional(),
    layout: z
      .object({
        header: surfaceRegionSchema.optional(),
        banner: bannerRegionSchema.optional(),
        // `zoneTitle` labels a run of dynamic rows the merge derives from a
        // group's `groupTitle`; static rows leave it unset.
        rows: z.array(
          z
            .object({
              columns: z.array(surfaceRegionSchema).min(1),
              zoneTitle: z.string().min(1).max(120).optional(),
            })
            .strict(),
        ),
        footer: surfaceRegionSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RibSurfaceDescriptor = z.infer<typeof ribSurfaceDescriptorSchema>;

// Where a rib action came from, stamped by the host. Absent (or "board") is a
// trusted host-UI dispatch — a board button, a loopback API call. "canvas-html"
// marks an action relayed from a sandboxed HTML-canvas iframe, whose markup is
// untrusted (rib- or LLM-authored, and frame script can post on load without a
// gesture); a rib's `onAction` should gate frame-origin verbs to a safe subset.
// The frame cannot forge it: the host reads only `type`/`payload` off the frame
// message and stamps `origin` itself, so a frame can never claim "board".
export const ribActionOriginSchema = z.enum(["board", "canvas-html"]);
export type RibActionOrigin = z.infer<typeof ribActionOriginSchema>;

// Inbound action a rib receives over POST /api/ribs/:id/action. The base never
// enumerates `type` (a rib-defined verb); `payload` stays opaque and the rib
// narrows at its edge. The capability-token envelope + outbound dispatcher are
// not yet wired; today this path is loopback-trusted. `origin` is the one field
// the host owns end-to-end (see ribActionOriginSchema) so a rib can distinguish a
// trusted board action from an untrusted iframe back-channel action.
export const ribActionSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
    origin: ribActionOriginSchema.optional(),
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
// names aren't known here; `args` maps onto the run API's `inputs`. `open-canvas`
// opens the item's snapshot board (`key`) in the canvas drawer — the View verb an
// index card's "Open" uses.
export const ribClientEffectSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("open-chat"), seed: openChatSeedSchema }).strict(),
  z
    .object({
      effect: z.literal("run-workflow"),
      workflow: z.string().min(1),
      args: z.record(z.string(), z.string()).optional(),
      // Launch the run but keep the operator on the current surface instead of
      // focusing the Workflows tab — so a task kicked off from a rib surface can be
      // watched in that surface's own live panel. Absent = focus Workflows (default).
      stay: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      effect: z.literal("open-canvas"),
      key: z.string().min(1),
      title: z.string().optional(),
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

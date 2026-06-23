// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Rib loader.
 *
 * Keelson core ships with no built-in ribs. Operators install `@keelson/rib-*`
 * packages, which `bootstrapRibs()` discovers from `node_modules/@keelson/` at
 * boot. `KEELSON_RIBS=<id>,...` filters which discovered ribs activate; unset
 * means activate all.
 *
 * Callers may pass an explicit `bootstrapRibs({ available })` manifest to
 * bypass discovery — unit tests use this so they stay deterministic with no
 * implicit filesystem walk.
 */

import {
  type AgentSummary,
  type CommandCompletion,
  type CommandInvokeResult,
  type OpenChatSeed,
  type Policy,
  type Rib,
  type RibAction,
  type RibActionResult,
  type RibAgentTurn,
  type RibAgentTurnRequest,
  type RibAuthStatus,
  type RibCommandDescriptor,
  type RibContext,
  type RibSurfaceDescriptor,
  type RibViewDescriptor,
  ribDisplayNameSchema,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
  type SnapshotManager,
  type SnapshotValidator,
  type ToolDefinition,
} from "@keelson/shared";
import type { DynamicRegionStore } from "./dynamic-region-store.ts";
import type { RibPolicyContribution } from "./policy-engine.ts";
import { createScopedSnapshotManager } from "./scoped-snapshot-manager.ts";

export interface RibManifest {
  readonly id: string;
  readonly displayName: string;
  readonly registered: readonly string[];
  readonly views: readonly RibViewDescriptor[];
  readonly surfaces: readonly RibSurfaceDescriptor[];
  readonly hasOnAction: boolean;
}

export interface RibDisposer {
  readonly id: string;
  dispose(): void | Promise<void>;
}

// A workflow a rib contributed at activation. `definition` is still `unknown`
// here — the workflows subsystem narrows it against its schema before merging
// into the catalog. `publish` is wired when `bindSnapshotKey` is present: the
// run path calls it with each structured output to drive the bound key.
export interface RibWorkflowContribution {
  readonly ribId: string;
  readonly definition: unknown;
  readonly bindSnapshotKey?: string;
  readonly publish?: (value: unknown) => void;
}

export interface ApplyRibsResult {
  readonly manifests: RibManifest[];
  readonly disposers: RibDisposer[];
  readonly probes: Map<string, () => Promise<RibAuthStatus>>;
  readonly actionHandlers: Map<string, (action: RibAction) => Promise<RibActionResult>>;
  // Live agent discovery/resolution, keyed by rib id (the GET /api/agents source).
  readonly agentListers: Map<string, () => Promise<readonly AgentSummary[]>>;
  readonly agentResolvers: Map<string, (slug: string) => Promise<OpenChatSeed | null>>;
  // Slash commands keyed by rib id — the GET /api/commands source.
  readonly commandListers: Map<string, () => Promise<readonly RibCommandDescriptor[]>>;
  readonly commandInvokers: Map<
    string,
    (name: string, arg: string) => Promise<CommandInvokeResult>
  >;
  readonly commandCompleters: Map<
    string,
    (name: string, prefix: string) => Promise<readonly CommandCompletion[]>
  >;
  readonly workflowContributions: RibWorkflowContribution[];
  // Policies each active rib contributed (Rib.contributePolicies), tagged with
  // the owning rib id. The composition root folds these into the PolicyEngine.
  readonly policies: RibPolicyContribution[];
  // Validated, de-duplicated tools across every active rib, in activation
  // order. The composition root registers these into the shared tool registry
  // (see `registerRibTools` in bootstrap.ts); `applyRibs` itself stays free of
  // that global side effect so unit tests can run it repeatedly.
  readonly tools: ToolDefinition[];
}

export function parseRibList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ApplyRibsOptions {
  readonly active: readonly string[];
  readonly available: Readonly<Record<string, Rib>>;
  // Template context — supplies `getExec`/`getSidecar`. The per-rib snapshot
  // manager and credential accessor are layered on top of this per rib.
  readonly ctx: RibContext;
  // Optional so test rigs without snapshot infrastructure stay deterministic.
  // When present, each rib gets a namespace-scoped facade and ribs declaring
  // `composeBundle` are auto-registered under `rib:<id>`.
  readonly snapshotManager?: SnapshotManager;
  // Builds a rib's namespaced read-only credential reader. Optional so unit
  // tests without a credential store stay deterministic.
  readonly getRibCredential?: (ribId: string, serviceId: string) => Promise<string | undefined>;
  // Resolves a rib's data directory (RibContext.getDataDir), rooted at the
  // keelson home and namespaced by rib id. Optional so test rigs without a home
  // stay deterministic — an absent resolver leaves getDataDir off the context.
  readonly getRibDataDir?: (ribId: string) => string;
  // Runs one agent turn for a rib. NOT namespace-scoped — provider routing
  // is global; `ribId` is passed for future per-rib policy/logging. Optional so
  // test rigs without a provider/CLI stay deterministic.
  readonly runAgentTurn?: (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn;
  // Backs RibContext.registerRegion so a rib can add surface regions at runtime.
  // Optional so unit tests for applyRibs without a manifest store stay simple.
  readonly dynamicRegionStore?: DynamicRegionStore;
  // Backs RibContext.refreshWorkflow; rib-id-scoped for parity/future per-rib
  // scoping. Optional so unit-test rigs without a controller stay deterministic
  // — absent leaves the seam off the ctx, cadence-only.
  readonly refreshWorkflow?: (ribId: string, workflowName: string) => Promise<void>;
}

/**
 * Apply each active rib's `registerTools` hook against the shared context.
 * Returns one manifest entry per rib that successfully registered.
 *
 * Validation is split by *source* of error:
 * - The `available` map comes from the embedder's code. A malformed key
 *   there is a bug in the rib package or the composition root — throw
 *   eagerly so it surfaces in tests / dev, never silently leave a rib
 *   inactive in production.
 * - The `active` list comes from `KEELSON_RIBS` (operator input). A
 *   typo there is a runtime misconfiguration — warn and skip so a bad
 *   env value can't take the whole server down.
 * - A rib whose self-declared `id` doesn't match its manifest key, or
 *   whose `id` / `displayName` fail the shared schemas, throws — those
 *   are bugs in the rib package itself, not operator misconfiguration.
 * - Duplicate ids throw at the second occurrence — the symmetric-id
 *   invariant protects the tool registry from ambiguous ownership.
 */
export function applyRibs(opts: ApplyRibsOptions): ApplyRibsResult {
  // Eager check on the embedder-supplied map keys. Anything malformed
  // here is a code bug; a thrown error in test/dev is strictly better
  // than a silently inactive rib in production.
  for (const key of Object.keys(opts.available)) {
    const keyCheck = ribIdSchema.safeParse(key);
    if (!keyCheck.success) {
      throw new Error(
        `Rib manifest key '${key}' is invalid: ${keyCheck.error.issues[0]?.message ?? "schema violation"}`,
      );
    }
  }
  const manifests: RibManifest[] = [];
  const disposers: RibDisposer[] = [];
  const probes = new Map<string, () => Promise<RibAuthStatus>>();
  const actionHandlers = new Map<string, (action: RibAction) => Promise<RibActionResult>>();
  const agentListers = new Map<string, () => Promise<readonly AgentSummary[]>>();
  const agentResolvers = new Map<string, (slug: string) => Promise<OpenChatSeed | null>>();
  const commandListers = new Map<string, () => Promise<readonly RibCommandDescriptor[]>>();
  const commandInvokers = new Map<
    string,
    (name: string, arg: string) => Promise<CommandInvokeResult>
  >();
  const commandCompleters = new Map<
    string,
    (name: string, prefix: string) => Promise<readonly CommandCompletion[]>
  >();
  const workflowContributions: RibWorkflowContribution[] = [];
  const policies: RibPolicyContribution[] = [];
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  // Tool names are a single global namespace shared across ribs; track claims
  // so a later rib can't silently shadow an earlier rib's tool.
  const claimedToolNames = new Set<string>();
  for (const id of opts.active) {
    const idCheck = ribIdSchema.safeParse(id);
    if (!idCheck.success) {
      console.warn(
        `[keelson] rib id '${id}' is invalid (${idCheck.error.issues[0]?.message ?? "schema violation"}); skipping`,
      );
      continue;
    }
    const rib = opts.available[id];
    if (!rib) {
      console.warn(`[keelson] rib '${id}' is not in the available manifest`);
      continue;
    }
    // The manifest key is the activation handle; the rib's self-declared
    // id is what the harness records. Catch divergence at the boundary so
    // a renamed export can't masquerade under a stale key.
    if (rib.id !== id) {
      throw new Error(`Rib registered under manifest key '${id}' declares id '${rib.id}'`);
    }
    ribIdSchema.parse(rib.id);
    ribDisplayNameSchema.parse(rib.displayName);
    if (seen.has(rib.id)) {
      throw new Error(`Duplicate rib id '${rib.id}'`);
    }
    seen.add(rib.id);

    // Per-rib context: a namespace-scoped snapshot facade (so a rib can only
    // touch `rib:<id>:*` keys) and a credential reader scoped to this rib.
    const namespace = `rib:${rib.id}`;
    const scoped = opts.snapshotManager
      ? createScopedSnapshotManager(opts.snapshotManager, rib.id)
      : undefined;
    // Validate view + surface descriptors at the activation boundary (the same
    // spot the self-id is checked) so a malformed descriptor fails the rib here,
    // not later inside GET /api/ribs where it would blank a panel. Done BEFORE
    // registerTools so `surfaceIds` is complete when the registerRegion seam is
    // bound below — a rib may then add a region to any surface it declares,
    // whether synchronously in registerTools or later at runtime.
    const views = rib.views ?? [];
    for (const view of views) {
      ribViewDescriptorSchema.parse(view);
      assertInNamespace(rib.id, namespace, view.key, "view key");
    }
    const surfaceIds = new Set<string>();
    const surfaces = rib.surfaces ?? [];
    for (const surface of surfaces) {
      ribSurfaceDescriptorSchema.parse(surface);
      if (surfaceIds.has(surface.id)) {
        throw new Error(`rib '${rib.id}' declares duplicate surface id '${surface.id}'`);
      }
      surfaceIds.add(surface.id);
      for (const region of allRegions(surface.layout)) {
        assertInNamespace(rib.id, namespace, region.key, "surface region key");
      }
    }

    const ribCtx: RibContext = {
      ...opts.ctx,
      ...(scoped ? { getSnapshotManager: () => scoped } : {}),
      ...(opts.getRibCredential
        ? { getCredential: (serviceId) => opts.getRibCredential!(rib.id, serviceId) }
        : {}),
      ...(opts.getRibDataDir ? { getDataDir: () => opts.getRibDataDir!(rib.id) } : {}),
      ...(opts.runAgentTurn ? { runAgentTurn: (req) => opts.runAgentTurn!(rib.id, req) } : {}),
      ...(opts.dynamicRegionStore
        ? { registerRegion: opts.dynamicRegionStore.registerForRib(rib.id, surfaceIds) }
        : {}),
      ...(opts.refreshWorkflow
        ? { refreshWorkflow: (workflowName: string) => opts.refreshWorkflow!(rib.id, workflowName) }
        : {}),
    };

    const ribToolNames = collectRibTools(
      rib.id,
      rib.registerTools?.(ribCtx),
      claimedToolNames,
      tools,
    );

    manifests.push({
      id: rib.id,
      displayName: rib.displayName,
      // Names of the tools that survived validation + de-dup, for GET /api/ribs.
      registered: ribToolNames,
      views,
      surfaces,
      hasOnAction: typeof rib.onAction === "function",
    });

    if (rib.authStatus) {
      const probe = rib.authStatus.bind(rib);
      probes.set(rib.id, () => Promise.resolve(probe(ribCtx)));
    }
    if (rib.onAction) {
      const handler = rib.onAction.bind(rib);
      actionHandlers.set(rib.id, (action) => Promise.resolve(handler(action, ribCtx)));
    }
    if (rib.listAgents) {
      const lister = rib.listAgents.bind(rib);
      agentListers.set(rib.id, () => Promise.resolve(lister(ribCtx)));
    }
    if (rib.resolveAgent) {
      const resolver = rib.resolveAgent.bind(rib);
      agentResolvers.set(rib.id, (slug) => Promise.resolve(resolver(slug, ribCtx)));
    }
    if (rib.listCommands) {
      const lister = rib.listCommands.bind(rib);
      commandListers.set(rib.id, () => Promise.resolve(lister(ribCtx)));
    }
    if (rib.invokeCommand) {
      const invoker = rib.invokeCommand.bind(rib);
      commandInvokers.set(rib.id, (name, arg) => Promise.resolve(invoker(name, arg, ribCtx)));
    }
    if (rib.completeCommand) {
      const completer = rib.completeCommand.bind(rib);
      commandCompleters.set(rib.id, (name, prefix) =>
        Promise.resolve(completer(name, prefix, ribCtx)),
      );
    }

    // Auto-register the rib's composeBundle (if any) under `rib:<id>`. The
    // base manager's `dispose()` clears every registration on shutdown, so we
    // don't track the handle here. Ribs that want multiple snapshots call
    // `ctx.getSnapshotManager?.().register("rib:<id>:…", …)` from registerTools.
    if (rib.composeBundle && scoped) {
      scoped.register(namespace, () => rib.composeBundle!(ribCtx));
    }

    if (rib.contributeWorkflows) {
      for (const contribution of rib.contributeWorkflows(ribCtx)) {
        const bindKey = contribution.bindSnapshotKey;
        let publish: ((value: unknown) => void) | undefined;
        if (bindKey !== undefined && scoped) {
          assertInNamespace(rib.id, namespace, bindKey, "bound snapshot key");
          // Register the bound key once at activation with a mutable holder;
          // the run path updates the holder + recomposes. Registering per-run
          // would trip the duplicate-key guard, and the rib-owned key should
          // outlive any single run so the canvas keeps the last value.
          let latest: unknown;
          scoped.register(bindKey, () => latest, {
            ...(contribution.validate
              ? { validate: contribution.validate as SnapshotValidator<unknown> }
              : {}),
          });
          // The manager coalesces concurrent recomposes, so a publish that
          // arrives while one is in flight would otherwise be swallowed (the
          // shared compose already read the prior `latest`). Pump serially and
          // re-run when a publish landed mid-flight, so the final value is the
          // one that's broadcast.
          let recomposing = false;
          let dirty = false;
          const pump = async (): Promise<void> => {
            if (recomposing) {
              dirty = true;
              return;
            }
            recomposing = true;
            try {
              do {
                dirty = false;
                await scoped.recompose(bindKey);
              } while (dirty);
            } finally {
              recomposing = false;
            }
          };
          publish = (value: unknown): void => {
            latest = value;
            void pump();
          };
        }
        workflowContributions.push({
          ribId: rib.id,
          definition: contribution.definition,
          ...(bindKey !== undefined ? { bindSnapshotKey: bindKey } : {}),
          ...(publish ? { publish } : {}),
        });
      }
    }

    if (rib.contributePolicies) {
      // Defensive like collectRibTools: a non-array return (or a malformed
      // entry) warns and is dropped rather than throwing, so one rib's bug can't
      // take the server down at boot.
      const contributed = rib.contributePolicies(ribCtx);
      if (!Array.isArray(contributed)) {
        console.warn(
          `[keelson] rib '${rib.id}' contributePolicies did not return an array; ignoring`,
        );
      } else {
        for (const policy of contributed) {
          if (!isPolicy(policy)) {
            console.warn(`[keelson] rib '${rib.id}' contributed a malformed policy; skipping`);
            continue;
          }
          policies.push({ ribId: rib.id, policy });
        }
      }
    }

    if (rib.dispose) {
      disposers.push({ id: rib.id, dispose: rib.dispose.bind(rib) });
    }
  }
  return {
    manifests,
    disposers,
    probes,
    actionHandlers,
    agentListers,
    agentResolvers,
    commandListers,
    commandInvokers,
    commandCompleters,
    workflowContributions,
    policies,
    tools,
  };
}

// Narrow a rib's `registerTools` return into validated, non-colliding tools.
// Defensive by design: a malformed entry or a non-array result warns and is
// dropped rather than throwing, so one rib's bug can't take the server down or
// blank GET /api/ribs. Pushes accepted tools onto `collected` and returns their
// names (for the rib manifest), claiming each in the shared `claimed` set.
function collectRibTools(
  ribId: string,
  raw: unknown,
  claimed: Set<string>,
  collected: ToolDefinition[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn(`[keelson] rib '${ribId}' registerTools did not return an array; ignoring`);
    return [];
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (!isToolDefinition(entry)) {
      console.warn(`[keelson] rib '${ribId}' returned a malformed tool; skipping`);
      continue;
    }
    if (claimed.has(entry.name)) {
      console.warn(
        `[keelson] rib '${ribId}' tool '${entry.name}' collides with an already-registered tool; skipping`,
      );
      continue;
    }
    claimed.add(entry.name);
    collected.push(entry);
    names.push(entry.name);
  }
  return names;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  // inputSchema must be a zod schema — the provider adapters call
  // `z.toJSONSchema()` / read its `.shape`, which throws on a plain object and
  // would take down the whole agent turn rather than skipping one bad rib here.
  const schema = t.inputSchema as { safeParse?: unknown } | null | undefined;
  // Advisory flags reach /api/tools verbatim (registeredToolInfoSchema parses
  // them as booleans); a non-boolean would 500 the tools panel for every tool.
  return (
    typeof t.name === "string" &&
    t.name.length > 0 &&
    typeof t.description === "string" &&
    typeof t.execute === "function" &&
    schema != null &&
    typeof schema.safeParse === "function" &&
    (t.state_changing === undefined || typeof t.state_changing === "boolean") &&
    (t.requires_confirmation === undefined || typeof t.requires_confirmation === "boolean")
  );
}

// A contributed policy is usable if it has a non-empty string id, an `evaluate`
// function, and — when present — an `on` that is a NON-EMPTY array of matcher
// objects whose `phase` is a string and whose optional `tool` is a string.
// Validating `on` here is load-bearing: the engine dereferences
// `policy.on.some((m) => m.phase ...)` and compares `m.tool`, so a malformed
// `on` (a bare string, an entry without a phase) would throw, and an empty array
// or a non-string `tool` would make the policy a silently-dead matcher. Mirrors
// isToolDefinition's defensive narrowing at the activation boundary.
function isPolicy(value: unknown): value is Policy {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0 || typeof p.evaluate !== "function") {
    return false;
  }
  if (p.on === undefined) return true;
  if (!Array.isArray(p.on) || p.on.length === 0) return false;
  return p.on.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const entry = m as { phase?: unknown; tool?: unknown };
    return (
      typeof entry.phase === "string" &&
      (entry.tool === undefined || typeof entry.tool === "string")
    );
  });
}

function assertInNamespace(ribId: string, namespace: string, key: string, label: string): void {
  if (key !== namespace && !key.startsWith(`${namespace}:`)) {
    throw new Error(`rib '${ribId}' ${label} '${key}' must be under '${namespace}:*'`);
  }
}

// Every region of a surface layout, in render order (header, banner, row
// columns, footer). The namespace check and the heartbeat scheduler share this
// one walk so a region slot can't be honored by one and skipped by the other.
export function allRegions(
  layout: RibSurfaceDescriptor["layout"],
): readonly { key: string; workflow?: string; cadenceMs?: number }[] {
  const { header, banner, rows, footer } = layout;
  return [
    ...(header ? [header] : []),
    ...(banner ? [banner] : []),
    ...rows.flatMap((row) => row.columns),
    ...(footer ? [footer] : []),
  ];
}

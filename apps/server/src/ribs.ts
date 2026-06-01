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
  type Rib,
  type RibAction,
  type RibActionDescriptor,
  type RibActionResult,
  type RibAuthStatus,
  type RibContext,
  type RibViewDescriptor,
  ribActionDescriptorSchema,
  ribDisplayNameSchema,
  ribIdSchema,
  ribViewDescriptorSchema,
  type SnapshotManager,
  type SnapshotValidator,
} from "@keelson/shared";
import { createScopedSnapshotManager } from "./scoped-snapshot-manager.ts";

export interface RibManifest {
  readonly id: string;
  readonly displayName: string;
  readonly registered: readonly string[];
  readonly views: readonly RibViewDescriptor[];
  readonly actions: readonly RibActionDescriptor[];
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
  readonly workflowContributions: RibWorkflowContribution[];
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
  const workflowContributions: RibWorkflowContribution[] = [];
  const seen = new Set<string>();
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
    const ribCtx: RibContext = {
      ...opts.ctx,
      ...(scoped ? { getSnapshotManager: () => scoped } : {}),
      ...(opts.getRibCredential
        ? { getCredential: (serviceId) => opts.getRibCredential!(rib.id, serviceId) }
        : {}),
    };

    const result = rib.registerTools?.(ribCtx);

    // Validate view + action descriptors at the activation boundary (the same
    // spot the self-id is checked) so a malformed descriptor fails the rib
    // here, not later inside GET /api/ribs where it would blank the panel.
    const views = rib.views ?? [];
    for (const view of views) {
      ribViewDescriptorSchema.parse(view);
      assertInNamespace(rib.id, namespace, view.key, "view key");
    }
    const actions = rib.actions ?? [];
    for (const action of actions) {
      ribActionDescriptorSchema.parse(action);
    }
    manifests.push({
      id: rib.id,
      displayName: rib.displayName,
      // Sanitize at the boundary: a JS rib could return a non-array `registered`
      // (which would throw here) or non-string entries (which would later throw
      // in GET /api/ribs' listRibsResponseSchema.parse and blank the panel).
      // Coerce to a string-only array.
      registered: Array.isArray(result?.registered)
        ? result.registered.filter((t): t is string => typeof t === "string")
        : [],
      views,
      actions,
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

    if (rib.dispose) {
      disposers.push({ id: rib.id, dispose: rib.dispose.bind(rib) });
    }
  }
  return { manifests, disposers, probes, actionHandlers, workflowContributions };
}

function assertInNamespace(ribId: string, namespace: string, key: string, label: string): void {
  if (key !== namespace && !key.startsWith(`${namespace}:`)) {
    throw new Error(`rib '${ribId}' ${label} '${key}' must be under '${namespace}:*'`);
  }
}

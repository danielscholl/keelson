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
 * Keelson core ships with no built-in ribs. Operators bring ribs in by
 * importing `@keelson/rib-<id>` packages at the composition root and
 * passing them to `bootstrapRibs({ available })`. `KEELSON_RIBS=<id>,...`
 * filters which manifest entries activate; unset means activate all.
 *
 * Dynamic discovery from `node_modules/@keelson/rib-*` is reserved for a
 * follow-up release. v0.1 takes the manifest from the caller so unit
 * tests stay deterministic and there's no implicit filesystem walk.
 */

import {
  ribDisplayNameSchema,
  ribIdSchema,
  type Rib,
  type RibContext,
} from "@keelson/shared";

export interface RibManifest {
  readonly id: string;
  readonly displayName: string;
  readonly registered: readonly string[];
}

export interface RibDisposer {
  readonly id: string;
  dispose(): void;
}

export interface ApplyRibsResult {
  readonly manifests: RibManifest[];
  readonly disposers: RibDisposer[];
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
  readonly ctx: RibContext;
}

/**
 * Apply each active rib's `registerTools` hook against the shared context.
 * Returns one manifest entry per rib that successfully registered.
 *
 * - Ids that fail `ribIdSchema` (lowercase kebab-case, ≤64 chars) are
 *   rejected with a warning so a typo in `KEELSON_RIBS` never silently
 *   matches a malformed manifest key.
 * - Unknown ids in `active` produce a console.warn and are skipped.
 * - A rib whose self-declared `id` doesn't match its manifest key, or
 *   whose `id` / `displayName` fail the shared schemas, throws — those
 *   are bugs in the rib package itself, not operator misconfiguration.
 * - Duplicate ids throw at the second occurrence — the symmetric-id
 *   invariant protects the tool registry from ambiguous ownership.
 */
export function applyRibs(opts: ApplyRibsOptions): ApplyRibsResult {
  const manifests: RibManifest[] = [];
  const disposers: RibDisposer[] = [];
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
      throw new Error(
        `Rib registered under manifest key '${id}' declares id '${rib.id}'`,
      );
    }
    ribIdSchema.parse(rib.id);
    ribDisplayNameSchema.parse(rib.displayName);
    if (seen.has(rib.id)) {
      throw new Error(`Duplicate rib id '${rib.id}'`);
    }
    seen.add(rib.id);
    const result = rib.registerTools?.(opts.ctx);
    manifests.push({
      id: rib.id,
      displayName: rib.displayName,
      registered: result?.registered ?? [],
    });
    if (rib.dispose) {
      disposers.push({ id: rib.id, dispose: rib.dispose.bind(rib) });
    }
  }
  return { manifests, disposers };
}

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
 * setting `KEELSON_RIBS=cimpl,osdu,...` and providing a manifest that
 * resolves each id to a `Rib` implementation (typically: an npm package
 * named `@keelson/rib-<id>` imported at the embedding site).
 *
 * Dynamic discovery from `node_modules/@keelson/rib-*` is reserved for a
 * follow-up release. v0 takes the manifest from the caller so unit tests
 * stay deterministic and there's no implicit filesystem walk.
 */

import type { Rib, RibContext } from "@keelson/shared";

export interface RibManifest {
  readonly id: string;
  readonly displayName: string;
  readonly registered: readonly string[];
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
 * - Unknown ids in `active` produce a console.warn and are skipped.
 * - Duplicate ids throw at the second occurrence — the symmetric-id
 *   invariant protects the tool registry from ambiguous ownership.
 */
export function applyRibs(opts: ApplyRibsOptions): RibManifest[] {
  const manifests: RibManifest[] = [];
  const seen = new Set<string>();
  for (const id of opts.active) {
    const rib = opts.available[id];
    if (!rib) {
      console.warn(`[keelson] rib '${id}' is not in the available manifest`);
      continue;
    }
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
  }
  return manifests;
}

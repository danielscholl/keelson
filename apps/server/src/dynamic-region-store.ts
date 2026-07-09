// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type RibSurfaceDescriptor,
  type RibSurfaceRegion,
  surfaceRegionSchema,
} from "@keelson/shared";

// Backs RibContext.registerRegion: a mutable layer of runtime-added surface
// regions the GET /api/ribs handler merges onto each rib's static boot manifest.
// The data plane (snapshot keys) is owned by the rib; this store owns only the
// LAYOUT — which regions render, in what order, on which surface.

// Safety ceiling on runtime regions per (rib, surface): a runaway rib can't bloat
// every /api/ribs response. Not a product limit — real walls sit far below it.
const MAX_REGIONS_PER_SURFACE = 256;

// Columns per merged row. The SPA renders rows of fixed-width columns, so dynamic
// regions chunk into rows of this width (per group) appended after static rows.
export const DEFAULT_REGION_ROW_WIDTH = 3;

export interface DynamicRegionStore {
  // Returns the per-rib seam bound into RibContext.registerRegion. `declaredSurfaceIds`
  // is captured by reference: applyRibs populates it as it validates the rib's
  // surfaces (before any tool runs), so the seam — only ever called at runtime —
  // sees the rib's full surface set regardless of declaration order.
  registerForRib(
    ribId: string,
    declaredSurfaceIds: ReadonlySet<string>,
  ): (surfaceId: string, region: RibSurfaceRegion) => () => void;
  regionsFor(ribId: string, surfaceId: string): readonly RibSurfaceRegion[];
  // Whether any live runtime region (any rib, any surface) declares this
  // workflow as its refresh producer — one leg of the `/refresh` route's
  // region-declared gate (the other walks the static manifests).
  hasRegionWorkflow(workflowName: string): boolean;
  readonly revision: number;
}

export function createDynamicRegionStore(opts: { onChange: () => void }): DynamicRegionStore {
  // ribId -> surfaceId -> regions in insertion order (never sorted, so a surviving
  // region keeps its row/column coordinate across adds and the SPA never remounts
  // an existing panel when a new one registers).
  const byRib = new Map<string, Map<string, RibSurfaceRegion[]>>();
  let revision = 0;

  const surfaceBucket = (ribId: string, surfaceId: string): RibSurfaceRegion[] => {
    let surfaces = byRib.get(ribId);
    if (!surfaces) {
      surfaces = new Map();
      byRib.set(ribId, surfaces);
    }
    let regions = surfaces.get(surfaceId);
    if (!regions) {
      regions = [];
      surfaces.set(surfaceId, regions);
    }
    return regions;
  };

  return {
    registerForRib(ribId, declaredSurfaceIds) {
      const namespace = `rib:${ribId}`;
      return (surfaceId, region) => {
        // Same namespace gate the static path applies (applyRibs / assertInNamespace):
        // a rib may only add regions keyed under its own namespace.
        if (region.key !== namespace && !region.key.startsWith(`${namespace}:`)) {
          throw new Error(
            `rib '${ribId}' surface region key '${region.key}' must be under '${namespace}:*'`,
          );
        }
        if (!declaredSurfaceIds.has(surfaceId)) {
          throw new Error(
            `rib '${ribId}' cannot add a region to undeclared surface '${surfaceId}'`,
          );
        }
        // Validate once here so the per-request merge is a pure concat. `.strict()`
        // rejects stray fields; `.parse` throws, failing the rib's call loudly.
        const parsed = surfaceRegionSchema.parse(region);
        const regions = surfaceBucket(ribId, surfaceId);
        if (regions.some((r) => r.key === parsed.key)) {
          throw new Error(
            `rib '${ribId}' already registered region '${parsed.key}' on surface '${surfaceId}'`,
          );
        }
        if (regions.length >= MAX_REGIONS_PER_SURFACE) {
          throw new Error(
            `rib '${ribId}' exceeded the ${MAX_REGIONS_PER_SURFACE}-region limit on surface '${surfaceId}'`,
          );
        }
        regions.push(parsed);
        revision += 1;
        opts.onChange();

        let active = true;
        return () => {
          if (!active) return;
          active = false;
          const idx = regions.indexOf(parsed);
          if (idx >= 0) regions.splice(idx, 1);
          revision += 1;
          opts.onChange();
        };
      };
    },
    regionsFor(ribId, surfaceId) {
      return byRib.get(ribId)?.get(surfaceId) ?? [];
    },
    hasRegionWorkflow(workflowName) {
      for (const surfaces of byRib.values()) {
        for (const regions of surfaces.values()) {
          if (regions.some((r) => r.workflow === workflowName)) return true;
        }
      }
      return false;
    },
    get revision() {
      return revision;
    },
  };
}

// Append a surface's runtime regions to its static layout as extra rows of up to
// `width` columns, grouped so each producer's regions stay contiguous. Pure and
// append-only — a surviving region keeps its (row, column) coordinate across
// adds. Returns the surface unchanged when there are no dynamic regions.
export function mergeSurfaceRegions(
  surface: RibSurfaceDescriptor,
  dynamicRegions: readonly RibSurfaceRegion[],
  width: number = DEFAULT_REGION_ROW_WIDTH,
): RibSurfaceDescriptor {
  if (dynamicRegions.length === 0) return surface;
  // Clamp so a non-positive width can't spin the chunk loop forever.
  const step = width >= 1 ? Math.floor(width) : DEFAULT_REGION_ROW_WIDTH;
  const extraRows: { columns: RibSurfaceRegion[]; zoneTitle?: string }[] = [];
  for (const group of groupInOrder(dynamicRegions)) {
    // First groupTitle among the group's regions titles every row it forms, so a
    // group's rows render under one zone header even when chunked. A groupTitle on
    // an ungrouped region is inert (it has no zone), matching the rib.ts schema.
    const zoneTitle = group.find((r) => r.group !== undefined && r.groupTitle)?.groupTitle;
    for (let i = 0; i < group.length; i += step) {
      extraRows.push({
        columns: group.slice(i, i + step),
        ...(zoneTitle ? { zoneTitle } : {}),
      });
    }
  }
  return {
    ...surface,
    layout: { ...surface.layout, rows: [...surface.layout.rows, ...extraRows] },
  };
}

// Cluster regions by `group`, preserving first-seen group order and insertion
// order within each group; ungrouped regions form a trailing group. Never emits
// an empty group, so the chunker above never produces an empty `columns` row.
function groupInOrder(regions: readonly RibSurfaceRegion[]): RibSurfaceRegion[][] {
  const groups = new Map<string, RibSurfaceRegion[]>();
  const ungrouped: RibSurfaceRegion[] = [];
  for (const region of regions) {
    if (region.group === undefined) {
      ungrouped.push(region);
      continue;
    }
    let bucket = groups.get(region.group);
    if (!bucket) {
      bucket = [];
      groups.set(region.group, bucket);
    }
    bucket.push(region);
  }
  const ordered = [...groups.values()];
  if (ungrouped.length > 0) ordered.push(ungrouped);
  return ordered;
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { RibSurfaceDescriptor, RibSurfaceRegion } from "@keelson/shared";
import { createDynamicRegionStore, mergeSurfaceRegions } from "../src/dynamic-region-store.ts";

function surface(rows: { columns: RibSurfaceRegion[] }[]): RibSurfaceDescriptor {
  return { id: "main", title: "Main", layout: { rows } };
}
const staticRow = { columns: [{ key: "rib:x:base" }] };

describe("DynamicRegionStore.registerForRib", () => {
  test("registers a region under a declared surface and reads it back", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    register("main", { key: "rib:x:lens:a", title: "A" });
    expect(store.regionsFor("x", "main").map((r) => r.key)).toEqual(["rib:x:lens:a"]);
  });

  test("rejects a key outside the rib's namespace", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    expect(() => register("main", { key: "rib:other:lens:a" })).toThrow(/must be under/);
  });

  test("rejects an undeclared surface id", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    expect(() => register("nope", { key: "rib:x:lens:a" })).toThrow(/undeclared surface/);
  });

  test("rejects a malformed region (strict schema)", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    expect(() =>
      register("main", { key: "rib:x:lens:a", bogus: true } as unknown as RibSurfaceRegion),
    ).toThrow();
  });

  test("rejects a duplicate region key on the same surface", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    register("main", { key: "rib:x:lens:a" });
    expect(() => register("main", { key: "rib:x:lens:a" })).toThrow(/already registered/);
  });

  test("enforces the per-surface ceiling", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    for (let i = 0; i < 256; i++) register("main", { key: `rib:x:lens:${i}` });
    expect(() => register("main", { key: "rib:x:lens:over" })).toThrow(/limit/);
  });

  test("unregister removes the region, leaving siblings in place", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const register = store.registerForRib("x", new Set(["main"]));
    register("main", { key: "rib:x:lens:a" });
    const off = register("main", { key: "rib:x:lens:b" });
    register("main", { key: "rib:x:lens:c" });
    off();
    expect(store.regionsFor("x", "main").map((r) => r.key)).toEqual([
      "rib:x:lens:a",
      "rib:x:lens:c",
    ]);
  });

  test("hasRegionWorkflow sees live regions across ribs and forgets removed ones", () => {
    const store = createDynamicRegionStore({ onChange: () => {} });
    const registerX = store.registerForRib("x", new Set(["main"]));
    const registerY = store.registerForRib("y", new Set(["main"]));
    expect(store.hasRegionWorkflow("re-author")).toBe(false);
    registerX("main", { key: "rib:x:lens:a" });
    const off = registerY("main", {
      key: "rib:y:lens:b",
      workflow: "re-author",
      workflowArgs: { lens: "b" },
    });
    expect(store.hasRegionWorkflow("re-author")).toBe(true);
    off();
    expect(store.hasRegionWorkflow("re-author")).toBe(false);
  });

  test("bumps revision and calls onChange on add and remove, once each", () => {
    let changes = 0;
    const store = createDynamicRegionStore({ onChange: () => changes++ });
    const register = store.registerForRib("x", new Set(["main"]));
    expect(store.revision).toBe(0);
    const off = register("main", { key: "rib:x:lens:a" });
    expect(store.revision).toBe(1);
    off();
    expect(store.revision).toBe(2);
    off(); // idempotent: no further bump
    expect(store.revision).toBe(2);
    expect(changes).toBe(2);
  });
});

describe("mergeSurfaceRegions", () => {
  const r = (key: string, group?: string): RibSurfaceRegion => ({
    key,
    ...(group ? { group } : {}),
  });

  test("returns the surface unchanged when there are no dynamic regions", () => {
    const s = surface([staticRow]);
    expect(mergeSurfaceRegions(s, [])).toBe(s);
  });

  test("appends dynamic regions as rows of width after the static rows", () => {
    const merged = mergeSurfaceRegions(surface([staticRow]), [r("a"), r("b"), r("c"), r("d")], 3);
    expect(merged.layout.rows.map((row) => row.columns.map((c) => c.key))).toEqual([
      ["rib:x:base"],
      ["a", "b", "c"],
      ["d"],
    ]);
  });

  test("emits no empty trailing row when the count is an exact multiple of width", () => {
    const merged = mergeSurfaceRegions(surface([staticRow]), [r("a"), r("b"), r("c")], 3);
    expect(merged.layout.rows).toHaveLength(2);
    expect(merged.layout.rows.every((row) => row.columns.length >= 1)).toBe(true);
  });

  test("keeps groups contiguous instead of interleaving by arrival order", () => {
    const merged = mergeSurfaceRegions(
      surface([staticRow]),
      [r("a", "lens"), r("x", "room"), r("b", "lens"), r("y", "room")],
      3,
    );
    expect(merged.layout.rows.slice(1).map((row) => row.columns.map((c) => c.key))).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });

  test("is position-stable across an append (no remount of surviving panels)", () => {
    const before = mergeSurfaceRegions(surface([staticRow]), [r("a"), r("b"), r("c")], 3);
    const after = mergeSurfaceRegions(surface([staticRow]), [r("a"), r("b"), r("c"), r("d")], 3);
    expect(after.layout.rows[1]).toEqual(before.layout.rows[1]);
  });

  test("stamps a group's first non-empty groupTitle onto every row that group forms", () => {
    const merged = mergeSurfaceRegions(
      surface([staticRow]),
      [
        { key: "r1", group: "rooms", groupTitle: "Rooms" },
        { key: "r2", group: "rooms" },
        { key: "r3", group: "rooms" },
        { key: "r4", group: "rooms" },
        { key: "l1", group: "lens", groupTitle: "Lenses" },
      ],
      3,
    );
    // Static row carries no zoneTitle; both Rooms rows do; the Lenses row does.
    expect(merged.layout.rows.map((row) => row.zoneTitle)).toEqual([
      undefined,
      "Rooms",
      "Rooms",
      "Lenses",
    ]);
  });

  test("leaves zoneTitle unset for a group whose regions declare no groupTitle", () => {
    const merged = mergeSurfaceRegions(surface([staticRow]), [r("a", "rooms"), r("b", "rooms")], 3);
    expect(merged.layout.rows[1]?.zoneTitle).toBeUndefined();
  });

  test("a groupTitle on an ungrouped region is inert (no zoneTitle on the ungrouped row)", () => {
    const merged = mergeSurfaceRegions(
      surface([staticRow]),
      [{ key: "stray", groupTitle: "Phantom" }, r("b", "rooms")],
      3,
    );
    // The ungrouped 'stray' must not stamp its groupTitle onto the ungrouped row.
    const ungroupedRow = merged.layout.rows.find((row) =>
      row.columns.some((c) => c.key === "stray"),
    );
    expect(ungroupedRow?.zoneTitle).toBeUndefined();
  });
});

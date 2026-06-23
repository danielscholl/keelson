// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { createScopedSnapshotManager } from "../src/scoped-snapshot-manager.ts";
import { createSnapshotManager } from "../src/snapshot-manager.ts";

describe("createScopedSnapshotManager", () => {
  test("allows registering keys under the rib namespace", () => {
    const base = createSnapshotManager();
    const scoped = createScopedSnapshotManager(base, "osdu");
    scoped.register("rib:osdu", () => ({ a: 1 }));
    scoped.register("rib:osdu:graph", () => ({ b: 2 }));
    expect(base.keys().sort()).toEqual(["rib:osdu", "rib:osdu:graph"]);
  });

  test("rejects keys outside the rib namespace", () => {
    const base = createSnapshotManager();
    const scoped = createScopedSnapshotManager(base, "osdu");
    expect(() => scoped.register("other", () => ({}))).toThrow(/may only register/);
    expect(() => scoped.register("rib:other:x", () => ({}))).toThrow(/may only register/);
    expect(() => scoped.register("rib:osduX", () => ({}))).toThrow(/may only register/);
    expect(base.keys()).toEqual([]);
  });

  test("maps the bare rib id onto the namespaced root for register/recompose/latest", async () => {
    const base = createSnapshotManager();
    const scoped = createScopedSnapshotManager(base, "osdu");
    scoped.register("osdu", () => ({ generation: 1 }));
    // Registered under the namespaced key on the base manager.
    expect(base.keys()).toEqual(["rib:osdu"]);
    // Both the bare id and the namespaced key resolve to the same composer.
    expect((await scoped.recompose("osdu"))?.data).toEqual({ generation: 1 });
    expect((await scoped.recompose("rib:osdu"))?.data).toEqual({ generation: 1 });
    expect(scoped.latest("osdu")?.data).toEqual({ generation: 1 });
  });

  test("recompose/latest of an out-of-namespace key resolve to nothing", async () => {
    const base = createSnapshotManager();
    base.register("workflow:run:abc", () => ({ secret: true }));
    base.register("rib:other:x", () => ({ secret: true }));
    await base.recompose("workflow:run:abc");
    await base.recompose("rib:other:x");
    const scoped = createScopedSnapshotManager(base, "osdu");
    // A guessed run-scoped or foreign-rib key never leaks through the facade.
    expect(scoped.latest("workflow:run:abc")).toBeUndefined();
    expect(scoped.latest("rib:other:x")).toBeUndefined();
    expect(await scoped.recompose("workflow:run:abc")).toBeUndefined();
    expect(await scoped.recompose("rib:other:x")).toBeUndefined();
    // The base manager still serves those keys to a trusted caller.
    expect(base.latest("workflow:run:abc")?.data).toEqual({ secret: true });
  });

  test("keys() exposes only the rib's own namespace", () => {
    const base = createSnapshotManager();
    base.register("workflow:run:abc", () => ({}));
    base.register("rib:other:x", () => ({}));
    const scoped = createScopedSnapshotManager(base, "osdu");
    scoped.register("rib:osdu:graph", () => ({}));
    expect(scoped.keys()).toEqual(["rib:osdu:graph"]);
    expect(base.keys().length).toBe(3);
  });

  test("dispose releases the rib's handles but never the base manager", async () => {
    const base = createSnapshotManager();
    base.register("workflow:run:abc", () => ({ live: true }));
    const scoped = createScopedSnapshotManager(base, "osdu");
    scoped.register("rib:osdu:graph", () => ({}));
    await scoped.dispose();
    // The rib's key is gone; the base manager and its other keys still work.
    expect(base.keys()).toEqual(["workflow:run:abc"]);
    expect((await base.recompose("workflow:run:abc"))?.data).toEqual({ live: true });
  });

  test("register after dispose throws and never reaches the base manager", async () => {
    const base = createSnapshotManager();
    const scoped = createScopedSnapshotManager(base, "osdu");
    await scoped.dispose();
    // A late closure held by a torn-down rib must not register a fresh key.
    expect(() => scoped.register("rib:osdu:late", () => ({}))).toThrow(/disposed/);
    expect(base.keys()).toEqual([]);
    expect(await scoped.recompose("rib:osdu:late")).toBeUndefined();
  });
});

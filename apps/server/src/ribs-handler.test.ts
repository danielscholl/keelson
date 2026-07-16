// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { RibSurfaceDescriptor, RibViewDescriptor } from "@keelson/shared";
import type { RibManifest } from "./ribs.ts";
import { ownedSurfaces, ownedViews } from "./ribs-handler.ts";

function manifest(over: Partial<RibManifest> = {}): RibManifest {
  return {
    id: "chamber",
    displayName: "Chamber",
    registered: [],
    views: [],
    surfaces: [],
    hasOnAction: false,
    acceptsIngest: false,
    ...over,
  };
}

function surface(id: string, regionKey: string): RibSurfaceDescriptor {
  return {
    id,
    title: id,
    layout: { rows: [{ columns: [{ key: regionKey }] }] },
  } as RibSurfaceDescriptor;
}

// applyRibs parses and ownership-checks these arrays once, at activation. A rib may hold
// them live and mutate them afterwards (the contract's live-descriptor pattern), and the
// manifest is served from those same arrays — so the check has to run again here or a
// post-boot push would be served unvalidated.
describe("GET /api/ribs — descriptor ownership is re-checked per request", () => {
  it("serves a rib's own views", () => {
    const views: RibViewDescriptor[] = [
      { key: "rib:chamber:presence", canvasKind: "view" },
      // The namespace itself, not only a child of it.
      { key: "rib:chamber", canvasKind: "view" },
    ];
    expect(ownedViews(manifest({ views })).map((v) => v.key)).toEqual([
      "rib:chamber:presence",
      "rib:chamber",
    ]);
  });

  it("drops a view pushed for another rib's namespace", () => {
    const views: RibViewDescriptor[] = [
      { key: "rib:chamber:presence", canvasKind: "view" },
      { key: "rib:squad:roster", canvasKind: "view" },
      // A prefix that merely starts with the namespace string is not under it.
      { key: "rib:chamberlain:sneaky", canvasKind: "view" },
    ];
    expect(ownedViews(manifest({ views })).map((v) => v.key)).toEqual(["rib:chamber:presence"]);
  });

  it("drops a malformed view rather than letting it throw the response parse", () => {
    const views = [
      { key: "rib:chamber:presence", canvasKind: "view" },
      { key: "rib:chamber:bad", canvasKind: "not-a-kind" },
    ] as unknown as RibViewDescriptor[];
    expect(ownedViews(manifest({ views })).map((v) => v.key)).toEqual(["rib:chamber:presence"]);
  });

  it("drops a surface whose region escapes the namespace, keeping the rib's own", () => {
    const surfaces = [
      surface("chamber", "rib:chamber:presence"),
      surface("bad", "rib:squad:roster"),
    ];
    expect(ownedSurfaces(manifest({ surfaces })).map((s) => s.id)).toEqual(["chamber"]);
  });

  it("checks every region slot, not just the rows", () => {
    const banner: RibSurfaceDescriptor = {
      id: "chamber",
      title: "Chamber",
      layout: {
        banner: { key: "rib:squad:brief" },
        rows: [{ columns: [{ key: "rib:chamber:rooms" }] }],
      },
    } as RibSurfaceDescriptor;
    expect(ownedSurfaces(manifest({ surfaces: [banner] }))).toEqual([]);
  });

  it("drops a malformed surface rather than letting it throw the response parse", () => {
    const surfaces = [
      surface("chamber", "rib:chamber:presence"),
      { id: "", title: "", layout: { rows: [] } },
    ] as unknown as RibSurfaceDescriptor[];
    expect(ownedSurfaces(manifest({ surfaces })).map((s) => s.id)).toEqual(["chamber"]);
  });
});

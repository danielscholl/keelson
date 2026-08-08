// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { RibSurfaceDescriptor, RibViewDescriptor } from "@keelson/shared";
import { Hono } from "hono";
import { allRegions, type RibManifest } from "./ribs.ts";
import { ownedSurfaces, ownedViews, type RibsRoutesDeps, ribsRoutes } from "./ribs-handler.ts";

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

function reloadApp(reloadWorkflows?: RibsRoutesDeps["reloadWorkflows"]): Hono {
  const app = new Hono();
  ribsRoutes(app, {
    manifests: [],
    probes: new Map(),
    actionHandlers: new Map(),
    ...(reloadWorkflows ? { reloadWorkflows } : {}),
  });
  return app;
}

function reloadRequest(origin = "http://127.0.0.1:5173"): Request {
  return new Request("http://test/api/ribs/reload-workflows", {
    method: "POST",
    headers: { origin },
  });
}

describe("POST /api/ribs/reload-workflows", () => {
  it("returns the validated reload result", async () => {
    const app = reloadApp(() => ({
      count: 2,
      notices: [
        {
          level: "warning",
          filename: "<rib:alpha>",
          message: "duplicate workflow",
        },
      ],
    }));

    const response = await app.fetch(reloadRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      count: 2,
      notices: [
        {
          level: "warning",
          filename: "<rib:alpha>",
          message: "duplicate workflow",
        },
      ],
    });
  });

  it("rejects a malformed reload result", async () => {
    const app = reloadApp(() => ({ count: -1, notices: [] }));
    const response = await app.fetch(reloadRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "reload returned a malformed response" });
  });

  it("rejects a foreign origin", async () => {
    const app = reloadApp(() => ({ count: 0, notices: [] }));
    const response = await app.fetch(reloadRequest("https://example.com"));
    expect(response.status).toBe(403);
  });

  it("reports unavailable when the reload thunk is absent", async () => {
    const response = await reloadApp().fetch(reloadRequest());
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "reload unavailable" });
  });

  it("returns a reload failure as an error response", async () => {
    const app = reloadApp(() => {
      throw new Error("reload failed");
    });
    const response = await app.fetch(reloadRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "reload failed" });
  });
});

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

  // First wins because the client routes a nav tab to the first id match, so a later
  // duplicate is unreachable regardless.
  it("keeps the first surface of a duplicated id and drops the later one", () => {
    const surfaces = [
      surface("chamber", "rib:chamber:presence"),
      surface("chamber", "rib:chamber:impostor"),
      surface("lenses", "rib:chamber:lenses"),
    ];
    const kept = ownedSurfaces(manifest({ surfaces }));
    expect(kept.map((s) => s.id)).toEqual(["chamber", "lenses"]);
    expect(allRegions(kept[0]!.layout).map((r) => r.key)).toEqual(["rib:chamber:presence"]);
  });

  it("drops a malformed surface rather than letting it throw the response parse", () => {
    const surfaces = [
      surface("chamber", "rib:chamber:presence"),
      { id: "", title: "", layout: { rows: [] } },
    ] as unknown as RibSurfaceDescriptor[];
    expect(ownedSurfaces(manifest({ surfaces })).map((s) => s.id)).toEqual(["chamber"]);
  });
});

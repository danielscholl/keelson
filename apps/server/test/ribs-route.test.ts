// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rib } from "@keelson/shared";
import { Hono } from "hono";
import { bootstrapRibs, bootstrapWorkflows, prepareRibWorkflows } from "../src/bootstrap.ts";
import { ribsRoutes } from "../src/ribs-handler.ts";
import { createSnapshotManager } from "../src/snapshot-manager.ts";
import ribV2 from "./fixtures/rib-discovery/rib-v2/index.ts";

const ORIGIN = "http://127.0.0.1:5173";
const ribsEnv = process.env.KEELSON_RIBS;

beforeEach(() => {
  // Activate every rib in the explicit `available` map.
  delete process.env.KEELSON_RIBS;
});
afterEach(() => {
  if (ribsEnv === undefined) delete process.env.KEELSON_RIBS;
  else process.env.KEELSON_RIBS = ribsEnv;
});

async function makeRig(opts?: { available?: Record<string, Rib>; token?: string }) {
  const manager = createSnapshotManager();
  const available = opts?.available ?? { v2: ribV2 };
  const ribs = await bootstrapRibs({
    available,
    snapshotManager: manager,
    getRibCredential: (ribId, serviceId) =>
      Promise.resolve(
        opts?.token !== undefined && ribId === "v2" && serviceId === "token"
          ? opts.token
          : undefined,
      ),
  });
  const app = new Hono();
  ribsRoutes(app, {
    manifests: ribs.manifests,
    probes: ribs.probes,
    actionHandlers: ribs.actionHandlers,
  });
  return { app, manager, ribs };
}

function get(path: string): Request {
  return new Request(`http://test${path}`, { headers: { origin: ORIGIN } });
}
function post(path: string, body: unknown): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/ribs", () => {
  test("lists an active rib with its view + action descriptors", async () => {
    const { app } = await makeRig({ token: "secret" });
    const res = await app.fetch(get("/api/ribs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ribs: Array<Record<string, unknown>> };
    expect(body.ribs).toHaveLength(1);
    const rib = body.ribs[0]!;
    expect(rib.id).toBe("v2");
    expect(rib.displayName).toBe("V2 Rib");
    expect(rib.registered).toEqual(["v2.tool"]);
    expect(rib.views).toEqual([{ key: "rib:v2:summary", canvasKind: "view", title: "V2 Summary" }]);
    expect(rib.actions).toEqual([{ type: "ping", label: "Ping" }]);
    expect(rib.hasOnAction).toBe(true);
    expect(rib.auth).toEqual({ authenticated: true });
  });

  test("reports unauthenticated when the credential is absent", async () => {
    const { app } = await makeRig(); // no token
    const res = await app.fetch(get("/api/ribs"));
    const body = (await res.json()) as { ribs: Array<{ auth?: unknown }> };
    expect(body.ribs[0]?.auth).toEqual({ authenticated: false });
  });

  test("a throwing auth probe surfaces as unauthenticated rather than failing the list", async () => {
    const boom: Rib = {
      id: "boom",
      displayName: "Boom",
      authStatus: () => {
        throw new Error("probe failed");
      },
    };
    const { app } = await makeRig({ available: { boom } });
    const res = await app.fetch(get("/api/ribs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ribs: Array<{ auth?: { authenticated: boolean; statusMessage?: string } }>;
    };
    expect(body.ribs[0]?.auth?.authenticated).toBe(false);
    expect(body.ribs[0]?.auth?.statusMessage).toMatch(/probe failed/);
  });

  test("omits auth for a rib with no probe", async () => {
    const plain: Rib = { id: "plain", displayName: "Plain" };
    const { app } = await makeRig({ available: { plain } });
    const res = await app.fetch(get("/api/ribs"));
    const body = (await res.json()) as { ribs: Array<{ auth?: unknown; hasOnAction: boolean }> };
    expect(body.ribs[0]?.auth).toBeUndefined();
    expect(body.ribs[0]?.hasOnAction).toBe(false);
  });
});

describe("POST /api/ribs/:id/action", () => {
  test("dispatches to the rib's onAction handler", async () => {
    const { app } = await makeRig();
    const res = await app.fetch(post("/api/ribs/v2/action", { type: "ping" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { echoed: "ping" } });
  });

  test("404 for an unknown rib", async () => {
    const { app } = await makeRig();
    const res = await app.fetch(post("/api/ribs/nope/action", { type: "ping" }));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "rib not found" });
  });

  test("404 for a rib that doesn't handle actions", async () => {
    const plain: Rib = { id: "plain", displayName: "Plain" };
    const { app } = await makeRig({ available: { plain } });
    const res = await app.fetch(post("/api/ribs/plain/action", { type: "ping" }));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: "rib does not handle actions",
    });
  });

  test("400 for an invalid action body", async () => {
    const { app } = await makeRig();
    const res = await app.fetch(post("/api/ribs/v2/action", { type: "" }));
    expect(res.status).toBe(400);
  });

  test("403 for a foreign Origin (CSRF guard)", async () => {
    const { app } = await makeRig();
    const res = await app.fetch(
      new Request("http://test/api/ribs/v2/action", {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ type: "ping" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("500 when the handler throws", async () => {
    const thrower: Rib = {
      id: "thrower",
      displayName: "Thrower",
      onAction: () => {
        throw new Error("kaboom");
      },
    };
    const { app } = await makeRig({ available: { thrower } });
    const res = await app.fetch(post("/api/ribs/thrower/action", { type: "x" }));
    expect(res.status).toBe(500);
    expect((await res.json()) as { ok: boolean; error: string }).toEqual({
      ok: false,
      error: "kaboom",
    });
  });
});

describe("rib workflow contribution + binding", () => {
  let wfDir: string;
  beforeEach(() => {
    wfDir = mkdtempSync(join(tmpdir(), "keelson-rib-wf-"));
  });
  afterEach(() => {
    rmSync(wfDir, { recursive: true, force: true });
  });

  test("the contributed workflow merges into the catalog", async () => {
    const { ribs } = await makeRig();
    const { definitions } = prepareRibWorkflows(ribs.workflowContributions);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir, extra: definitions });
    expect(catalog.get("v2-live")?.name).toBe("v2-live");
  });

  test("a project workflow shadows the rib's, so the run's def has no binding", async () => {
    writeFileSync(
      join(wfDir, "v2-live.yaml"),
      "name: v2-live\ndescription: project override\nnodes:\n  - id: a\n    bash: echo hi\n",
    );
    const { ribs } = await makeRig();
    const { definitions, bindings } = prepareRibWorkflows(ribs.workflowContributions);
    const ribDef = definitions.find((d) => d.name === "v2-live");
    expect(ribDef).toBeDefined();
    expect(bindings.has(ribDef!)).toBe(true);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir, extra: definitions });
    const catalogDef = catalog.get("v2-live");
    // The catalog kept the project definition (a different object), so the run
    // path's identity lookup finds no binding — the rib key stays undriven.
    expect(catalogDef?.description).toBe("project override");
    expect(catalogDef).not.toBe(ribDef);
    expect(bindings.has(catalogDef!)).toBe(false);
  });

  test("two ribs contributing the same workflow name keep the accepted def's binding", async () => {
    const contributions = [
      {
        ribId: "a",
        definition: { name: "dup", description: "from a", nodes: [{ id: "x", bash: "echo a" }] },
        publish: () => {},
      },
      {
        ribId: "b",
        definition: { name: "dup", description: "from b", nodes: [{ id: "x", bash: "echo b" }] },
        publish: () => {},
      },
    ];
    const { definitions, bindings } = prepareRibWorkflows(contributions);
    expect(definitions).toHaveLength(2);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir, extra: definitions });
    const accepted = catalog.get("dup");
    // The catalog keeps the first contributor; its def still owns a binding.
    expect(accepted?.description).toBe("from a");
    expect(accepted ? bindings.has(accepted) : false).toBe(true);
  });

  test("publishing a valid payload composes the bound key; an invalid one fails closed", async () => {
    const { manager, ribs } = await makeRig();
    const { definitions, bindings } = prepareRibWorkflows(ribs.workflowContributions);
    const ribDef = definitions.find((d) => d.name === "v2-live");
    const binding = ribDef ? bindings.get(ribDef) : undefined;
    expect(binding).toBeDefined();

    binding!.publish({ view: "table", columns: [{ key: "a" }], rows: [] });
    // recompose is fire-and-forget; let the microtask settle.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    const good = manager.latest<{ view: string }>("rib:v2:summary");
    expect(good?.data.view).toBe("table");
    const version = good?.version;

    // Fails the rib's validator → dropped, prior frame kept, no version bump.
    binding!.publish({ bad: true });
    await new Promise((r) => setTimeout(r, 10));
    const after = manager.latest<{ view: string }>("rib:v2:summary");
    expect(after?.data.view).toBe("table");
    expect(after?.version).toBe(version);
  });

  test("a rapid burst of publishes broadcasts the final value", async () => {
    const { manager, ribs } = await makeRig();
    const { definitions, bindings } = prepareRibWorkflows(ribs.workflowContributions);
    const ribDef = definitions.find((d) => d.name === "v2-live");
    const binding = ribDef ? bindings.get(ribDef) : undefined;
    expect(binding).toBeDefined();

    // Publishes that land while a recompose is in flight must not be swallowed
    // by the manager's coalescing — the last value always wins.
    binding!.publish({ view: "table", columns: [{ key: "a" }], rows: [] });
    binding!.publish({ view: "table", columns: [{ key: "b" }], rows: [] });
    binding!.publish({ view: "table", columns: [{ key: "c" }], rows: [] });
    await new Promise((r) => setTimeout(r, 30));
    const frame = manager.latest<{ columns: Array<{ key: string }> }>("rib:v2:summary");
    expect(frame?.data.columns[0]?.key).toBe("c");
  });
});

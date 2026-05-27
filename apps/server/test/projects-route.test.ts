// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { openDatabase } from "../src/db/init.ts";
import { projectsRoutes } from "../src/projects-handler.ts";
import { createProjectsStore } from "../src/projects-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-projects-route-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRig() {
  const dbPath = join(tmpDir, "test.db");
  const db = openDatabase({ path: dbPath });
  const store = createProjectsStore(db);
  const app = new Hono();
  projectsRoutes(app, { store });
  return { app, store };
}

// Loopback origin so the origin-gate accepts state-changing requests.
const LOOPBACK_ORIGIN = "http://127.0.0.1:7878";

describe("projects routes", () => {
  test("GET /api/projects returns empty list initially", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/projects"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });

  test("POST /api/projects creates a project and GET returns it", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "test", rootPath: tmpDir }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { id: string; name: string; rootPath: string } };
    expect(body.project.name).toBe("test");
    expect(body.project.rootPath).toBe(tmpDir);

    const list = await app.fetch(new Request("http://test/api/projects"));
    const listBody = (await list.json()) as { projects: { name: string }[] };
    expect(listBody.projects.map((p) => p.name)).toEqual(["test"]);
  });

  test("POST rejects an invalid name", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "has spaces", rootPath: tmpDir }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST rejects a non-existent rootPath", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "ghost", rootPath: "/path/does/not/exist/here" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST returns 409 on duplicate name", async () => {
    const { app } = makeRig();
    const body = JSON.stringify({ name: "dup", rootPath: tmpDir });
    const first = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body,
      }),
    );
    expect(first.status).toBe(201);
    const second = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body,
      }),
    );
    expect(second.status).toBe(409);
  });

  test("POST rejects requests with no/wrong origin", async () => {
    const { app } = makeRig();
    const missingOrigin = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x0", rootPath: tmpDir }),
      }),
    );
    expect(missingOrigin.status).toBe(403);

    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ name: "x", rootPath: tmpDir }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("DELETE removes the project", async () => {
    const { app, store } = makeRig();
    const p = store.create({ name: "kill-me", rootPath: tmpDir });
    const res = await app.fetch(
      new Request(`http://test/api/projects/${p.id}`, {
        method: "DELETE",
        headers: { origin: LOOPBACK_ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    expect(store.get(p.id)).toBeUndefined();
  });

  test("DELETE returns 404 for unknown id", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects/nonexistent", {
        method: "DELETE",
        headers: { origin: LOOPBACK_ORIGIN },
      }),
    );
    expect(res.status).toBe(404);
  });
});

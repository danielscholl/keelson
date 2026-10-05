// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectResponseSchema } from "@keelson/shared";
import { runText } from "@keelson/shared/exec";
import { Hono } from "hono";

import { openDatabase } from "../src/db/init.ts";
import { projectsRoutes } from "../src/projects-handler.ts";
import { createProjectsService } from "../src/projects-service.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let workspace: string;
let target: string;
const databases: ReturnType<typeof openDatabase>[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-projects-route-"));
  workspace = join(tmpDir, "workspace");
  target = join(tmpDir, "project");
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmTemp(tmpDir);
});

function makeRig() {
  const dbPath = join(tmpDir, "test.db");
  const db = openDatabase({ path: dbPath });
  databases.push(db);
  const store = createProjectsStore(db);
  const app = new Hono();
  const service = createProjectsService({ store, workspaceRoot: workspace, runGit: testGit });
  projectsRoutes(app, { store, service });
  return { app, store, service };
}

const testGit: typeof runText = (cmd, args, opts) =>
  runText(cmd, args, {
    ...opts,
    env: {
      ...opts?.env,
      GIT_CONFIG_GLOBAL: join(tmpDir, "no-global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Operator",
      GIT_AUTHOR_EMAIL: "operator@example.test",
      GIT_COMMITTER_NAME: "Test Operator",
      GIT_COMMITTER_EMAIL: "operator@example.test",
    },
  });

function post(app: Hono, path: string, body: unknown, origin = LOOPBACK_ORIGIN) {
  return app.fetch(
    new Request(`http://test/api/projects${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
  );
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
        body: JSON.stringify({ name: "test", rootPath: target }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { id: string; name: string; rootPath: string } };
    expect(body.project.name).toBe("test");
    expect(body.project.rootPath).toBe(target);

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

  test("POST creates a missing rootPath with an empty initial commit", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "ghost", rootPath: target }),
      }),
    );
    expect(res.status).toBe(201);
    expect(readdirSync(target)).toEqual([".git"]);
    const head = await testGit("git", ["log", "-1", "--format=%s"], { cwd: target });
    expect(head).toMatchObject({ ok: true, data: "Initialize project\n" });
  });

  test("POST returns 409 on duplicate name", async () => {
    const { app } = makeRig();
    const body = JSON.stringify({ name: "dup", rootPath: target });
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
        body: JSON.stringify({ name: "x0", rootPath: target }),
      }),
    );
    expect(missingOrigin.status).toBe(403);

    const res = await app.fetch(
      new Request("http://test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ name: "x", rootPath: target }),
      }),
    );
    expect(res.status).toBe(403);
    expect(existsSync(target)).toBe(false);
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

  test("DELETE rejects removal of the default project", async () => {
    const { app, store } = makeRig();
    const p = store.create({ name: "default", rootPath: tmpDir });
    const res = await app.fetch(
      new Request(`http://test/api/projects/${p.id}`, {
        method: "DELETE",
        headers: { origin: LOOPBACK_ORIGIN },
      }),
    );
    expect(res.status).toBe(400);
    expect(store.get(p.id)).toBeDefined();
  });

  test("PATCH updates name", async () => {
    const { app, store } = makeRig();
    const p = store.create({ name: "patchme", rootPath: tmpDir });
    const res = await app.fetch(
      new Request(`http://test/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "patched" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { name: string } };
    expect(body.project.name).toBe("patched");
    expect(store.get(p.id)?.name).toBe("patched");
  });

  test("PATCH rejects renaming the default project", async () => {
    const { app, store } = makeRig();
    const p = store.create({ name: "default", rootPath: tmpDir });
    const res = await app.fetch(
      new Request(`http://test/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ name: "renamed" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("PATCH rejects empty patch", async () => {
    const { app, store } = makeRig();
    const p = store.create({ name: "empty-patch", rootPath: tmpDir });
    const res = await app.fetch(
      new Request(`http://test/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/projects/clone fails when destination already exists", async () => {
    const { app } = makeRig();
    const targetDir = join(workspace, "existing-repo");
    mkdirSync(targetDir, { recursive: true });
    const res = await app.fetch(
      new Request("http://test/api/projects/clone", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({
          url: "https://example.com/x/existing-repo.git",
          name: "existing-repo",
        }),
      }),
    );
    expect(res.status).toBe(409);
  });

  test("POST /api/projects/clone returns 400 when name cannot be derived", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/projects/clone", {
        method: "POST",
        headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
        body: JSON.stringify({ url: "http://example.com/" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST accepts name-only creation and rejects canonical duplicate roots", async () => {
    const { app } = makeRig();
    const response = await post(app, "", { name: "demo" });
    expect(response.status).toBe(201);
    const { project } = createProjectResponseSchema.parse(await response.json());
    expect(project.rootPath).toBe(join(workspace, "demo"));
    expect((await post(app, "", { name: "alias", rootPath: project.rootPath })).status).toBe(409);
    const alias = join(tmpDir, "alias");
    symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await post(app, "", { name: "symlink", rootPath: join(alias, "demo") })).status).toBe(
      409,
    );
  });

  test("POST registers populated non-Git folders and preserves existing repositories", async () => {
    const { app } = makeRig();
    mkdirSync(target);
    writeFileSync(join(target, ".keep"), "untouched");
    expect((await post(app, "", { name: "files", rootPath: target })).status).toBe(201);
    expect(readdirSync(target)).toEqual([".keep"]);
    const repo = join(tmpDir, "repo");
    mkdirSync(repo);
    expect((await testGit("git", ["init"], { cwd: repo })).ok).toBe(true);
    expect(
      (await testGit("git", ["commit", "--allow-empty", "-m", "Existing"], { cwd: repo })).ok,
    ).toBe(true);
    const head = await testGit("git", ["rev-parse", "HEAD"], { cwd: repo });
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    expect((await post(app, "", { name: "repo", rootPath: repo })).status).toBe(201);
    expect(await testGit("git", ["rev-parse", "HEAD"], { cwd: repo })).toEqual(head);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe(config);
  });

  test("POST clone succeeds locally and failures leave no destination", async () => {
    const { app } = makeRig();
    mkdirSync(target);
    expect((await testGit("git", ["init"], { cwd: target })).ok).toBe(true);
    expect(
      (await testGit("git", ["commit", "--allow-empty", "-m", "Source"], { cwd: target })).ok,
    ).toBe(true);
    const response = await post(app, "/clone", { url: target, name: "cloned" });
    expect(response.status).toBe(201);
    expect(createProjectResponseSchema.parse(await response.json()).project.rootPath).toBe(
      join(workspace, "cloned"),
    );
    expect(
      (await post(app, "/clone", { url: join(tmpDir, "missing"), name: "failed" })).status,
    ).toBe(502);
    expect(existsSync(join(workspace, "failed"))).toBe(false);
  });

  test("POST rejects malformed and strict bodies before side effects", async () => {
    const { app } = makeRig();
    for (const path of ["", "/clone"]) {
      const response = await app.fetch(
        new Request(`http://test/api/projects${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
          body: "{",
        }),
      );
      expect(response.status).toBe(400);
    }
    for (const body of [
      { name: "demo", extra: 1 },
      { name: "demo", rootPath: null },
      { name: "demo", rootPath: "relative" },
    ]) {
      expect((await post(app, "", body)).status).toBe(400);
    }
    expect((await post(app, "/clone", { url: target, extra: 1 })).status).toBe(400);
    expect(
      (await post(app, "/clone", { url: target, name: "forbidden" }, "http://evil.example")).status,
    ).toBe(403);
    expect(existsSync(workspace)).toBe(false);
  });
});

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectResponseSchema,
  listProjectsResponseSchema,
  ProjectOperationError,
  type Rib,
  type RibContext,
} from "@keelson/shared";
import { runText } from "@keelson/shared/exec";
import { Hono } from "hono";
import { bootstrapRibs } from "../src/bootstrap.ts";
import { openDatabase } from "../src/db/init.ts";
import { projectsRoutes } from "../src/projects-handler.ts";
import { createProjectsService } from "../src/projects-service.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { rmTemp } from "./temp.ts";

let temp: string;
let db: ReturnType<typeof openDatabase>;
let workspace: string;
let oldRibs: string | undefined;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "keelson-rib-projects-"));
  workspace = join(temp, "workspace");
  db = openDatabase({ path: join(temp, "test.db") });
  oldRibs = process.env.KEELSON_RIBS;
  delete process.env.KEELSON_RIBS;
});

afterEach(() => {
  if (oldRibs === undefined) delete process.env.KEELSON_RIBS;
  else process.env.KEELSON_RIBS = oldRibs;
  db.close();
  rmTemp(temp);
});

const testGit: typeof runText = (cmd, args, opts) =>
  runText(cmd, args, {
    ...opts,
    env: {
      ...opts?.env,
      GIT_CONFIG_GLOBAL: join(temp, "no-global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Operator",
      GIT_AUTHOR_EMAIL: "operator@example.test",
      GIT_COMMITTER_NAME: "Test Operator",
      GIT_COMMITTER_EMAIL: "operator@example.test",
    },
  });

async function rig() {
  const store = createProjectsStore(db);
  let serviceRef: ReturnType<typeof createProjectsService> | undefined;
  let context: RibContext | undefined;
  let early: Promise<unknown> | undefined;
  const rib: Rib = {
    id: "project-client",
    displayName: "Project client",
    registerTools: (ctx) => {
      context = ctx;
      early = ctx.createProject?.({ name: "early" }).catch((error: unknown) => error);
      return [];
    },
  };
  const boot = await bootstrapRibs({
    available: { "project-client": rib },
    crossRibGrants: new Map(),
    ribWorkflowGrants: new Map(),
    getProjects: () => store.list(),
    createProject: async (body) => {
      if (!serviceRef) throw new ProjectOperationError(503, "project service is not ready");
      return serviceRef.createProject(body);
    },
    cloneProject: async (body) => {
      if (!serviceRef) throw new ProjectOperationError(503, "project service is not ready");
      return serviceRef.cloneProject(body);
    },
  });
  if (!context?.createProject || !context.cloneProject || !context.getProjects) {
    throw new Error("project methods were not forwarded");
  }
  const ctx = {
    createProject: context.createProject,
    cloneProject: context.cloneProject,
    getProjects: context.getProjects,
  };
  const service = createProjectsService({ store, workspaceRoot: workspace, runGit: testGit });
  const app = new Hono();
  projectsRoutes(app, { store, service });
  return {
    ctx,
    app,
    store,
    early,
    boot,
    ready: () => {
      serviceRef = service;
    },
  };
}

function post(app: Hono, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://test/api/projects${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:7878" },
      body: JSON.stringify(body),
    }),
  );
}

describe("rib project service integration", () => {
  test("rejects early mutations and creates and clones persisted projects after readiness", async () => {
    const { ctx, app, store, early, ready, boot } = await rig();
    expect(await early).toMatchObject({ status: 503, message: "project service is not ready" });
    await expect(ctx.cloneProject({ url: "/source" })).rejects.toMatchObject({ status: 503 });
    expect(existsSync(workspace)).toBe(false);
    ready();
    const project = await ctx.createProject({ name: "early" });
    expect(project.rootPath).toBe(join(workspace, "early"));
    expect(readdirSync(project.rootPath)).toEqual([".git"]);
    const clone = await ctx.cloneProject({ url: project.rootPath, name: "cloned" });
    expect(store.get(project.id)).toEqual(project);
    expect(store.get(clone.id)).toEqual(clone);
    expect(ctx.getProjects()).toEqual(store.list());
    const list = await app.fetch(new Request("http://test/api/projects"));
    expect(listProjectsResponseSchema.parse(await list.json()).projects).toEqual(store.list());
    const fromHttp = await post(app, "", { name: "http" });
    expect(fromHttp.status).toBe(201);
    const httpProject = createProjectResponseSchema.parse(await fromHttp.json()).project;
    expect(ctx.getProjects()).toContainEqual(httpProject);
    await boot.disposeAll();
  });

  test("matches validation, conflict, and clone-failure semantics across entry points", async () => {
    const { ctx, app, ready } = await rig();
    ready();
    const project = await ctx.createProject({ name: "demo" });
    for (const body of [{ name: "demo" }, { name: "alias", rootPath: project.rootPath }]) {
      let failure: unknown;
      try {
        await ctx.createProject(body);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProjectOperationError);
      if (!(failure instanceof ProjectOperationError)) throw new Error("missing operation error");
      const http = await post(app, "", body);
      expect(http.status).toBe(failure.status);
      expect(await http.json()).toEqual({ error: failure.message });
    }
    const invalid = { name: "Bad" };
    await expect(ctx.createProject(invalid)).rejects.toMatchObject({ status: 400 });
    expect((await post(app, "", invalid)).status).toBe(400);
    const missing = { url: join(temp, "missing"), name: "missing" };
    await expect(ctx.cloneProject(missing)).rejects.toMatchObject({ status: 502 });
    expect((await post(app, "/clone", missing)).status).toBe(502);
    expect(existsSync(join(workspace, "missing"))).toBe(false);
  });

  test("reserves simultaneous rib and HTTP names and roots on the same service", async () => {
    const { ctx, app, store, ready } = await rig();
    ready();
    const creating = ctx.createProject({ name: "shared" });
    expect((await post(app, "", { name: "shared", rootPath: join(temp, "other") })).status).toBe(
      409,
    );
    expect(
      (await post(app, "", { name: "other", rootPath: join(workspace, "shared") })).status,
    ).toBe(409);
    const created = await creating;
    const cloning = ctx.cloneProject({ url: created.rootPath, name: "cloning" });
    expect((await post(app, "", { name: "cloning" })).status).toBe(409);
    await cloning;
    expect(store.list()).toHaveLength(2);
  });

  test("keeps boot default registration separate from project initialization", async () => {
    const { ctx, store, ready } = await rig();
    mkdirSync(workspace);
    const fallback = store.create({ name: "default", rootPath: workspace });
    ready();
    const project = await ctx.createProject({ name: "nested" });
    expect(store.get(fallback.id)).toEqual(fallback);
    expect(existsSync(join(workspace, ".git"))).toBe(false);
    expect(existsSync(join(project.rootPath, ".git"))).toBe(true);
  });
});

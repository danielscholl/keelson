// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  isRegisteredProvider,
  registerProvider,
  registerStubProvider,
  unregisterProvider,
} from "@keelson/providers";
import { TERMINAL_RUN_STATUSES, type WorkflowRunStatus } from "@keelson/shared";
import * as worktrees from "@keelson/workflows";
import { Hono } from "hono";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  workflowsRoutes,
} from "../src/workflows-handler.ts";
import { createWorkspaceLeaseStore } from "../src/workspace-lease-store.ts";
import { createWorkspaceManager } from "../src/workspace-manager.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let repoDir: string;
let wfDir: string;
let dbPath: string;

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

function canonicalExistingPath(path: string | null | undefined): string {
  if (!path) throw new Error("expected an existing path");
  const nativePath =
    process.platform === "win32" ? path.replace(/^\/([A-Za-z])(?=\/)/, "$1:") : path;
  return realpathSync.native(nativePath);
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  // Drain both pipes even on success: an undrained pipe read-end stays an open
  // handle on win32 that can block bun test from exiting.
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${err}`);
  }
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${stderr}`);
  }
  return stdout;
}

async function bunInstall(cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["bun", "install"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`bun install in ${cwd}: ${err}`);
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "t@t"], path);
  await git(["config", "user.name", "t"], path);
  writeFileSync(join(path, "README.md"), "x\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "init"], path);
}

async function addOrigin(path: string): Promise<void> {
  const remote = join(path, "origin.git");
  await git(["init", "--bare", "--initial-branch=main", remote], path);
  await git(["remote", "add", "origin", remote], path);
  await git(["push", "-u", "origin", "main"], path);
  await git(["remote", "set-head", "origin", "-a"], path);
}

beforeEach(() => {
  if (!isRegisteredProvider("stub")) registerStubProvider();
  tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "keelson-worktree-route-")));
  repoDir = join(tmpDir, "repo");
  mkdirSync(repoDir);
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir);
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmTemp(tmpDir);
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function makeRig(opts: { includeWorkspaceManager?: boolean; projectRootPath?: string } = {}) {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const workspaceManager = createWorkspaceManager({
    store: createWorkspaceLeaseStore(db),
    projectsStore,
  });
  const project = projectsStore.create({
    name: "repo",
    rootPath: opts.projectRootPath ?? repoDir,
  });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const app = new Hono();
  const options = {
    catalog,
    store,
    conversationStore,
    projectsStore,
    ...(opts.includeWorkspaceManager === false ? {} : { workspaceManager }),
  };
  const activeRuns = createActiveRuns();
  const subscribers = createWorkflowSubscribers();
  workflowsRoutes(app, options, activeRuns, subscribers);
  const controller = createWorkflowController(options, activeRuns, subscribers);
  return {
    app,
    store,
    conversationStore,
    controller,
    activeRuns,
    subscribers,
    workspaceManager,
    catalog,
    projectId: project.id,
  };
}

describe("worktree prune coordination", () => {
  async function setup(
    status: WorkflowRunStatus = "failed",
    branch = "keelson/prune-test",
    includeWorkspaceManager = true,
  ) {
    await initRepo(repoDir);
    writeWorkflow(
      "prune-test.yaml",
      "name: prune-test\ndescription: test prune coordination\nworktree:\n  enabled: true\n  branch: keelson/prune-test\nnodes:\n  - id: work\n    bash: exit 1\n",
    );
    const path = join(repoDir, ".worktrees", "prune-test");
    await worktrees.createWorktree({ repoPath: repoDir, branch, dest: path });
    const rig = makeRig({ includeWorkspaceManager });
    function addRun(runId: string, runStatus: WorkflowRunStatus, worktreePath = path) {
      rig.store.createRun({
        runId,
        workflowName: "prune-test",
        inputs: {},
        startedAt: new Date().toISOString(),
        conversationId: rig.conversationStore.create({ providerId: "workflow" }).id,
        workingDir: repoDir,
        worktreePath,
      });
      rig.store.updateRunStatus({
        runId,
        status: runStatus,
        completedAt: new Date().toISOString(),
        error: null,
      });
    }
    addRun("prune-run", status);
    const prune = (body: unknown = { path }, origin = ORIGIN) =>
      rig.app.request("/api/workflows/worktree-prune", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const resume = () =>
      rig.app.request("/api/workflows/runs/prune-run/resume-run", {
        method: "POST",
        headers: { origin: ORIGIN },
      });
    return { ...rig, path, branch, addRun, prune, resume };
  }

  test.each(["succeeded", "failed", "cancelled"] as const)(
    "prunes clean %s worktrees and their branches",
    async (status) => {
      const rig = await setup(status);
      const response = await rig.prune();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        removed: true,
        branchDeleted: rig.branch,
        warning: null,
      });
      expect(existsSync(rig.path)).toBe(false);
      expect((await gitText(["branch", "--list", rig.branch], repoDir)).trim()).toBe("");
      expect((await rig.resume()).status).toBe(409);
    },
  );

  test.each(["running", "paused"] as const)(
    "protects a shared worktree with a %s run",
    async (status) => {
      const rig = await setup();
      rig.addRun("other-run", status, join(rig.path, "..", "prune-test"));
      expect((await rig.prune()).status).toBe(409);
      expect(existsSync(rig.path)).toBe(true);
    },
  );

  test("stale persisted paths do not prevent pruning another worktree", async () => {
    const rig = await setup();
    rig.addRun("stale-run", "failed", join(repoDir, ".worktrees", "missing", "nested"));

    const response = await rig.prune();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: true,
      branchDeleted: rig.branch,
      warning: null,
    });
    expect(existsSync(rig.path)).toBe(false);
    expect((await rig.prune()).status).toBe(409);
    expect((await rig.prune({ path: join(repoDir, ".worktrees", "unknown") })).status).toBe(404);
  });

  test("prunes a second worktree while retaining the first run's removed path", async () => {
    const rig = await setup();
    const path = join(repoDir, ".worktrees", "second");
    const branch = "keelson/prune-second";
    await worktrees.createWorktree({ repoPath: repoDir, branch, dest: path });
    rig.addRun("second-run", "cancelled", path);

    expect((await rig.prune()).status).toBe(200);
    expect(rig.store.getRun("prune-run")?.worktreePath).toBe(rig.path);
    const response = await rig.prune({ path });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, branchDeleted: branch, warning: null });
    expect(existsSync(path)).toBe(false);
  });

  test.each([false, true])(
    "a recreated path cannot revive a pruned run (force=%s)",
    async (force) => {
      const rig = await setup(force ? "running" : "failed");
      if (force) writeFileSync(join(rig.path, "uncommitted.txt"), "discard explicitly\n");
      const response = await rig.prune({ path: rig.path, force });
      expect(response.status).toBe(200);
      expect((await response.json()).removed).toBe(true);
      expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);

      await worktrees.createWorktree({ repoPath: repoDir, branch: rig.branch, dest: rig.path });
      rig.addRun("replacement-run", "running");
      rig.store.updateRunStatus({
        runId: "prune-run",
        status: "failed",
        completedAt: new Date().toISOString(),
        error: null,
      });
      expect((await rig.resume()).status).toBe(409);
      expect(rig.controller.resumeRun("prune-run")).toMatchObject({
        ok: false,
        message: expect.stringContaining("was pruned"),
      });
      expect(rig.store.claimRunForResume("prune-run")).toBe(false);
      expect(existsSync(rig.path)).toBe(true);
    },
  );

  test("an interrupted deletion keeps its durable marker and releases the path guard", async () => {
    const rig = await setup();
    const removal = spyOn(worktrees, "removeWorktree").mockImplementation(async () => {
      expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);
      throw new Error("interrupted removal");
    });
    try {
      expect((await rig.prune()).status).toBe(500);
      expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);
      expect((await rig.resume()).status).toBe(409);
    } finally {
      removal.mockRestore();
    }
    expect((await rig.prune()).status).toBe(200);
    expect(existsSync(rig.path)).toBe(false);
  });

  test("retries interrupted branch cleanup after the directory is gone", async () => {
    const rig = await setup();
    const deletion = spyOn(worktrees, "deleteBranch").mockImplementation(async () => {
      throw new Error("interrupted branch cleanup");
    });
    try {
      expect((await rig.prune()).status).toBe(500);
      expect(existsSync(rig.path)).toBe(false);
      const cleanup = rig.store.getRunWorktreeCleanup("prune-run");
      expect(cleanup?.repoPath.replaceAll("\\", "/")).toBe(repoDir.replaceAll("\\", "/"));
      expect(cleanup?.branch).toBe(rig.branch);
      expect(rig.store.listWorktreeRuns()[0]?.cleanupPending).toBe(true);
    } finally {
      deletion.mockRestore();
    }
    const response = await rig.prune();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: false,
      branchDeleted: rig.branch,
      warning: null,
    });
    expect(rig.store.getRunWorktreeCleanup("prune-run")).toBeNull();
    expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);
    expect((await gitText(["branch", "--list", rig.branch], repoDir)).trim()).toBe("");
  });

  test("recovers a pending prune whose Git registration outlived its directory", async () => {
    const rig = await setup();
    rig.store.setRunsWorktreePruned(["prune-run"], true);
    rig.store.setRunsWorktreeCleanup(["prune-run"], { repoPath: repoDir, branch: rig.branch });
    rmSync(rig.path, { recursive: true });
    const response = await rig.prune();
    expect(response.status).toBe(200);
    expect((await response.json()).branchDeleted).toBe(rig.branch);
    expect(rig.store.getRunWorktreeCleanup("prune-run")).toBeNull();
    expect(await gitText(["worktree", "list", "--porcelain"], repoDir)).not.toContain(rig.branch);
  });

  test("a failed prune of a replacement does not restore the old run's identity", async () => {
    const rig = await setup();
    expect((await rig.prune()).status).toBe(200);
    await worktrees.createWorktree({ repoPath: repoDir, branch: rig.branch, dest: rig.path });
    rig.addRun("replacement-run", "failed");
    writeFileSync(join(rig.path, "uncommitted.txt"), "keep replacement work\n");

    const response = await rig.prune();
    expect((await response.json()).removed).toBe(false);
    expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);
    expect(rig.store.isRunWorktreePruned("replacement-run")).toBe(false);
    expect(rig.store.claimRunForResume("prune-run")).toBe(false);
  });

  test.each([false, true])(
    "forced orphan cleanup persists identity (stalePointer=%s)",
    async (stalePointer) => {
      const rig = await setup("running");
      await worktrees.removeWorktree({ repoPath: repoDir, dest: rig.path });
      mkdirSync(rig.path);
      if (stalePointer) {
        writeFileSync(
          join(rig.path, ".git"),
          `gitdir: ${join(tmpDir, "missing", ".git", "worktrees", "old")}\n`,
        );
      }
      writeFileSync(join(rig.path, "work.txt"), "in flight\n");
      expect((await rig.prune()).status).toBe(409);
      const response = await rig.prune({ path: rig.path, force: true });
      expect(response.status).toBe(200);
      expect((await response.json()).removed).toBe(true);
      expect(existsSync(rig.path)).toBe(false);
      expect(rig.store.isRunWorktreePruned("prune-run")).toBe(true);
    },
  );

  test("refuses prune if resume claimed a run after the status feed was read", async () => {
    const rig = await setup();
    const feed = await rig.app.request("/api/workflows/worktree-paths");
    expect((await feed.json()).runs[0].status).toBe("failed");
    expect(rig.store.claimRunForResume("prune-run")).toBe(true);
    expect((await rig.prune()).status).toBe(409);
    expect(existsSync(rig.path)).toBe(true);
  });

  test("blocks HTTP and tool resume and concurrent prune until removal settles", async () => {
    const rig = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = worktrees.listWorktreesWithStatus;
    const listing = spyOn(worktrees, "listWorktreesWithStatus").mockImplementation(
      async (repoPath) => {
        entered.resolve();
        await release.promise;
        return original(repoPath);
      },
    );
    const pending = rig.prune();
    try {
      await entered.promise;
      expect((await rig.resume()).status).toBe(409);
      expect(rig.controller.resumeRun("prune-run")).toMatchObject({
        ok: false,
        message: expect.stringContaining("worktree is being pruned"),
      });
      expect((await rig.prune()).status).toBe(409);
      expect(rig.store.getRun("prune-run")?.status).toBe("failed");
    } finally {
      release.resolve();
      await pending;
      listing.mockRestore();
    }
    expect(existsSync(rig.path)).toBe(false);
  });

  test("reports Git listing errors and releases the prune claim", async () => {
    const rig = await setup();
    const warning = "git worktree list failed (exit 128): repository unavailable";
    const listing = spyOn(worktrees, "listWorktreesWithStatus").mockResolvedValue({
      worktrees: [],
      error: warning,
    });
    try {
      const response = await rig.prune();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removed: false, branchDeleted: null, warning });
      expect(existsSync(rig.path)).toBe(true);
      expect((await gitText(["branch", "--list", rig.branch], repoDir)).trim()).not.toBe("");
    } finally {
      listing.mockRestore();
    }
    expect((await rig.prune()).status).toBe(200);
    expect(existsSync(rig.path)).toBe(false);
  });

  test("preserves dirty work and releases the claim after Git refuses removal", async () => {
    const rig = await setup();
    const dirtyFile = join(rig.path, "README.md");
    writeFileSync(dirtyFile, "uncommitted edits\n");
    const response = await rig.prune();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: false,
      branchDeleted: null,
      warning: expect.stringContaining("git worktree remove failed"),
    });
    expect(readFileSync(dirtyFile, "utf8")).toBe("uncommitted edits\n");
    expect(rig.store.isRunWorktreePruned("prune-run")).toBe(false);
    expect((await gitText(["branch", "--list", rig.branch], repoDir)).trim()).not.toBe("");
    await git(["checkout", "--", "README.md"], rig.path);
    expect((await rig.prune()).status).toBe(200);
    expect(existsSync(rig.path)).toBe(false);
  });

  test.each([true, false])(
    "new fixed-branch runs wait for pruning before preparing their worktree (manager=%s)",
    async (includeWorkspaceManager) => {
      const rig = await setup("failed", "keelson/prune-test", includeWorkspaceManager);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atSetup = Promise.withResolvers<void>();
      const original = worktrees.listWorktreesWithStatus;
      const listing = spyOn(worktrees, "listWorktreesWithStatus").mockImplementation(
        async (repoPath) => {
          entered.resolve();
          await release.promise;
          return original(repoPath);
        },
      );
      const toplevel = spyOn(worktrees, "gitToplevel").mockImplementation(async () => {
        atSetup.resolve();
        return repoDir;
      });
      const prepare = includeWorkspaceManager
        ? spyOn(rig.workspaceManager, "prepareWorktree")
        : spyOn(worktrees, "createWorktree");
      const pending = rig.prune();
      let runId: string | undefined;
      try {
        await entered.promise;
        const started = rig.controller.startRun({
          name: "prune-test",
          inputs: {},
          workingDir: repoDir,
          isolation: "worktree",
        });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error(started.message);
        runId = started.runId;
        await atSetup.promise;
        await Promise.resolve();
        expect(prepare).not.toHaveBeenCalled();
        release.resolve();
        expect((await pending).status).toBe(200);
        const run = await pollUntilTerminal(rig.app, runId);
        expect(run.worktreePath).toBe(rig.path);
        expect(existsSync(rig.path)).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await pending;
        if (runId) await pollUntilTerminal(rig.app, runId);
        prepare.mockRestore();
        toplevel.mockRestore();
        listing.mockRestore();
      }
    },
  );

  test("prune refuses a worktree being adopted before its new run records the path", async () => {
    const rig = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = rig.workspaceManager.prepareWorktree;
    const prepare = spyOn(rig.workspaceManager, "prepareWorktree").mockImplementation(
      async (request) => {
        entered.resolve();
        await release.promise;
        return original(request);
      },
    );
    const started = rig.controller.startRun({
      name: "prune-test",
      inputs: {},
      workingDir: repoDir,
      isolation: "worktree",
    });
    try {
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.message);
      await entered.promise;
      expect(rig.store.getRun(started.runId)?.worktreePath).toBeNull();
      expect((await rig.prune()).status).toBe(409);
      expect(existsSync(rig.path)).toBe(true);
    } finally {
      release.resolve();
      if (started.ok) await pollUntilTerminal(rig.app, started.runId);
      prepare.mockRestore();
    }
  });

  test("does not remove user-managed worktrees", async () => {
    const rig = await setup("failed", "feature/keep");
    expect((await rig.prune()).status).toBe(409);
    expect((await rig.prune({ path: rig.path, force: true })).status).toBe(409);
    expect(rig.store.isRunWorktreePruned("prune-run")).toBe(false);
    expect(existsSync(rig.path)).toBe(true);
  });

  test("rejects forbidden origins, malformed bodies, and unrecorded paths", async () => {
    const rig = await setup();
    expect((await rig.prune({ path: rig.path }, "https://evil.example")).status).toBe(403);
    expect((await rig.prune({ path: "relative" })).status).toBe(400);
    expect((await rig.prune({ path: repoDir })).status).toBe(404);
    expect(existsSync(rig.path)).toBe(true);
  });
});

async function pollUntilTerminal(
  app: Hono,
  runId: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { status: string } };
    if (TERMINAL_STATUSES.has(body.run.status)) return body.run as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not complete in ${timeoutMs}ms`);
}

// The executor's worktree cleanup runs in the executeRunInBackground finally
// block, AFTER the terminal-status write that pollUntilTerminal observes. For
// the success path the worktree dir is removed and `worktree_path` is cleared
// to null; tests that assert post-cleanup state poll on that signal.
async function pollUntilWorktreeCleared(
  app: Hono,
  runId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { worktreePath: string | null } };
    if (body.run.worktreePath === null) return body.run as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`worktree for run ${runId} not cleared in ${timeoutMs}ms`);
}

async function pollUntilStoredStatus(
  store: ReturnType<typeof createWorkflowStore>,
  runId: string,
  statuses: ReadonlySet<WorkflowRunStatus>,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId);
    if (run && statuses.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${[...statuses].join("/")} in ${timeoutMs}ms`);
}

describe("workflow run worktree isolation (slice 3)", () => {
  for (const includeWorkspaceManager of [true, false]) {
    for (const policy of ["yaml", "override"] as const) {
      for (const failure of ["probe-false", "probe-throw", "prepare-throw"] as const) {
        test(`fails closed for ${policy} isolation on ${failure} (workspaceManager=${includeWorkspaceManager})`, async () => {
          await initRepo(repoDir);
          writeWorkflow(
            "setup-gate.yaml",
            `name: setup-gate
description: deterministic setup failure
worktree:
  enabled: ${policy === "yaml" ? "true" : "false"}
nodes:
  - id: work
    bash: touch sentinel.txt
`,
          );
          const rig = makeRig({ includeWorkspaceManager });
          const mocks: Array<{ mockRestore(): void }> = [];
          if (failure === "probe-false") {
            mocks.push(spyOn(worktrees, "isGitRepo").mockResolvedValue(false));
          } else if (failure === "probe-throw") {
            mocks.push(
              spyOn(worktrees, "isGitRepo").mockRejectedValue(new Error("injected probe failure")),
            );
          } else if (includeWorkspaceManager) {
            mocks.push(
              spyOn(rig.workspaceManager, "prepareWorktree").mockRejectedValue(
                new Error("injected prepare failure"),
              ),
            );
          } else {
            mocks.push(
              spyOn(worktrees, "createWorktree").mockRejectedValue(
                new Error("injected prepare failure"),
              ),
            );
          }

          try {
            const started = rig.controller.startRun({
              name: "setup-gate",
              inputs: {},
              workingDir: repoDir,
              ...(policy === "override" ? { isolation: "worktree" as const } : {}),
            });
            expect(started.ok).toBe(true);
            if (!started.ok) throw new Error(started.message);
            const run = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
            expect(run.error).toContain("worktree setup failed:");
            expect(run.error).toContain(
              failure === "probe-false"
                ? "could not confirm"
                : failure === "probe-throw"
                  ? "probe"
                  : "prepare",
            );
            expect(run.nodes).toEqual([]);
            expect(run.worktreePath).toBeNull();
            expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
            expect(rig.activeRuns.size()).toBe(0);
          } finally {
            for (const mock of mocks) mock.mockRestore();
            await rig.activeRuns.abortAll();
          }
        });
      }
    }
  }

  test("retains the real Git error when an invalid branch prevents setup", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "invalid-branch.yaml",
      `name: invalid-branch
description: deterministic real Git setup failure
worktree:
  enabled: true
  branch: invalid..branch
nodes:
  - id: work
    bash: touch sentinel.txt
`,
    );
    const rig = makeRig({ includeWorkspaceManager: false });
    const started = rig.controller.startRun({
      name: "invalid-branch",
      inputs: {},
      workingDir: repoDir,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);

    const run = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
    expect(run.error).toContain("worktree setup failed:");
    expect(run.error).toContain("invalid..branch");
    expect(run.nodes).toEqual([]);
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
    expect(rig.activeRuns.size()).toBe(0);
  });

  test("fails after worktree creation without entering the executor", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "post-create-failure.yaml",
      `name: post-create-failure
description: dependency preparation throws after checkout creation
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
    );
    const rig = makeRig({ includeWorkspaceManager: false });
    const deps = spyOn(worktrees, "ensureWorktreeDeps").mockRejectedValue(
      new Error("injected post-create failure"),
    );
    try {
      const started = rig.controller.startRun({
        name: "post-create-failure",
        inputs: {},
        workingDir: repoDir,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.message);
      const run = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
      expect(run.error).toContain("injected post-create failure");
      expect(run.worktreeEstablished).toBe(true);
      expect(run.worktreePath).not.toBeNull();
      expect(existsSync(run.worktreePath ?? "")).toBe(true);
      expect(run.nodes).toEqual([]);
      expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
    } finally {
      deps.mockRestore();
      await rig.activeRuns.abortAll();
    }
  });

  test("fails when worktree identity cannot be persisted and preserves the checkout", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "persist-failure.yaml",
      `name: persist-failure
description: worktree identity persistence failure
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
    );
    const rig = makeRig({ includeWorkspaceManager: false });
    const persist = spyOn(rig.store, "setRunWorktreePath").mockImplementation(() => {
      throw new Error("injected persistence failure");
    });
    try {
      const started = rig.controller.startRun({
        name: "persist-failure",
        inputs: {},
        workingDir: repoDir,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.message);
      const run = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
      expect(run.error).toContain("injected persistence failure");
      expect(run.worktreePath).toBeNull();
      expect(run.nodes).toEqual([]);
      expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
      const listing = await worktrees.listWorktreesWithStatus(repoDir);
      const surviving = listing.worktrees.find((entry) => entry.path !== repoDir);
      expect(surviving).toBeDefined();
      expect(existsSync(surviving?.path ?? "")).toBe(true);
    } finally {
      persist.mockRestore();
      await rig.activeRuns.abortAll();
    }
  });

  test("resume retries a failed setup and repeated setup failures stay retryable", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "setup-retry.yaml",
      `name: setup-retry
description: retry required setup before node execution
worktree:
  enabled: true
nodes:
  - id: work
    bash: pwd
`,
    );
    const rig = makeRig();
    const original = rig.workspaceManager.prepareWorktree;
    let attempts = 0;
    const prepare = spyOn(rig.workspaceManager, "prepareWorktree").mockImplementation(
      async (request) => {
        attempts += 1;
        if (attempts <= 2) throw new Error(`injected setup failure ${attempts}`);
        return original(request);
      },
    );
    try {
      const started = rig.controller.startRun({
        name: "setup-retry",
        inputs: {},
        workingDir: repoDir,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.message);
      const first = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
      expect(first.nodes).toEqual([]);
      expect(first.error).toContain("injected setup failure 1");

      expect(rig.controller.resumeRun(started.runId)).toEqual({ ok: true });
      const second = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
      expect(second.nodes).toEqual([]);
      expect(second.error).toContain("injected setup failure 2");

      expect(rig.controller.resumeRun(started.runId)).toEqual({ ok: true });
      const completed = await pollUntilStoredStatus(
        rig.store,
        started.runId,
        new Set(["succeeded"]),
      );
      expect(completed.nodes[0]?.outputText?.replaceAll("\\", "/")).toContain("/.worktrees/");
      expect(attempts).toBe(3);
    } finally {
      prepare.mockRestore();
      await rig.activeRuns.abortAll();
    }
  });

  test("explicit in-place execution inside a caller lease remains caller-owned across resume", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "leased-run.yaml",
      `name: leased-run
description: run inside a caller-owned checkout
worktree:
  enabled: true
nodes:
  - id: work
    bash: |
      if [ ! -f .resume-ready ]; then touch .resume-ready; exit 1; fi
      pwd
`,
    );
    const rig = makeRig();
    const lease = await rig.workspaceManager.acquire({
      projectId: rig.projectId,
      purpose: "caller-owned",
      owner: "test",
    });
    try {
      const started = rig.controller.startRun({
        name: "leased-run",
        inputs: {},
        workingDir: lease.path,
        project: { id: rig.projectId, rootPath: repoDir },
        isolation: "none",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.message);
      const failed = await pollUntilStoredStatus(rig.store, started.runId, new Set(["failed"]));
      expect(failed.isolationEnabled).toBe(false);
      expect(failed.worktreePath).toBeNull();
      expect(failed.workingDir).toBe(lease.path);

      expect(rig.controller.resumeRun(started.runId)).toEqual({ ok: true });
      const completed = await pollUntilStoredStatus(
        rig.store,
        started.runId,
        new Set(["succeeded"]),
      );
      expect(canonicalExistingPath(completed.nodes[0]?.outputText?.trim())).toBe(
        canonicalExistingPath(lease.path),
      );
      expect(existsSync(lease.path)).toBe(true);
      expect(rig.workspaceManager.list().some((record) => record.id === lease.id)).toBe(true);
    } finally {
      await rig.activeRuns.abortAll();
      await lease.release();
    }
    expect(existsSync(lease.path)).toBe(false);
  });

  for (const injectFailure of [false, true]) {
    test(`concurrent isolated starts keep distinct checkout identity (injectedFailure=${injectFailure})`, async () => {
      await initRepo(repoDir);
      writeWorkflow(
        "concurrent.yaml",
        `name: concurrent
description: hold concurrent isolated runs for checkout inspection
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
  - id: hold
    depends_on: [where]
    approval:
      message: inspect checkout
`,
      );
      const rig = makeRig();
      const original = rig.workspaceManager.prepareWorktree;
      let calls = 0;
      const prepare = spyOn(rig.workspaceManager, "prepareWorktree").mockImplementation(
        async (request) => {
          calls += 1;
          if (injectFailure && calls === 2) throw new Error("injected concurrent setup failure");
          return original(request);
        },
      );
      const runIds: string[] = [];
      try {
        for (let index = 0; index < 4; index++) {
          const started = rig.controller.startRun({
            name: "concurrent",
            inputs: { index: String(index) },
            workingDir: repoDir,
          });
          expect(started.ok).toBe(true);
          if (!started.ok) throw new Error(started.message);
          runIds.push(started.runId);
        }
        const runs = await Promise.all(
          runIds.map((runId) =>
            pollUntilStoredStatus(rig.store, runId, new Set(["paused", "failed"]), 10_000),
          ),
        );
        const failed = runs.filter((run) => run.status === "failed");
        const paused = runs.filter((run) => run.status === "paused");
        expect(failed).toHaveLength(injectFailure ? 1 : 0);
        expect(paused).toHaveLength(injectFailure ? 3 : 4);
        if (failed[0]) {
          expect(failed[0].error).toContain("injected concurrent setup failure");
          expect(failed[0].nodes).toEqual([]);
        }
        const paths = paused.map((run) => run.worktreePath);
        expect(paths.every((path) => path !== null && path !== repoDir)).toBe(true);
        expect(new Set(paths).size).toBe(paths.length);
        for (const run of paused) {
          if (run.worktreePath === null) throw new Error("paused isolated run has no worktree");
          expect(
            canonicalExistingPath(
              run.nodes.find((node) => node.nodeId === "where")?.outputText?.trim(),
            ),
          ).toBe(canonicalExistingPath(run.worktreePath));
        }
      } finally {
        prepare.mockRestore();
        await rig.activeRuns.abortAll();
      }
      expect(rig.activeRuns.size()).toBe(0);
    }, 15_000);
  }

  test("cancellation while setup and slot acquisition are pending drains and permits retry", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "queued-cancel.yaml",
      `name: queued-cancel
description: hold setup and queue one isolated run
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
  - id: hold
    depends_on: [where]
    approval:
      message: hold
`,
    );
    const rig = makeRig();
    const release = Promise.withResolvers<void>();
    const fourEntered = Promise.withResolvers<void>();
    const original = rig.workspaceManager.prepareWorktree;
    let entered = 0;
    const prepare = spyOn(rig.workspaceManager, "prepareWorktree").mockImplementation(
      async (request) => {
        entered += 1;
        if (entered === 4) fourEntered.resolve();
        await release.promise;
        return original(request);
      },
    );
    const runIds: string[] = [];
    try {
      for (let index = 0; index < 5; index++) {
        const started = rig.controller.startRun({
          name: "queued-cancel",
          inputs: { index: String(index) },
          workingDir: repoDir,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error(started.message);
        runIds.push(started.runId);
      }
      await fourEntered.promise;
      expect(rig.controller.cancelRun(runIds[0]!)).toBe(true);
      expect(rig.controller.cancelRun(runIds[4]!)).toBe(true);
      const queued = await pollUntilStoredStatus(rig.store, runIds[4]!, new Set(["cancelled"]));
      expect(queued.nodes).toEqual([]);

      release.resolve();
      await rig.activeRuns.abortAll();
      const setupPending = rig.store.getRun(runIds[0]!);
      expect(setupPending?.status).toBe("cancelled");
      expect(setupPending?.nodes).toEqual([]);
      expect(rig.activeRuns.size()).toBe(0);
    } finally {
      release.resolve();
      await rig.activeRuns.abortAll();
      prepare.mockRestore();
    }

    expect(rig.controller.resumeRun(runIds[4]!)).toEqual({ ok: true });
    const retried = await pollUntilStoredStatus(rig.store, runIds[4]!, new Set(["paused"]), 10_000);
    expect(retried.worktreePath).not.toBeNull();
    expect(retried.nodes.find((node) => node.nodeId === "where")?.status).toBe("succeeded");
    await rig.activeRuns.abortAll();
    expect(rig.activeRuns.size()).toBe(0);
  }, 15_000);

  test("YAML worktree.enabled creates a worktree, runs in it, prunes on success", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso.yaml",
      `name: iso
description: write a sentinel file in the worktree so we can confirm cwd
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd > sentinel.txt && cat sentinel.txt
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    // The bash node printed `pwd`; assert that path differs from the repo root
    // (sanity check that the worktree was actually used) and lives under the
    // repo-local `.worktrees/` dir.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);

    // Sentinel was written to the worktree, not the source repo.
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);

    // On success, worktree_path is cleared after the run's finally block
    // runs — race past the terminal-status write before asserting.
    const cleared = (await pollUntilWorktreeCleared(app, runId)) as {
      worktreePath: string | null;
    };
    expect(cleared.worktreePath).toBeNull();
  });

  // Local dep links come from the checkout root, which a run's workingDir is
  // allowed to sit below.
  for (const includeWorkspaceManager of [true, false]) {
    test(`restores a root local dep link for a run started in a subdirectory (workspaceManager=${includeWorkspaceManager})`, async () => {
      await initRepo(repoDir);
      // A manifest + lockfile so the worktree actually installs; link
      // reproduction runs after a successful install. The workspace dep is what
      // makes bun emit a lockfile at all.
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "linkiso-root",
            version: "0.0.0",
            private: true,
            workspaces: ["fixture"],
            dependencies: { "@fixture/base": "workspace:*" },
          },
          null,
          2,
        ),
      );
      mkdirSync(join(repoDir, "fixture"), { recursive: true });
      writeFileSync(
        join(repoDir, "fixture", "package.json"),
        JSON.stringify({ name: "@fixture/base", version: "0.0.0" }, null, 2),
      );
      await bunInstall(repoDir);
      await git(["add", "package.json", "fixture/package.json", "bun.lock"], repoDir);
      await git(["commit", "-m", "add manifest"], repoDir);

      const external = join(tmpDir, "external-pkg");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "index.js"), "module.exports = 'linked';\n");
      // The link lives in the ROOT's node_modules, gitignored, outside the repo.
      // "junction" so the fixture resolves on Windows, where the default "file"
      // type would produce a broken link to a directory.
      mkdirSync(join(repoDir, "node_modules", "@scope"), { recursive: true });
      symlinkSync(
        external,
        join(repoDir, "node_modules", "@scope", "pkg"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const subdir = join(repoDir, "packages", "nested");
      mkdirSync(subdir, { recursive: true });

      writeWorkflow(
        "linkiso.yaml",
        `name: linkiso
description: report whether the root local dep link survived into the worktree
worktree:
  enabled: true
nodes:
  - id: probe
    bash: |
      test -e node_modules/@scope/pkg && echo LINK_PRESENT
`,
      );
      const { app, projectId } = makeRig({ includeWorkspaceManager });
      const res = await app.fetch(
        new Request("http://test/api/workflows/linkiso/runs", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ inputs: {}, projectId, workingDir: subdir }),
        }),
      );
      expect(res.status).toBe(200);
      const { runId } = (await res.json()) as { runId: string };
      const run = (await pollUntilTerminal(app, runId)) as {
        status: string;
        nodes: Array<{ outputText: string | null }>;
      };
      expect(run.status).toBe("succeeded");
      const probe = run.nodes[0]!.outputText ?? "";
      expect(probe).toContain("LINK_PRESENT");
    });
  }

  for (const includeWorkspaceManager of [true, false]) {
    test(`resume restores local dep links from the linked source checkout (workspaceManager=${includeWorkspaceManager})`, async () => {
      await initRepo(repoDir);
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "resume-link-root",
            version: "0.0.0",
            private: true,
            workspaces: ["fixture"],
            dependencies: { "@fixture/base": "workspace:*" },
          },
          null,
          2,
        ),
      );
      mkdirSync(join(repoDir, "fixture"), { recursive: true });
      writeFileSync(
        join(repoDir, "fixture", "package.json"),
        JSON.stringify({ name: "@fixture/base", version: "0.0.0" }, null, 2),
      );
      await bunInstall(repoDir);
      await git(["add", "package.json", "fixture/package.json", "bun.lock"], repoDir);
      await git(["commit", "-m", "add manifest"], repoDir);

      const sourceCheckout = join(tmpDir, "source-checkout");
      await git(["worktree", "add", "-b", "linked-source", sourceCheckout], repoDir);
      await bunInstall(sourceCheckout);
      const external = join(tmpDir, "resume-external-pkg");
      mkdirSync(external, { recursive: true });
      mkdirSync(join(sourceCheckout, "node_modules", "@scope"), { recursive: true });
      symlinkSync(
        external,
        join(sourceCheckout, "node_modules", "@scope", "pkg"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const subdir = join(sourceCheckout, "packages", "nested");
      mkdirSync(subdir, { recursive: true });

      writeWorkflow(
        "resume-link.yaml",
        `name: resume-link
description: restore a linked dependency before re-entering a failed worktree
worktree:
  enabled: true
nodes:
  - id: probe
    bash: |
      test -e node_modules/@scope/pkg
      if [ ! -f .resume-ready ]; then touch .resume-ready; exit 1; fi
      echo LINK_PRESENT
`,
      );
      const { app, projectId } = makeRig({
        includeWorkspaceManager,
        projectRootPath: sourceCheckout,
      });
      const start = await app.fetch(
        new Request("http://test/api/workflows/resume-link/runs", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ inputs: {}, projectId, workingDir: subdir }),
        }),
      );
      expect(start.status).toBe(200);
      const { runId } = (await start.json()) as { runId: string };
      const failed = (await pollUntilTerminal(app, runId)) as {
        status: string;
        worktreePath: string | null;
      };
      expect(failed.status).toBe("failed");
      expect(failed.worktreePath).toBeTruthy();
      if (failed.worktreePath === null) throw new Error("failed run did not retain its worktree");
      rmSync(join(failed.worktreePath, "node_modules", "@scope", "pkg"), {
        recursive: true,
        force: true,
      });

      const resume = await app.fetch(
        new Request(`http://test/api/workflows/runs/${runId}/resume-run`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(resume.status).toBe(200);
      const completed = (await pollUntilTerminal(app, runId)) as {
        status: string;
        nodes: Array<{ outputText: string | null }>;
      };
      expect(completed.status).toBe("succeeded");
      expect(completed.nodes[0]!.outputText).toContain("LINK_PRESENT");
    });
  }

  test("resume recreates forced isolation after preflight fails before worktree creation", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "preflight-isolated.yaml",
      `name: preflight-isolated
description: preserve forced isolation across a preflight retry
provider: stub
nodes:
  - id: probe
    model: retired-model
    prompt: run
`,
    );
    const { app, catalog, projectId } = makeRig();
    const start = await app.fetch(
      new Request("http://test/api/workflows/preflight-isolated/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "worktree" }),
      }),
    );
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };
    const failed = (await pollUntilTerminal(app, runId)) as {
      status: string;
      worktreePath: string | null;
    };
    expect(failed.status).toBe("failed");
    expect(failed.worktreePath).toBeNull();

    const workflow = catalog.get("preflight-isolated", { projectId });
    if (!workflow) throw new Error("workflow missing from catalog");
    workflow.nodes = [{ id: "probe", bash: "pwd; touch sentinel.txt" }];

    const resume = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}/resume-run`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(resume.status).toBe(200);
    const completed = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(completed.status).toBe("succeeded");
    expect(completed.nodes[0]?.outputText?.replace(/\\/g, "/")).toContain("/.worktrees/");
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
  });

  test("resume refuses a preflight failure whose isolation choice was never persisted", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "preflight-legacy.yaml",
      `name: preflight-legacy
description: a forced-isolation run recorded before isolation choices were persisted
provider: stub
worktree:
  enabled: false
nodes:
  - id: probe
    model: retired-model
    prompt: run
`,
    );
    const { app, catalog, projectId, store } = makeRig();
    const start = await app.fetch(
      new Request("http://test/api/workflows/preflight-legacy/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "worktree" }),
      }),
    );
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };
    const failed = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(failed.status).toBe("failed");

    const legacy = openDatabase({ path: dbPath });
    legacy.prepare("UPDATE workflow_runs SET isolation_enabled = NULL WHERE id = ?").run(runId);
    legacy.close();

    const workflow = catalog.get("preflight-legacy", { projectId });
    if (!workflow) throw new Error("workflow missing from catalog");
    workflow.nodes = [{ id: "probe", bash: "touch sentinel.txt" }];

    const resume = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}/resume-run`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(resume.status).toBe(409);
    expect(await resume.json()).toEqual({
      error: `run '${runId}' isolation choice is unavailable and cannot be safely resumed`,
    });
    expect(store.getRun(runId)?.error).toContain("preflight failed:");
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
  });

  test("resume refuses required isolation after nodes ran without a worktree", async () => {
    writeWorkflow(
      "historical-fallback.yaml",
      `name: historical-fallback
description: a historical required-isolation run that fell back in place
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
    );
    const rig = makeRig();
    const runId = "historical-required-fallback";
    rig.store.createRun({
      runId,
      workflowName: "historical-fallback",
      inputs: {},
      startedAt: new Date().toISOString(),
      conversationId: rig.conversationStore.create({ providerId: "workflow" }).id,
      projectId: rig.projectId,
      workingDir: repoDir,
      isolationEnabled: true,
    });
    rig.store.upsertNodeOutput({
      runId,
      nodeId: "work",
      status: "failed",
      outputText: null,
      contentParts: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "historical failure",
      usage: null,
      provider: null,
      model: null,
      effort: null,
    });
    rig.store.updateRunStatus({
      runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "historical failure",
    });

    expect(rig.controller.resumeRun(runId)).toEqual({
      ok: false,
      reason: "isolation_unavailable",
      message: `run '${runId}' executed nodes without its required worktree; start a fresh isolated run instead`,
    });
    expect(rig.store.getRun(runId)?.error).toBe("historical failure");

    const legacy = openDatabase({ path: dbPath });
    legacy.prepare("UPDATE workflow_runs SET isolation_enabled = NULL WHERE id = ?").run(runId);
    legacy.close();
    expect(rig.controller.resumeRun(runId)).toEqual({
      ok: false,
      reason: "isolation_unavailable",
      message: `run '${runId}' isolation choice is unavailable and cannot be safely resumed`,
    });
    expect(rig.store.getRun(runId)?.error).toBe("historical failure");
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
  });

  async function cancelDuringPreflight(name: string, model: string, catalog: "offline" | "listed") {
    await initRepo(repoDir);
    const capabilities = {
      sessionResume: false,
      streaming: false,
      tools: false,
      reasoningEffort: false,
      models: ["slow-model"],
      defaultModel: "slow-model",
    };
    registerProvider({
      id: "slow-cancel-catalog",
      displayName: "Slow cancel catalog",
      capabilities,
      builtIn: false,
      factory: () => ({
        getType: () => "slow-cancel-catalog",
        getCapabilities: () => capabilities,
        async *sendQuery() {
          yield { type: "done" as const };
        },
        async listModels() {
          throw new Error("offline");
        },
        async listModelsLive() {
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (catalog === "offline") throw new Error("offline");
          return [{ id: "slow-model" }];
        },
      }),
    });
    writeWorkflow(
      `${name}.yaml`,
      `name: ${name}
description: cancel while the live catalog lookup is pending
provider: slow-cancel-catalog
worktree:
  enabled: true
nodes:
  - id: pinned
    model: ${model}
    prompt: run
`,
    );
    const rig = makeRig();
    const start = await rig.app.fetch(
      new Request(`http://test/api/workflows/${name}/runs`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId: rig.projectId }),
      }),
    );
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };
    const cancel = await rig.app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(cancel.status).toBe(200);
    const cancelled = (await pollUntilTerminal(rig.app, runId)) as {
      status: string;
      worktreePath: string | null;
      preflightNotice: string | null;
    };
    expect(cancelled.status).toBe("cancelled");
    const resume = () =>
      rig.app.fetch(
        new Request(`http://test/api/workflows/runs/${runId}/resume-run`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
    return { ...rig, runId, cancelled, resume };
  }

  test("a run cancelled during preflight never prepares a worktree", async () => {
    try {
      const { cancelled } = await cancelDuringPreflight(
        "preflight-cancel",
        "slow-model",
        "offline",
      );
      expect(cancelled.worktreePath).toBeNull();
      expect(cancelled.preflightNotice).toBeNull();
      expect(existsSync(join(repoDir, ".worktrees"))).toBe(false);
    } finally {
      unregisterProvider("slow-cancel-catalog");
    }
  });

  test("resuming a run cancelled during preflight restores its isolation", async () => {
    try {
      const rig = await cancelDuringPreflight("preflight-cancel-iso", "slow-model", "listed");
      const workflow = rig.catalog.get("preflight-cancel-iso", { projectId: rig.projectId });
      if (!workflow) throw new Error("workflow missing from catalog");
      workflow.nodes = [{ id: "pinned", bash: "pwd; touch sentinel.txt" }];

      expect((await rig.resume()).status).toBe(200);
      const completed = (await pollUntilTerminal(rig.app, rig.runId)) as {
        status: string;
        nodes: Array<{ outputText: string | null }>;
      };
      expect(completed.status).toBe("succeeded");
      expect(completed.nodes[0]?.outputText?.replace(/\\/g, "/")).toContain("/.worktrees/");
      expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);
    } finally {
      unregisterProvider("slow-cancel-catalog");
    }
  });

  test("resuming a run cancelled during preflight still runs the preflight gate", async () => {
    try {
      const rig = await cancelDuringPreflight("preflight-cancel-gate", "retired-model", "listed");
      expect((await rig.resume()).status).toBe(200);
      const resumed = (await pollUntilTerminal(rig.app, rig.runId)) as {
        status: string;
        error: string | null;
      };
      expect(resumed.status).toBe("failed");
      expect(resumed.error).toContain("preflight failed");
    } finally {
      unregisterProvider("slow-cancel-catalog");
    }
  });

  test("worktree isolation still runs when workspaceManager is omitted", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso-no-manager.yaml",
      `name: iso-no-manager
description: isolate with primitive fallback
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig({ includeWorkspaceManager: false });
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso-no-manager/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);

    const cleared = (await pollUntilWorktreeCleared(app, runId)) as {
      worktreePath: string | null;
    };
    expect(cleared.worktreePath).toBeNull();
  });

  test("refresh honors a bound producer's worktree.enabled policy", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "isoprod.yaml",
      `name: isoprod
description: a bound producer that opts into worktree isolation
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const workspaceManager = createWorkspaceManager({
      store: createWorkspaceLeaseStore(db),
      projectsStore,
    });
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const producer = catalog.get("isoprod");
    if (!producer) throw new Error("fixture workflow missing");
    const bindings = new Map([[producer, { publish: () => {} }]]);
    const app = new Hono();
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore,
      refreshCwd: repoDir,
      ribWorkflowBindings: bindings,
      workspaceManager,
    });
    const res = await app.fetch(
      new Request("http://test/api/workflows/isoprod/refresh", {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    // The refresh ran in an isolated worktree, not the live checkout — without
    // honoring the policy this pwd would be `repoDir`.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);
  });

  test("isolation:none override defeats YAML default and runs in place", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso.yaml",
      `name: iso2
description: same isolation default, opt-out per run
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso2/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "none" }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
      worktreePath: string | null;
    };
    expect(run.status).toBe("succeeded");
    expect(run.worktreePath).toBeNull();
    // pwd should be the repo root, not a worktree.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed!.includes(`${sep}.worktrees${sep}`)).toBe(false);
  });

  test("isolation requested but target is not a git repo: fails before nodes", async () => {
    // Skip initRepo — directory is not a git repo.
    writeWorkflow(
      "bare.yaml",
      `name: bare
description: bash echoing cwd
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/bare/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "worktree" }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      worktreePath: string | null;
      error: string | null;
      nodes: unknown[];
    };
    expect(run.status).toBe("failed");
    expect(run.worktreePath).toBeNull();
    expect(run.error).toContain("worktree setup failed:");
    expect(run.nodes).toEqual([]);
  });

  test("default base refreshes origin and excludes divergent checkout commits", async () => {
    await initRepo(repoDir);
    await addOrigin(repoDir);
    const staleOriginTip = (await gitText(["rev-parse", "origin/main"], repoDir)).trim();
    const upstream = join(tmpDir, "upstream");
    await git(["clone", join(repoDir, "origin.git"), upstream], tmpDir);
    await git(["config", "user.email", "t@t"], upstream);
    await git(["config", "user.name", "t"], upstream);
    writeFileSync(join(upstream, "upstream.txt"), "new tip\n");
    await git(["add", "upstream.txt"], upstream);
    await git(["commit", "-m", "advance remote"], upstream);
    await git(["push", "origin", "main"], upstream);
    const remoteTip = (await gitText(["rev-parse", "HEAD"], upstream)).trim();
    expect((await gitText(["rev-parse", "origin/main"], repoDir)).trim()).toBe(staleOriginTip);

    await git(["checkout", "-b", "feature"], repoDir);
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    await git(["add", "feature.txt"], repoDir);
    await git(["commit", "-m", "feature"], repoDir);
    writeWorkflow(
      "base.yaml",
      `name: basecheck
description: verify isolated worktree starts from default branch
worktree:
  enabled: true
nodes:
  - id: no-feature
    bash: |
      test -f upstream.txt
      test ! -f feature.txt
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/basecheck/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      worktreeBase: string | null;
    };

    expect(run.status).toBe("succeeded");
    expect(run.worktreeBase).toBe("origin/main");
    expect((await gitText(["rev-parse", "origin/main"], repoDir)).trim()).toBe(remoteTip);
    const branch = `keelson/basecheck/${runId.slice(0, 8)}`;
    expect((await gitText(["log", "--oneline", `origin/main..${branch}`], repoDir)).trim()).toBe(
      "",
    );
  }, 15_000);

  test("failed run keeps its worktree on disk for inspection", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "boom.yaml",
      `name: boom
description: deliberate failure inside a worktree
worktree:
  enabled: true
nodes:
  - id: blow
    bash: exit 1
`,
    );
    const { app, store, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/boom/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(run.status).toBe("failed");

    const detail = store.getRun(runId);
    expect(detail).toBeDefined();
    expect(detail!.worktreePath).not.toBeNull();
    // The worktree directory should still exist for the operator to inspect.
    expect(existsSync(detail!.worktreePath!)).toBe(true);
  });
});

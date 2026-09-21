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
  return { app, store, conversationStore, controller, workspaceManager, projectId: project.id };
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

describe("workflow run worktree isolation (slice 3)", () => {
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

  test("isolation requested but target is not a git repo: warns, runs in place", async () => {
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
    };
    // Run still succeeds — the warning is broadcast as a run_warning and
    // execution falls back to the repo path.
    expect(run.status).toBe("succeeded");
    expect(run.worktreePath).toBeNull();
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

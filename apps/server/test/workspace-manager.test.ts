// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore, type ProjectsStore } from "../src/projects-store.ts";
import {
  createWorkspaceLeaseStore,
  type WorkspaceLeaseStore,
} from "../src/workspace-lease-store.ts";
import {
  createWorkspaceManager,
  type WorkspaceManager,
  WorkspaceProjectNotFoundError,
  WorkspaceProjectNotGitRepoError,
} from "../src/workspace-manager.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let repoDir: string;
let dbPath: string;
let db: Database;
let projectsStore: ProjectsStore;
let leaseStore: WorkspaceLeaseStore;
let manager: WorkspaceManager;

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err}`);
  }
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "test@example.com"], path);
  await git(["config", "user.name", "Test"], path);
  await git(["config", "core.autocrlf", "false"], path);
  writeFileSync(join(path, "README.md"), "test repo\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "initial"], path);
}

beforeEach(() => {
  tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "keelson-workspace-manager-")));
  repoDir = join(tmpDir, "repo");
  mkdirSync(repoDir);
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  projectsStore = createProjectsStore(db);
  leaseStore = createWorkspaceLeaseStore(db);
  manager = createWorkspaceManager({ store: leaseStore, projectsStore });
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("WorkspaceManager", () => {
  test("prepareWorktree creates a branch-ready checkout and installs/skips deps", async () => {
    await initRepo(repoDir);
    const dest = join(repoDir, ".worktrees", "prepared");

    const prepared = await manager.prepareWorktree({
      repoPath: repoDir,
      branch: "keelson/lease/prepared",
      dest,
    });

    expect(prepared.worktreePath).toBe(dest);
    expect(prepared.adopted).toBe(false);
    expect(prepared.branchCreated).toBe(true);
    expect(prepared.deps.skipped).toBe("no-manifest");
    expect(prepared.depsError).toBeNull();
    expect(existsSync(dest)).toBe(true);

    const removed = await manager.removeWorktree({ repoPath: repoDir, dest, force: true });
    expect(removed.removed).toBe(true);
  });

  test("acquire records a lease and release removes the worktree and row", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });

    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "fix-issue",
      owner: "rib:test",
    });

    expect(lease.id.length).toBeGreaterThan(0);
    expect(lease.branch).toMatch(/^keelson\/lease\/fix-issue\//);
    expect(existsSync(lease.path)).toBe(true);
    expect(leaseStore.get(lease.id)).toMatchObject({
      id: lease.id,
      projectId: project.id,
      purpose: "fix-issue",
      owner: "rib:test",
      branch: lease.branch,
      worktreePath: lease.path,
    });

    await lease.release();
    expect(existsSync(lease.path)).toBe(false);
    expect(leaseStore.get(lease.id)).toBeUndefined();
  });

  test("acquire slugifies free-text purpose for derived branch names", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });

    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "fix issue #525",
      owner: "tool",
    });

    expect(lease.branch).toMatch(/^keelson\/lease\/fix-issue-525\//);
    expect(leaseStore.get(lease.id)?.purpose).toBe("fix issue #525");
    await manager.release(lease.id);
  });

  test("acquire persists the lease row before worktree preparation", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    let rowsSeenDuringPrepare = leaseStore.list();
    let branchSeenDuringPrepare = "";
    let destSeenDuringPrepare = "";

    manager.prepareWorktree = async (req) => {
      rowsSeenDuringPrepare = leaseStore.list();
      branchSeenDuringPrepare = req.branch;
      destSeenDuringPrepare = req.dest;
      throw new Error("prepare failed");
    };

    await expect(
      manager.acquire({
        projectId: project.id,
        purpose: "hydrate row first",
        owner: "tool",
      }),
    ).rejects.toThrow("prepare failed");

    expect(rowsSeenDuringPrepare).toHaveLength(1);
    expect(rowsSeenDuringPrepare[0]?.branch).toBe(branchSeenDuringPrepare);
    expect(rowsSeenDuringPrepare[0]?.worktreePath).toBe(destSeenDuringPrepare);
    expect(leaseStore.list()).toEqual([]);
  });

  test("acquire fails and cleans up when dependency install fails", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const removeCalls: Array<{ repoPath: string; dest: string; force?: boolean }> = [];

    manager.prepareWorktree = async (req) => ({
      worktreePath: req.dest,
      adopted: false,
      branchCreated: true,
      deps: {
        installed: false,
        skipped: null,
        error: "bun install failed (exit 1): lock mismatch",
        durationMs: 1,
      },
      depsError: "bun install failed (exit 1): lock mismatch",
    });
    manager.removeWorktree = async (opts) => {
      removeCalls.push(opts);
      return { removed: true, warning: null };
    };

    await expect(
      manager.acquire({
        projectId: project.id,
        purpose: "deps",
        owner: "tool",
      }),
    ).rejects.toThrow("workspace dependency install failed");

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toMatchObject({
      repoPath: repoDir,
      force: true,
    });
    expect(leaseStore.list()).toEqual([]);
  });

  test("acquire fails and cleans up when preparation is aborted", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const removeCalls: Array<{ repoPath: string; dest: string; force?: boolean }> = [];

    manager.prepareWorktree = async (req) => ({
      worktreePath: req.dest,
      adopted: false,
      branchCreated: true,
      deps: { installed: false, skipped: "aborted", error: null, durationMs: 1 },
      depsError: null,
    });
    manager.removeWorktree = async (opts) => {
      removeCalls.push(opts);
      return { removed: true, warning: null };
    };

    await expect(
      manager.acquire({
        projectId: project.id,
        purpose: "cancelled",
        owner: "tool",
      }),
    ).rejects.toThrow("aborted during dependency preparation");

    expect(removeCalls).toHaveLength(1);
    expect(leaseStore.list()).toEqual([]);
  });

  test("prepareWorktree rejects an adopted destination before touching deps", async () => {
    await initRepo(repoDir);
    const dest = join(repoDir, ".worktrees", "held");
    await git(["worktree", "add", "-b", "keelson/lease/held", dest], repoDir);
    let depsCalls = 0;
    manager.prepareDeps = async () => {
      depsCalls += 1;
      return { installed: false, skipped: "no-manifest", error: null, durationMs: 1 };
    };

    await expect(
      manager.prepareWorktree({
        repoPath: repoDir,
        branch: "keelson/lease/held",
        dest,
        rejectAdopted: true,
      }),
    ).rejects.toThrow("refusing to adopt");

    expect(depsCalls).toBe(0);
    expect(existsSync(dest)).toBe(true);
  });

  test("acquire rejects an adopted destination without removing it", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const removeCalls: unknown[] = [];
    manager.prepareWorktree = async (req) => {
      if (req.rejectAdopted === true) {
        throw new Error(
          `workspace destination already exists at ${req.dest} — refusing to adopt another owner's checkout`,
        );
      }
      throw new Error("expected rejectAdopted to be requested");
    };
    manager.removeWorktree = async (opts) => {
      removeCalls.push(opts);
      return { removed: true, warning: null };
    };

    await expect(
      manager.acquire({ projectId: project.id, purpose: "steal", owner: "tool" }),
    ).rejects.toThrow("refusing to adopt");

    expect(removeCalls).toHaveLength(0);
    expect(leaseStore.list()).toEqual([]);
  });

  test("acquire keeps the lease row when failure cleanup itself fails", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    manager.prepareWorktree = async (req) => ({
      worktreePath: req.dest,
      adopted: false,
      branchCreated: true,
      deps: { installed: false, skipped: null, error: "boom", durationMs: 1 },
      depsError: "boom",
    });
    manager.removeWorktree = async () => ({ removed: false, warning: "removal failed" });

    await expect(
      manager.acquire({ projectId: project.id, purpose: "sticky", owner: "tool" }),
    ).rejects.toThrow("dependency install failed");

    expect(leaseStore.list()).toHaveLength(1);
  });

  test("release refuses a lease whose acquisition is still in flight", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    let releaseError: Error | null = null;
    manager.prepareWorktree = async (req) => {
      const pending = leaseStore.list()[0];
      if (pending) {
        await manager.release(pending.id).catch((err) => {
          releaseError = err as Error;
        });
      }
      return {
        worktreePath: req.dest,
        adopted: false,
        branchCreated: true,
        deps: { installed: false, skipped: "no-manifest", error: null, durationMs: 1 },
        depsError: null,
      };
    };

    await manager.acquire({ projectId: project.id, purpose: "inflight", owner: "tool" });

    expect(releaseError?.message ?? "").toContain("acquisition still in progress");
    expect(leaseStore.list()).toHaveLength(1);
  });

  test("acquire honors an explicit branch", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });

    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "manual",
      branch: "keelson/lease/custom-branch",
      owner: "tool",
    });

    expect(lease.branch).toBe("keelson/lease/custom-branch");
    expect(lease.path).toBe(join(repoDir, ".worktrees", "custom-branch"));
    await manager.release(lease.id);
  });

  test("release is idempotent", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "cleanup",
      owner: "tool",
    });

    await manager.release(lease.id);
    await manager.release(lease.id);
    await manager.release("missing");

    expect(leaseStore.get(lease.id)).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
  });

  test("acquire throws typed errors for missing or non-git projects", async () => {
    await expect(
      manager.acquire({ projectId: "missing", purpose: "fix", owner: "tool" }),
    ).rejects.toBeInstanceOf(WorkspaceProjectNotFoundError);

    const project = projectsStore.create({ name: "plain", rootPath: repoDir });
    await expect(
      manager.acquire({ projectId: project.id, purpose: "fix", owner: "tool" }),
    ).rejects.toBeInstanceOf(WorkspaceProjectNotGitRepoError);
  });

  test("reconcile drops vanished lease rows and keeps registered worktrees", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "reconcile",
      owner: "tool",
    });
    leaseStore.insert({
      id: "vanished",
      projectId: project.id,
      purpose: "gone",
      owner: "tool",
      branch: "keelson/lease/gone",
      worktreePath: join(repoDir, ".worktrees", "gone"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    });

    await manager.reconcile();

    expect(leaseStore.get(lease.id)).toBeDefined();
    expect(leaseStore.get("vanished")).toBeUndefined();
    await manager.release(lease.id);
  });

  test("reconcile drops rows whose path is not a registered worktree", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const unregistered = join(repoDir, ".worktrees", "not-registered");
    mkdirSync(unregistered, { recursive: true });
    leaseStore.insert({
      id: "unregistered",
      projectId: project.id,
      purpose: "bad",
      owner: "tool",
      branch: "keelson/lease/not-registered",
      worktreePath: unregistered,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    });

    await manager.reconcile();

    expect(leaseStore.get("unregistered")).toBeUndefined();
    rmSync(unregistered, { recursive: true, force: true });
  });

  test("reconcile keeps rows when registration cannot be determined", async () => {
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const pending = join(repoDir, ".worktrees", "indeterminate");
    mkdirSync(pending, { recursive: true });
    leaseStore.insert({
      id: "indeterminate",
      projectId: project.id,
      purpose: "keep",
      owner: "tool",
      branch: "keelson/lease/keep",
      worktreePath: pending,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    });

    await manager.reconcile();

    expect(leaseStore.get("indeterminate")).toBeDefined();
  });

  test("reconcile drops a pending row and removes its half-prepared checkout", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const dest = join(repoDir, ".worktrees", "crashed");
    await git(["worktree", "add", "-b", "keelson/lease/crashed", dest], repoDir);
    leaseStore.insert({
      id: "crashed",
      projectId: project.id,
      purpose: "crashed",
      owner: "tool",
      branch: "keelson/lease/crashed",
      worktreePath: dest,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
    });

    await manager.reconcile();

    expect(leaseStore.get("crashed")).toBeUndefined();
    expect(existsSync(dest)).toBe(false);
  });

  test("reconcile refreshes the stored branch instead of dropping a switched lease", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "switch",
      owner: "tool",
    });
    await git(["checkout", "-b", "feature/renamed"], lease.path);

    await manager.reconcile();

    const record = leaseStore.get(lease.id);
    expect(record).toBeDefined();
    expect(record?.branch).toBe("feature/renamed");
    await manager.release(lease.id);
  });

  test("concurrent releases of one lease are idempotent", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "double-release",
      owner: "tool",
    });

    await Promise.all([manager.release(lease.id), manager.release(lease.id)]);

    expect(leaseStore.get(lease.id)).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
  });

  test("acquire marks the lease active only after preparation succeeds", async () => {
    await initRepo(repoDir);
    const project = projectsStore.create({ name: "repo", rootPath: repoDir });
    const lease = await manager.acquire({
      projectId: project.id,
      purpose: "status",
      owner: "tool",
    });
    expect(leaseStore.get(lease.id)?.status).toBe("active");
    await manager.release(lease.id);
  });
});

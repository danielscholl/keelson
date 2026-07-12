// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { createWorkspaceLeaseStore } from "../src/workspace-lease-store.ts";
import { migrateLegacyProjectsLayout } from "../src/workspace-migration.ts";
import { rmTemp } from "./temp.ts";

let workspace: string;
let dbPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "keelson-ws-migrate-"));
  dbPath = join(workspace, "keelson.db");
});

afterEach(() => {
  rmTemp(workspace);
});

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  // Drain both pipes even on success: an undrained stderr read-end stays an open
  // handle on win32 and blocks bun test from exiting (the Windows CI hang).
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${err}`);
  }
  return out;
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "t@t"], path);
  await git(["config", "user.name", "t"], path);
  writeFileSync(join(path, "README.md"), "x\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "init"], path);
}

describe("migrateLegacyProjectsLayout", () => {
  test("flattens projects/, preserves _default contents, repairs moved worktrees", async () => {
    const legacy = join(workspace, "projects");
    const legacyDefault = join(legacy, "_default");
    const legacyFoo = join(legacy, "foo");
    mkdirSync(legacyDefault, { recursive: true });
    mkdirSync(legacyFoo, { recursive: true });
    // A file the default project accumulated must survive the flatten.
    writeFileSync(join(legacyDefault, "notes.md"), "keepme\n");
    writeFileSync(join(legacyFoo, "marker.txt"), "x\n");

    // foo is a real repo with a real workspace-scoped worktree registered in it.
    await initRepo(legacyFoo);
    const legacyWorktree = join(legacy, "_worktrees", "foo", "br");
    mkdirSync(join(legacy, "_worktrees", "foo"), { recursive: true });
    await git(["worktree", "add", "-b", "keelson/x/br", legacyWorktree], legacyFoo);

    const db = openDatabase({ path: dbPath });
    const projectsStore = createProjectsStore(db);
    const workflowStore = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const def = projectsStore.create({ name: "default", rootPath: legacyDefault });
    const foo = projectsStore.create({ name: "foo", rootPath: legacyFoo });
    const conv = conversationStore.create({ providerId: "stub" });
    workflowStore.createRun({
      runId: "r1",
      workflowName: "wf",
      inputs: {},
      startedAt: "2026-01-01T00:00:00.000Z",
      conversationId: conv.id,
      projectId: foo.id,
      workingDir: legacyFoo,
      worktreePath: legacyWorktree,
    });

    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });

    // Default project collapses into the workspace root, contents and all.
    expect(projectsStore.get(def.id)?.rootPath).toBe(workspace);
    expect(readFileSync(join(workspace, "notes.md"), "utf-8")).toBe("keepme\n");
    // Named project moves to <workspace>/foo with its contents.
    const movedFoo = join(workspace, "foo");
    expect(projectsStore.get(foo.id)?.rootPath).toBe(movedFoo);
    expect(existsSync(join(movedFoo, "marker.txt"))).toBe(true);
    // Worktree moves to the repo-local .worktrees dir and the run row follows.
    const movedWorktree = join(movedFoo, ".worktrees", "br");
    expect(existsSync(movedWorktree)).toBe(true);
    expect(workflowStore.getRun("r1")?.worktreePath).toBe(movedWorktree);
    // Git metadata was repaired: the moved worktree is functional and the
    // repo no longer lists the stale legacy path.
    expect((await git(["rev-parse", "--is-inside-work-tree"], movedWorktree)).trim()).toBe("true");
    const list = await git(["worktree", "list", "--porcelain"], movedFoo);
    expect(list.includes("_worktrees")).toBe(false);
    // The legacy projects/ tree is gone.
    expect(existsSync(legacy)).toBe(false);

    // Idempotent: a second sweep no-ops (source paths are gone).
    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });
    expect(projectsStore.get(foo.id)?.rootPath).toBe(movedFoo);
    expect(existsSync(movedWorktree)).toBe(true);

    db.close();
  });

  test("repairs repo-local worktrees that ride along with a moved project dir", async () => {
    const legacy = join(workspace, "projects");
    const legacyBar = join(legacy, "bar");
    mkdirSync(legacyBar, { recursive: true });
    await initRepo(legacyBar);
    // bar already used repo-local layout: its worktree lives inside the repo.
    const legacyWorktree = join(legacyBar, ".worktrees", "br");
    await git(["worktree", "add", "-b", "keelson/y/br", legacyWorktree], legacyBar);

    const db = openDatabase({ path: dbPath });
    const projectsStore = createProjectsStore(db);
    const workflowStore = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const bar = projectsStore.create({ name: "bar", rootPath: legacyBar });
    const conv = conversationStore.create({ providerId: "stub" });
    workflowStore.createRun({
      runId: "r1",
      workflowName: "wf",
      inputs: {},
      startedAt: "2026-01-01T00:00:00.000Z",
      conversationId: conv.id,
      projectId: bar.id,
      workingDir: legacyBar,
      worktreePath: legacyWorktree,
    });
    const leaseStore = createWorkspaceLeaseStore(db);
    leaseStore.insert({
      id: "lease-1",
      projectId: bar.id,
      purpose: "test",
      owner: "tool",
      branch: "keelson/y/br",
      worktreePath: legacyWorktree,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    });

    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });

    const movedBar = join(workspace, "bar");
    const movedWorktree = join(movedBar, ".worktrees", "br");
    expect(projectsStore.get(bar.id)?.rootPath).toBe(movedBar);
    // The run row that pointed at the old repo-local path now points at the new one.
    expect(workflowStore.getRun("r1")?.worktreePath).toBe(movedWorktree);
    // The lease row moved with it.
    expect(leaseStore.get("lease-1")?.worktreePath).toBe(movedWorktree);
    // Git metadata was repaired: the moved worktree resolves and the repo lists
    // no stale path under the old projects/ location.
    expect((await git(["rev-parse", "--is-inside-work-tree"], movedWorktree)).trim()).toBe("true");
    const list = await git(["worktree", "list", "--porcelain"], movedBar);
    expect(list.includes(join("projects", "bar"))).toBe(false);
    db.close();
  });

  test("targets an externally-registered project's own rootPath for worktrees", () => {
    // foo is registered from a path OUTSIDE projects/; its workspace-scoped
    // worktree must migrate under foo's real rootPath, not <workspace>/foo.
    const legacy = join(workspace, "projects");
    const externalFoo = join(workspace, "external", "foo");
    const legacyWorktree = join(legacy, "_worktrees", "foo", "br");
    mkdirSync(externalFoo, { recursive: true });
    mkdirSync(legacyWorktree, { recursive: true });

    const db = openDatabase({ path: dbPath });
    const projectsStore = createProjectsStore(db);
    projectsStore.create({ name: "foo", rootPath: externalFoo });

    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });

    expect(existsSync(join(externalFoo, ".worktrees", "br"))).toBe(true);
    expect(existsSync(join(workspace, "foo"))).toBe(false);
    db.close();
  });

  test("leaves a collided worktree (and its bucket) in place rather than deleting it", () => {
    const legacy = join(workspace, "projects");
    const fooRoot = join(workspace, "foo");
    const legacyWorktree = join(legacy, "_worktrees", "foo", "br");
    mkdirSync(legacyWorktree, { recursive: true });
    // Destination already occupied → migration must skip AND not delete the source.
    const occupied = join(fooRoot, ".worktrees", "br");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "existing.txt"), "keep\n");

    const db = openDatabase({ path: dbPath });
    const projectsStore = createProjectsStore(db);
    projectsStore.create({ name: "foo", rootPath: fooRoot });

    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });

    expect(existsSync(legacyWorktree)).toBe(true);
    expect(readFileSync(join(occupied, "existing.txt"), "utf-8")).toBe("keep\n");
    db.close();
  });

  test("no-ops when there is no legacy projects/ directory", () => {
    const db = openDatabase({ path: dbPath });
    const projectsStore = createProjectsStore(db);
    const p = projectsStore.create({ name: "live", rootPath: join(workspace, "live") });

    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });

    expect(projectsStore.get(p.id)?.rootPath).toBe(join(workspace, "live"));
    db.close();
  });
});

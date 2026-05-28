// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { migrateLegacyProjectsLayout } from "../src/workspace-migration.ts";

let workspace: string;
let dbPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "keelson-ws-migrate-"));
  dbPath = join(workspace, "keelson.db");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("migrateLegacyProjectsLayout", () => {
  test("flattens projects/, collapses _default, moves worktrees, updates rows", () => {
    const legacy = join(workspace, "projects");
    const legacyDefault = join(legacy, "_default");
    const legacyFoo = join(legacy, "foo");
    const legacyWorktree = join(legacy, "_worktrees", "foo", "br");
    mkdirSync(legacyDefault, { recursive: true });
    mkdirSync(legacyFoo, { recursive: true });
    mkdirSync(legacyWorktree, { recursive: true });
    writeFileSync(join(legacyFoo, "marker.txt"), "x\n");

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

    // Default project collapses into the workspace root itself.
    expect(projectsStore.get(def.id)?.rootPath).toBe(workspace);
    // Named project moves to <workspace>/foo with its contents.
    const movedFoo = join(workspace, "foo");
    expect(projectsStore.get(foo.id)?.rootPath).toBe(movedFoo);
    expect(existsSync(join(movedFoo, "marker.txt"))).toBe(true);
    // Worktree moves to the repo-local .worktrees dir and the run row follows.
    const movedWorktree = join(movedFoo, ".worktrees", "br");
    expect(existsSync(movedWorktree)).toBe(true);
    expect(workflowStore.getRun("r1")?.worktreePath).toBe(movedWorktree);
    // The legacy projects/ tree is gone.
    expect(existsSync(legacy)).toBe(false);

    // Idempotent: a second sweep no-ops (source paths are gone).
    migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: workspace });
    expect(projectsStore.get(foo.id)?.rootPath).toBe(movedFoo);
    expect(existsSync(movedWorktree)).toBe(true);

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

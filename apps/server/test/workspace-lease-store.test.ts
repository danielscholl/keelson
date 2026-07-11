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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import {
  createWorkspaceLeaseStore,
  type WorkspaceLeaseRecord,
  type WorkspaceLeaseStore,
} from "../src/workspace-lease-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: WorkspaceLeaseStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workspace-lease-store-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  store = createWorkspaceLeaseStore(db);
});

afterEach(() => {
  rmTemp(tmpDir);
});

function lease(overrides: Partial<WorkspaceLeaseRecord> = {}): WorkspaceLeaseRecord {
  return {
    id: "lease-1",
    projectId: null,
    purpose: "fix-issue",
    owner: "tool",
    branch: "keelson/lease/fix-issue/abc123",
    worktreePath: join(tmpDir, "repo", ".worktrees", "abc123"),
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

describe("WorkspaceLeaseStore", () => {
  test("insert, get, list, and delete round-trip a lease", () => {
    const record = lease();
    store.insert(record);

    expect(store.get(record.id)).toEqual(record);
    expect(store.list()).toEqual([record]);
    expect(store.delete(record.id)).toBe(true);
    expect(store.delete(record.id)).toBe(false);
    expect(store.get(record.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test("list orders newest leases first", () => {
    const older = lease({
      id: "lease-older",
      worktreePath: join(tmpDir, "older"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    });
    const newer = lease({
      id: "lease-newer",
      worktreePath: join(tmpDir, "newer"),
      createdAt: "2026-01-02T00:00:00.000Z",
      status: "active",
    });
    store.insert(older);
    store.insert(newer);

    expect(store.list().map((record) => record.id)).toEqual(["lease-newer", "lease-older"]);
  });

  test("unique worktree paths are enforced", () => {
    store.insert(lease({ id: "lease-a" }));
    expect(() => store.insert(lease({ id: "lease-b" }))).toThrow();
  });

  test("project deletion sets projectId to null", () => {
    const projects = createProjectsStore(db);
    const project = projects.create({ name: "repo", rootPath: join(tmpDir, "repo") });
    store.insert(lease({ projectId: project.id }));

    expect(store.get("lease-1")?.projectId).toBe(project.id);
    expect(projects.delete(project.id)).toBe(true);
    expect(store.get("lease-1")?.projectId).toBeNull();
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkspaceLeaseStore } from "../src/workspace-lease-store.ts";
import { workspaceRoutes } from "../src/workspace-routes.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workspace-routes-"));
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("workspace routes", () => {
  test("GET /api/workspaces/leases returns serializable lease records", async () => {
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const projectsStore = createProjectsStore(db);
    const store = createWorkspaceLeaseStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: join(tmpDir, "repo") });
    const lease = {
      id: "lease-1",
      projectId: project.id,
      purpose: "fix",
      owner: "tool",
      branch: "keelson/lease/fix/abc123",
      worktreePath: join(tmpDir, "repo", ".worktrees", "abc123"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active" as const,
    };
    store.insert(lease);
    const app = new Hono();
    workspaceRoutes(app, { store });

    const res = await app.fetch(new Request("http://test/api/workspaces/leases"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leases: [lease] });
  });
});

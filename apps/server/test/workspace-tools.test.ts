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
import type { MessageChunk, ToolContext, ToolDefinition } from "@keelson/shared";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore, type ProjectsStore } from "../src/projects-store.ts";
import type { AcquireWorkspaceManagerRequest, WorkspaceManager } from "../src/workspace-manager.ts";
import { createWorkspaceTools } from "../src/workspace-tools.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let projectsStore: ProjectsStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workspace-tools-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  projectsStore = createProjectsStore(db);
});

afterEach(() => {
  rmTemp(tmpDir);
});

function makeCtx(): { ctx: ToolContext; chunks: MessageChunk[] } {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: tmpDir,
    emit: (chunk) => chunks.push(chunk),
    abortSignal: new AbortController().signal,
  };
  return { ctx, chunks };
}

function lastToolResult(chunks: MessageChunk[]): { content: string; isError: boolean } {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk && chunk.type === "tool_result") {
      return { content: chunk.content, isError: chunk.isError ?? false };
    }
  }
  throw new Error("no tool_result chunk was emitted");
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not registered`);
  return tool;
}

function fakeManager(overrides: Partial<WorkspaceManager> = {}): WorkspaceManager {
  return {
    prepareDeps: async () => ({ installed: false, skipped: "no-manifest", error: null, durationMs: 0 }),
    prepareWorktree: async () => {
      throw new Error("not used");
    },
    removeWorktree: async () => ({ removed: false, warning: null }),
    acquire: async () => {
      throw new Error("not used");
    },
    release: async () => {},
    list: () => [],
    reconcile: async () => {},
    ...overrides,
  };
}

describe("workspace tools", () => {
  test("workspace_lease acquires a lease for a project id or name", async () => {
    const project = projectsStore.create({ name: "repo", rootPath: join(tmpDir, "repo") });
    const calls: AcquireWorkspaceManagerRequest[] = [];
    const manager = fakeManager({
      acquire: async (req) => {
        calls.push(req);
        return {
          id: "lease-1",
          path: join(tmpDir, "repo", ".worktrees", "abc123"),
          branch: "keelson/lease/fix/abc123",
          release: async () => {},
        };
      },
    });
    const tools = createWorkspaceTools({ manager, projectsStore });
    const leaseTool = toolByName(tools, "workspace_lease");
    expect(leaseTool.state_changing).toBe(true);

    const { ctx, chunks } = makeCtx();
    await leaseTool.execute({ project: "repo", purpose: "fix", branch: "custom/abc123" }, ctx);

    expect(calls).toEqual([
      { projectId: project.id, purpose: "fix", owner: "tool", branch: "custom/abc123" },
    ]);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Workspace lease lease-1 acquired.");
    expect(result.content).toContain("Path:");
    expect(result.content).toContain("Branch: keelson/lease/fix/abc123");
  });

  test("workspace_lease returns an error for unknown projects and manager failures", async () => {
    const tools = createWorkspaceTools({
      manager: fakeManager({
        acquire: async () => {
          throw new Error("not a git repository");
        },
      }),
      projectsStore,
    });
    const leaseTool = toolByName(tools, "workspace_lease");

    const unknown = makeCtx();
    await leaseTool.execute({ project: "missing", purpose: "fix" }, unknown.ctx);
    expect(lastToolResult(unknown.chunks)).toEqual({
      content: 'unknown project "missing". Use a registered project id or exact project name.',
      isError: true,
    });

    projectsStore.create({ name: "plain", rootPath: join(tmpDir, "plain") });
    const nonGit = makeCtx();
    await leaseTool.execute({ project: "plain", purpose: "fix" }, nonGit.ctx);
    const result = lastToolResult(nonGit.chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a git repository");
  });

  test("workspace_release calls manager.release and is state-changing", async () => {
    const released: string[] = [];
    const tools = createWorkspaceTools({
      manager: fakeManager({
        release: async (id) => {
          released.push(id);
        },
      }),
      projectsStore,
    });
    const releaseTool = toolByName(tools, "workspace_release");
    expect(releaseTool.state_changing).toBe(true);

    const first = makeCtx();
    await releaseTool.execute({ id: "lease-1" }, first.ctx);
    const second = makeCtx();
    await releaseTool.execute({ id: "lease-1" }, second.ctx);

    expect(released).toEqual(["lease-1", "lease-1"]);
    expect(lastToolResult(first.chunks)).toEqual({
      content: "Workspace lease lease-1 released.",
      isError: false,
    });
    expect(lastToolResult(second.chunks).isError).toBe(false);
  });
});

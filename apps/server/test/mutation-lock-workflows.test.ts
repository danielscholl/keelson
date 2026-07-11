// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import { Hono } from "hono";
import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createMutationLockManager } from "../src/mutation-lock-manager.ts";
import { createMutationLockStore } from "../src/mutation-lock-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore, type WorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowSubscribers,
  workflowsRoutes,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

let tmpDir: string;
let wfDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-mutation-lock-workflows-"));
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir);
});

afterEach(() => {
  rmTemp(tmpDir);
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pollUntilStoreStatus(
  store: WorkflowStore,
  runId: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(store.getRun(runId)?.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach expected status`);
}

async function pollUntilTerminal(
  store: WorkflowStore,
  runId: string,
  timeoutMs = 2000,
): Promise<void> {
  await pollUntilStoreStatus(
    store,
    runId,
    (status) => status !== undefined && TERMINAL_STATUSES.has(status),
    timeoutMs,
  );
}

describe("workflow mutation lock enforcement", () => {
  test("a second live-checkout mutating run conflicts until the first settles", async () => {
    writeWorkflow(
      "guarded.yaml",
      `name: guarded
description: waits under the mutation lock
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        mutationLockManager,
      },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      const conflictRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(conflictRes.status).toBe(409);
      const conflict = (await conflictRes.json()) as { error: string };
      expect(conflict.error).toContain(`project ${project.id} is locked by workflow:`);
      expect(conflict.error).toContain('for "guarded"');
      expect(conflict.error).toContain(first.runId.slice(0, 8));

      const isolatedRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
          isolation: "worktree",
        }),
      );
      expect(isolatedRes.status).toBe(200);

      const resumeRes = await app.fetch(
        postJson(`http://test/api/workflows/runs/${first.runId}/resume`, {
          nodeId: "review",
          text: "approve",
        }),
      );
      expect(resumeRes.status).toBe(200);
      await pollUntilTerminal(store, first.runId);

      const afterReleaseRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(afterReleaseRes.status).toBe(200);
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });
});

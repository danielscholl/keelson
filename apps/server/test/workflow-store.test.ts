// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";

let tmpDir: string;
let dbPath: string;

// Helper: every workflow_runs row needs a conversation_id FK target. Mints a
// throwaway workflow-provider conversation on the same db handle.
function mintConv(db: import("bun:sqlite").Database, label?: string): string {
  const convStore = createConversationStore(db);
  const conv = convStore.create({
    providerId: "workflow",
    name: label ?? "test-run",
  });
  return conv.id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workflow-store-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLite WorkflowStore", () => {
  test("createRun seeds a running row visible to getRun", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "hello-world",
      inputs: { ARGUMENTS: "hi" },
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db, "hello-world-conv"),
    });

    const run = store.getRun("r1");
    expect(run).toBeDefined();
    expect(run!.runId).toBe("r1");
    expect(run!.workflowName).toBe("hello-world");
    expect(run!.status).toBe("running");
    expect(run!.inputs).toEqual({ ARGUMENTS: "hi" });
    expect(run!.nodes).toEqual([]);
    expect(run!.completedAt).toBeNull();
    expect(run!.error).toBeNull();
  });

  test("upsertNodeOutput then updateRunStatus persists the terminal state", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });

    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "greet",
      status: "succeeded",
      outputText: "hello",
      contentParts: null,
      startedAt: "2025-01-01T00:00:01.000Z",
      completedAt: "2025-01-01T00:00:02.000Z",
      error: null,
    });
    store.updateRunStatus({
      runId: "r1",
      status: "succeeded",
      completedAt: "2025-01-01T00:00:03.000Z",
      error: null,
    });

    const run = store.getRun("r1");
    expect(run!.status).toBe("succeeded");
    expect(run!.completedAt).toBe("2025-01-01T00:00:03.000Z");
    expect(run!.nodes).toHaveLength(1);
    expect(run!.nodes[0]!.nodeId).toBe("greet");
    expect(run!.nodes[0]!.outputText).toBe("hello");
    expect(run!.nodes[0]!.status).toBe("succeeded");
    expect(run!.nodes[0]!.startedAt).toBe("2025-01-01T00:00:01.000Z");
  });

  test("upsertNodeOutput is idempotent on (run_id, node_id)", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "ts",
      conversationId: mintConv(db),
    });

    // First write: failed.
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "n",
      status: "failed",
      outputText: "",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: "first",
    });
    // Second write: succeeded — must overwrite, not duplicate.
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "n",
      status: "succeeded",
      outputText: "ok",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });

    const run = store.getRun("r1");
    expect(run!.nodes).toHaveLength(1);
    expect(run!.nodes[0]!.status).toBe("succeeded");
    expect(run!.nodes[0]!.outputText).toBe("ok");
    expect(run!.nodes[0]!.error).toBeNull();
  });

  test("deleting a workflow_runs row cascades to its node outputs", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "ts",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "n",
      status: "succeeded",
      outputText: "",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });

    db.prepare("DELETE FROM workflow_runs WHERE id = ?").run("r1");
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_node_outputs WHERE run_id = ?")
      .get("r1") as { c: number };
    expect(row.c).toBe(0);
  });

  test("listRuns returns newest-first globally and scoped by name", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "a",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.createRun({
      runId: "r2",
      workflowName: "b",
      inputs: {},
      startedAt: "2025-01-01T00:00:01.000Z",
      conversationId: mintConv(db),
    });
    store.createRun({
      runId: "r3",
      workflowName: "a",
      inputs: {},
      startedAt: "2025-01-01T00:00:02.000Z",
      conversationId: mintConv(db),
    });

    expect(store.listRuns().map((r) => r.runId)).toEqual(["r3", "r2", "r1"]);
    expect(store.listRuns("a").map((r) => r.runId)).toEqual(["r3", "r1"]);
    expect(store.listRuns("missing")).toEqual([]);
  });

  test("getRun on unknown id returns undefined", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    expect(store.getRun("nope")).toBeUndefined();
  });

  test("createWorkflowStore reconciles prior-process 'running' rows on init", () => {
    // Simulate a server that wrote a 'running' row and crashed before
    // shutdown could mark it terminal. The next boot must sweep it to
    // 'failed' so the row doesn't stay in 'running' forever.
    const db1 = openDatabase({ path: dbPath });
    const s1 = createWorkflowStore(db1);
    s1.createRun({
      runId: "ghost",
      workflowName: "wf",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db1),
    });
    db1.close();

    // Reopen — boot reconcile fires inside createWorkflowStore.
    const db2 = openDatabase({ path: dbPath });
    const s2 = createWorkflowStore(db2);
    const run = s2.getRun("ghost");
    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("server exited before run completed");
    expect(run!.completedAt).not.toBeNull();
  });

  test("DB reset (DELETE WHERE status != 'running') preserves in-flight runs", () => {
    // Mirrors what a future db-reset path would do for workflow_runs.
    // A reset must not orphan a still-running executeRunInBackground caller;
    // it should clear terminal history (and the FK cascade trims node rows
    // for the deleted runs).
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);

    store.createRun({
      runId: "live",
      workflowName: "wf",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "live",
      nodeId: "n",
      status: "succeeded",
      outputText: "still here",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });

    store.createRun({
      runId: "old",
      workflowName: "wf",
      inputs: {},
      startedAt: "2025-01-01T00:00:01.000Z",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "old",
      nodeId: "n",
      status: "succeeded",
      outputText: "gone",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
    store.updateRunStatus({
      runId: "old",
      status: "succeeded",
      completedAt: "2025-01-01T00:00:02.000Z",
      error: null,
    });

    db.exec(`DELETE FROM workflow_runs WHERE status != 'running';`);

    expect(store.getRun("live")).toBeDefined();
    expect(store.getRun("old")).toBeUndefined();
    const liveNodes = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_node_outputs WHERE run_id = ?")
      .get("live") as { c: number };
    expect(liveNodes.c).toBe(1);
    const oldNodes = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_node_outputs WHERE run_id = ?")
      .get("old") as { c: number };
    expect(oldNodes.c).toBe(0);
  });

  test("deleteRun removes the run row and cascades node outputs", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "n1",
      status: "succeeded",
      outputText: "ok",
      contentParts: null,
      startedAt: "2025-01-01T00:00:01.000Z",
      completedAt: "2025-01-01T00:00:02.000Z",
      error: null,
    });

    expect(store.deleteRun("r1")).toBe(true);
    expect(store.getRun("r1")).toBeUndefined();
    const nodeCount = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_node_outputs WHERE run_id = ?")
      .get("r1") as { c: number };
    expect(nodeCount.c).toBe(0);
  });

  test("deleteRun returns false for an unknown runId", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    expect(store.deleteRun("nope")).toBe(false);
  });

  test("deleteRun is idempotent — second call returns false without throwing", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "ts",
      conversationId: mintConv(db),
    });
    expect(store.deleteRun("r1")).toBe(true);
    expect(store.deleteRun("r1")).toBe(false);
  });
});

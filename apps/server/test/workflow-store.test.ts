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
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { rmTemp } from "./temp.ts";

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
  rmTemp(tmpDir);
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

  test("persists resolved worktree base on the run row", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "hello-world",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db, "hello-world-conv"),
      workingDir: "/repo",
    });

    expect(store.getRun("r1")!.worktreeBase).toBeNull();
    store.setRunWorktreeBase("r1", "origin/main");
    expect(store.getRun("r1")!.worktreeBase).toBe("origin/main");
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

  test("persists and reads back per-node provider/model (migration 5)", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    // An LLM node carries the resolved provider + model.
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "ask",
      status: "succeeded",
      outputText: "hi",
      contentParts: null,
      startedAt: "2025-01-01T00:00:01.000Z",
      completedAt: "2025-01-01T00:00:02.000Z",
      error: null,
      usage: null,
      provider: "copilot",
      model: "auto",
    });
    // A bash node reports neither.
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "shell",
      status: "succeeded",
      outputText: "",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
      usage: null,
      provider: null,
      model: null,
    });

    const run = store.getRun("r1");
    expect(run!.nodes[0]!.provider).toBe("copilot");
    expect(run!.nodes[0]!.model).toBe("auto");
    expect(run!.nodes[1]!.provider).toBeNull();
    expect(run!.nodes[1]!.model).toBeNull();

    // Re-upsert (resume / re-run) overwrites the provenance, not duplicates it.
    store.upsertNodeOutput({
      runId: "r1",
      nodeId: "ask",
      status: "succeeded",
      outputText: "hi again",
      contentParts: null,
      startedAt: "2025-01-01T00:00:01.000Z",
      completedAt: "2025-01-01T00:00:04.000Z",
      error: null,
      usage: null,
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
    const reread = store.getRun("r1");
    expect(reread!.nodes).toHaveLength(2);
    expect(reread!.nodes[0]!.provider).toBe("claude");
    expect(reread!.nodes[0]!.model).toBe("claude-sonnet-4-6");
  });

  test("getRunUsageTotals sums tokens and counts only nodes carrying usage", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "r1",
      workflowName: "x",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    // Empty before any node runs.
    expect(store.getRunUsageTotals("r1")).toEqual({ totalTokens: 0, turns: 0 });

    const base = {
      runId: "r1",
      status: "succeeded" as const,
      outputText: "",
      contentParts: null,
      startedAt: "2025-01-01T00:00:01.000Z",
      completedAt: "2025-01-01T00:00:02.000Z",
      error: null,
    };
    store.upsertNodeOutput({
      ...base,
      nodeId: "prompt-a",
      usage: { inputTokens: 100, outputTokens: 40 },
    });
    store.upsertNodeOutput({
      ...base,
      nodeId: "prompt-b",
      usage: { inputTokens: 200, outputTokens: 60 },
    });
    // A bash node with no usage is not a model-call turn.
    store.upsertNodeOutput({ ...base, nodeId: "bash-c", usage: null });

    expect(store.getRunUsageTotals("r1")).toEqual({ totalTokens: 400, turns: 2 });
    // Scoped to the run.
    expect(store.getRunUsageTotals("missing")).toEqual({ totalTokens: 0, turns: 0 });
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

  test("createRun persists origin + ribId; defaults to manual/null", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "manual",
      workflowName: "x",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.createRun({
      runId: "sched",
      workflowName: "osdu-lane",
      inputs: {},
      startedAt: "2025-01-01T00:00:01.000Z",
      conversationId: mintConv(db),
      origin: "scheduled",
      ribId: "osdu",
    });

    const manual = store.getRun("manual");
    expect(manual!.origin).toBe("manual");
    expect(manual!.ribId).toBeNull();
    const sched = store.getRun("sched");
    expect(sched!.origin).toBe("scheduled");
    expect(sched!.ribId).toBe("osdu");
  });

  test("queryRuns filters by origin / ribId / workflow / status and clamps via limit", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const mk = (
      runId: string,
      startedAt: string,
      extra: Partial<Parameters<typeof store.createRun>[0]>,
    ): void => {
      store.createRun({
        runId,
        workflowName: extra.workflowName ?? "wf",
        inputs: {},
        startedAt,
        conversationId: mintConv(db),
        ...extra,
      });
    };
    mk("m1", "2025-01-01T00:00:00.000Z", { origin: "manual" });
    mk("s1", "2025-01-01T00:00:01.000Z", {
      origin: "scheduled",
      ribId: "osdu",
      workflowName: "osdu-lane",
    });
    mk("s2", "2025-01-01T00:00:02.000Z", {
      origin: "scheduled",
      ribId: "chamber",
      workflowName: "chamber-feed",
    });
    store.updateRunStatus({
      runId: "s2",
      status: "succeeded",
      completedAt: "2025-01-01T00:00:03.000Z",
      error: null,
    });

    expect(store.queryRuns({ origin: "manual" }).map((r) => r.runId)).toEqual(["m1"]);
    expect(store.queryRuns({ origin: "scheduled" }).map((r) => r.runId)).toEqual(["s2", "s1"]);
    expect(store.queryRuns({ ribId: "osdu" }).map((r) => r.runId)).toEqual(["s1"]);
    expect(store.queryRuns({ workflowName: "chamber-feed" }).map((r) => r.runId)).toEqual(["s2"]);
    expect(store.queryRuns({ statuses: ["succeeded"] }).map((r) => r.runId)).toEqual(["s2"]);
    expect(store.queryRuns({ statuses: ["running"] }).map((r) => r.runId)).toEqual(["s1", "m1"]);
    expect(store.queryRuns({ limit: 1 }).map((r) => r.runId)).toEqual(["s2"]);
    // The bound LIMIT honors 0 (returns nothing) rather than treating it as "no limit".
    expect(store.queryRuns({ limit: 0 })).toEqual([]);
    expect(store.queryRuns({}).map((r) => r.runId)).toEqual(["s2", "s1", "m1"]);
  });

  test("origin CHECK constraint rejects values outside manual|scheduled", () => {
    const db = openDatabase({ path: dbPath });
    createWorkflowStore(db);
    expect(() =>
      db
        .query(
          "INSERT INTO workflow_runs (id, workflow_name, status, started_at, origin) VALUES ('x', 'w', 'running', 't', 'bogus')",
        )
        .run(),
    ).toThrow();
  });

  test("scheduledRunsToPrune keeps newest N + skips non-terminal and manual runs", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    // 4 scheduled runs for one producer: 3 succeeded + 1 still running (newest).
    const stamps = [
      "2025-01-01T00:00:00.000Z", // oldest
      "2025-01-01T00:00:01.000Z",
      "2025-01-01T00:00:02.000Z",
      "2025-01-01T00:00:03.000Z", // newest, left running
    ];
    stamps.forEach((startedAt, i) => {
      const runId = `p${i}`;
      store.createRun({
        runId,
        workflowName: "producer",
        inputs: {},
        startedAt,
        conversationId: mintConv(db),
        origin: "scheduled",
      });
      if (i < 3) {
        store.updateRunStatus({ runId, status: "succeeded", completedAt: startedAt, error: null });
      }
    });
    // A manual run of the same workflow must never be pruned.
    store.createRun({
      runId: "manual",
      workflowName: "producer",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.500Z",
      conversationId: mintConv(db),
      origin: "manual",
    });
    store.updateRunStatus({
      runId: "manual",
      status: "succeeded",
      completedAt: "x",
      error: null,
    });

    // keep=2 protects the 2 newest scheduled rows (p3 running, p2 succeeded);
    // among the rest only terminal ones are eligible → p1, p0.
    const toPrune = store
      .scheduledRunsToPrune("producer", 2)
      .map((r) => r.runId)
      .sort();
    expect(toPrune).toEqual(["p0", "p1"]);
    // The conversation id is returned so the caller can cascade.
    expect(store.scheduledRunsToPrune("producer", 2).every((r) => r.conversationId !== null)).toBe(
      true,
    );
    // protectSince shields recent rows regardless of rank: a burst of per-item
    // refreshes must not prune a just-finished run out from under its poller.
    expect(
      store.scheduledRunsToPrune("producer", 2, "2025-01-01T00:00:01.000Z").map((r) => r.runId),
    ).toEqual(["p0"]);
    expect(store.scheduledRunsToPrune("producer", 2, "2025-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("workflow store — node token usage", () => {
  test("usage round-trips through upsertNodeOutput → getRun", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "run-usage",
      workflowName: "x",
      inputs: {},
      startedAt: "2026-06-10T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "run-usage",
      nodeId: "n1",
      status: "succeeded",
      outputText: "done",
      contentParts: null,
      startedAt: "2026-06-10T00:00:00.000Z",
      completedAt: "2026-06-10T00:00:05.000Z",
      error: null,
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadInputTokens: 900,
        contextTokens: 2100,
        contextWindow: 200000,
      },
    });
    store.upsertNodeOutput({
      runId: "run-usage",
      nodeId: "n2-bash",
      status: "succeeded",
      outputText: "ok",
      contentParts: null,
      startedAt: "2026-06-10T00:00:05.000Z",
      completedAt: "2026-06-10T00:00:06.000Z",
      error: null,
      usage: null,
    });

    const run = store.getRun("run-usage");
    expect(run).toBeDefined();
    const n1 = run!.nodes.find((n) => n.nodeId === "n1");
    expect(n1!.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 900,
      contextTokens: 2100,
      contextWindow: 200000,
    });
    const n2 = run!.nodes.find((n) => n.nodeId === "n2-bash");
    expect(n2!.usage).toBeNull();
  });

  test("malformed usage_json degrades to null instead of breaking getRun", () => {
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    store.createRun({
      runId: "run-bad-usage",
      workflowName: "x",
      inputs: {},
      startedAt: "2026-06-10T00:00:00.000Z",
      conversationId: mintConv(db),
    });
    store.upsertNodeOutput({
      runId: "run-bad-usage",
      nodeId: "n1",
      status: "succeeded",
      outputText: "x",
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
      usage: null,
    });
    db.exec(
      "UPDATE workflow_node_outputs SET usage_json = 'not json' WHERE run_id = 'run-bad-usage'",
    );
    const run = store.getRun("run-bad-usage");
    expect(run!.nodes[0]!.usage).toBeNull();
  });
});

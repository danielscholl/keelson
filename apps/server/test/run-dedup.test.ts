// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@keelson/workflows";
import { bootstrapWorkflows, type RibWorkflowBinding } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  type ActiveRunEntry,
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  runDedupeKey,
} from "../src/workflows-handler.ts";

function liveEntry(dedupeKey: string, conversationId: string): ActiveRunEntry {
  return {
    abort: new AbortController(),
    done: Promise.resolve(),
    pendingApprovals: new Map(),
    dedupeKey,
    conversationId,
  };
}

describe("runDedupeKey", () => {
  test("is identical for the same inputs regardless of key order", () => {
    expect(runDedupeKey("w", "/repo", { a: "1", b: "2" })).toBe(
      runDedupeKey("w", "/repo", { b: "2", a: "1" }),
    );
  });

  test("differs by name, workingDir, and inputs", () => {
    const base = runDedupeKey("w", "/repo", {});
    expect(runDedupeKey("x", "/repo", {})).not.toBe(base);
    expect(runDedupeKey("w", "/other", {})).not.toBe(base);
    expect(runDedupeKey("w", "/repo", { mode: "full" })).not.toBe(base);
  });
});

describe("ActiveRuns.findActive", () => {
  test("matches the live run by dedupe key only", () => {
    const runs = createActiveRuns();
    runs.register("run-a", liveEntry(runDedupeKey("collect", "/repo", {}), "conv-a"));
    expect(runs.findActive(runDedupeKey("collect", "/repo", {}))).toEqual({
      runId: "run-a",
      conversationId: "conv-a",
    });
    expect(runs.findActive(runDedupeKey("collect", "/elsewhere", {}))).toBeUndefined();
    expect(runs.findActive(runDedupeKey("other", "/repo", {}))).toBeUndefined();
    // Same workflow + dir but different inputs is a distinct run.
    expect(runs.findActive(runDedupeKey("collect", "/repo", { mode: "full" }))).toBeUndefined();
  });
});

describe("startRunCore de-dup", () => {
  let tmpDir: string;
  let wfDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keelson-dedup-"));
    wfDir = join(tmpDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "collect.yaml"),
      `name: collect
description: |
  Use when: a deterministic collector run is needed
nodes:
  - id: ok
    bash: echo collected
`,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // `bindCollect` registers `collect` as a bound producer — the de-dup only
  // applies to producer-refresh paths, so a generic run is never collapsed.
  function makeRig(bindCollect: boolean) {
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const activeRuns = createActiveRuns();
    let ribWorkflowBindings: Map<WorkflowDefinition, RibWorkflowBinding> | undefined;
    if (bindCollect) {
      const def = catalog.get("collect");
      if (def === undefined) throw new Error("collect workflow missing from catalog");
      ribWorkflowBindings = new Map([[def, { publish: () => {} }]]);
    }
    const controller = createWorkflowController(
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        ...(ribWorkflowBindings ? { ribWorkflowBindings } : {}),
      },
      activeRuns,
      createWorkflowSubscribers(),
    );
    return { db, store, activeRuns, controller };
  }

  test("a concurrent start of a live bound producer returns the existing run", () => {
    const { db, store, activeRuns, controller } = makeRig(true);
    try {
      activeRuns.register("pre-run", liveEntry(runDedupeKey("collect", tmpDir, {}), "pre-conv"));

      const result = controller.startRun({ name: "collect", inputs: {}, workingDir: tmpDir });

      expect(result).toEqual({ ok: true, runId: "pre-run", conversationId: "pre-conv" });
      // No second run row, no second registration — the start short-circuited.
      expect(activeRuns.size()).toBe(1);
      expect(store.listRuns()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a workflow that is not a bound producer is never de-duped", async () => {
    const { db, store, activeRuns, controller } = makeRig(false);
    try {
      activeRuns.register("pre-run", liveEntry(runDedupeKey("collect", tmpDir, {}), "pre-conv"));

      const result = controller.startRun({ name: "collect", inputs: {}, workingDir: tmpDir });

      if (!result.ok) throw new Error(result.message);
      // A fresh run started despite the matching live entry — generic runs are
      // not collapsed, so their inputs/isolation are untouched.
      expect(result.runId).not.toBe("pre-run");
      expect(store.listRuns()).toHaveLength(1);
      // Drain the spawned run so it doesn't write to a closed db.
      await activeRuns.get(result.runId)?.done;
    } finally {
      db.close();
    }
  });

  test("an isolated start of a bound producer is not de-duped", async () => {
    const { db, store, activeRuns, controller } = makeRig(true);
    try {
      activeRuns.register("pre-run", liveEntry(runDedupeKey("collect", tmpDir, {}), "pre-conv"));

      const result = controller.startRun({
        name: "collect",
        inputs: {},
        workingDir: tmpDir,
        isolation: "worktree",
      });

      // Isolated runs own a checkout and linger through worktree teardown, so
      // they are excluded from de-dup even for a bound producer.
      if (!result.ok) throw new Error(result.message);
      expect(result.runId).not.toBe("pre-run");
      expect(store.listRuns()).toHaveLength(1);
      // Drain the spawned run (the worktree setup fails in this non-git dir).
      await activeRuns.get(result.runId)?.done;
    } finally {
      db.close();
    }
  });
});

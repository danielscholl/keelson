// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rib, RibRunEvent } from "@keelson/shared";
import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { applyRibs } from "../src/ribs.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("rib run events", () => {
  let tmpDir: string;
  let wfDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keelson-run-events-"));
    wfDir = join(tmpDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
  });

  afterEach(() => {
    rmTemp(tmpDir);
  });

  function makeRig(opts: {
    bash: string;
    ribOwned?: boolean;
    onRibRunEvent?: (ribId: string, event: RibRunEvent) => void;
  }) {
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const definition = {
      name: "provision",
      description: "Use when: exercising the rib run-event seam",
      nodes: [{ id: "work", bash: opts.bash }],
    };
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      extra: [definition],
      ...(opts.ribOwned !== false
        ? { ribProvenance: new Map([["provision", { ribId: "osdu", background: false }]]) }
        : {}),
    });
    const activeRuns = createActiveRuns();
    const subscribers = createWorkflowSubscribers();
    const controller = createWorkflowController(
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        ...(opts.onRibRunEvent !== undefined ? { onRibRunEvent: opts.onRibRunEvent } : {}),
      },
      activeRuns,
      subscribers,
    );
    return { db, store, activeRuns, subscribers, controller };
  }

  test("a rib-owned run emits running at launch and succeeded when it settles", async () => {
    const events: Array<{ ribId: string; event: RibRunEvent }> = [];
    const { db, controller } = makeRig({
      bash: "echo done",
      onRibRunEvent: (ribId, event) => events.push({ ribId, event }),
    });
    try {
      const result = controller.startRun({
        name: "provision",
        inputs: { provider: "kind", env: "lab" },
        workingDir: tmpDir,
      });
      if (!result.ok) throw new Error(result.message);

      expect(events).toHaveLength(1);
      expect(events[0]?.ribId).toBe("osdu");
      expect(events[0]?.event).toMatchObject({
        workflowName: "provision",
        runId: result.runId,
        status: "running",
        inputs: { provider: "kind", env: "lab" },
      });

      await until(() => events.length === 2);
      expect(events[1]?.event).toMatchObject({
        workflowName: "provision",
        runId: result.runId,
        status: "succeeded",
        inputs: { provider: "kind", env: "lab" },
      });
      expect(typeof events[1]?.event.completedAt).toBe("string");
      expect(events[1]?.event.error).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("a failed run's terminal event carries the run-level error", async () => {
    const events: RibRunEvent[] = [];
    const { db, controller } = makeRig({
      bash: "echo boom >&2; exit 1",
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);

      await until(() => events.length === 2);
      expect(events[1]).toMatchObject({ status: "failed" });
      expect(typeof events[1]?.error).toBe("string");
    } finally {
      db.close();
    }
  });

  test("a resume emits a fresh running→terminal pair for the same runId", async () => {
    const events: RibRunEvent[] = [];
    const { db, controller } = makeRig({
      bash: "exit 1",
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      await until(() => events.length === 2);
      expect(events[1]).toMatchObject({ status: "failed" });

      const resumed = controller.resumeRun(result.runId);
      if (!resumed.ok) throw new Error(resumed.message);
      await until(() => events.length === 4);
      // Once per LAUNCH, not per run: the resume re-emits with the same runId.
      expect(events[2]).toMatchObject({ runId: result.runId, status: "running" });
      expect(events[3]).toMatchObject({ runId: result.runId, status: "failed" });
    } finally {
      db.close();
    }
  });

  test("a done-subscriber that resumes immediately cannot swallow the first terminal event", async () => {
    const events: RibRunEvent[] = [];
    const { db, activeRuns, controller } = makeRig({
      bash: "exit 1",
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      // Races the settle-observer: a consumer of ActiveRunEntry.done that
      // resumes in the same microtask turn flips the row back to running.
      const raced = activeRuns.get(result.runId)?.done.then(() => {
        const resumed = controller.resumeRun(result.runId);
        if (!resumed.ok) throw new Error(resumed.message);
      });
      await raced;
      await until(() => events.length === 4);
      expect(events.map((e) => e.status)).toEqual(["running", "failed", "running", "failed"]);
    } finally {
      db.close();
    }
  });

  test("a resume inside the settle window cannot swallow the first terminal event", async () => {
    const events: RibRunEvent[] = [];
    const { db, subscribers, controller } = makeRig({
      bash: "exit 1",
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      let resumed = false;
      const unsub = subscribers.onFrame(result.runId, (frame) => {
        if (frame.type !== "run_done" || resumed) return;
        resumed = true;
        // One microtask hop lands after the executor's sync section (terminal
        // row persisted, active entry deleted — the run is resumable) but
        // before its final awaited recompose resolves `done`.
        queueMicrotask(() => {
          const r = controller.resumeRun(result.runId);
          if (!r.ok) throw new Error(r.message);
        });
      });
      await until(() => events.length === 4);
      unsub();
      // The resume's fresh pair starts before launch 1's terminal event goes
      // out (the window closes only when done settles); what must hold is that
      // both launches deliver their full pair.
      expect(events.map((e) => e.status).sort()).toEqual([
        "failed",
        "failed",
        "running",
        "running",
      ]);
      for (const event of events) expect(event.runId).toBe(result.runId);
    } finally {
      db.close();
    }
  });

  test("a hook that mutates its event's inputs cannot corrupt later events", async () => {
    const events: RibRunEvent[] = [];
    const { db, controller } = makeRig({
      bash: "echo done",
      onRibRunEvent: (_ribId, event) => {
        events.push({ ...event, inputs: { ...event.inputs } });
        // Hostile/buggy hook: scribble on the delivered object.
        event.inputs.provider = "corrupted";
      },
    });
    try {
      const result = controller.startRun({
        name: "provision",
        inputs: { provider: "kind" },
        workingDir: tmpDir,
      });
      if (!result.ok) throw new Error(result.message);
      await until(() => events.length === 2);
      expect(events[0]?.inputs).toEqual({ provider: "kind" });
      expect(events[1]?.inputs).toEqual({ provider: "kind" });
    } finally {
      db.close();
    }
  });

  test("a cancelled run's terminal event reports cancelled", async () => {
    const events: RibRunEvent[] = [];
    const { db, activeRuns, controller } = makeRig({
      bash: "sleep 30",
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      await until(() => events.length === 1);
      // The cancel route's core: trigger the run's AbortController; the
      // executor's run_done branch persists 'cancelled', settling `done`.
      activeRuns.get(result.runId)?.abort.abort();
      await until(() => events.length === 2);
      expect(events[1]).toMatchObject({ runId: result.runId, status: "cancelled" });
    } finally {
      db.close();
    }
  });

  test("a run of a workflow no rib owns emits nothing", async () => {
    const events: RibRunEvent[] = [];
    const { db, activeRuns, controller } = makeRig({
      bash: "echo done",
      ribOwned: false,
      onRibRunEvent: (_ribId, event) => events.push(event),
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      await activeRuns.get(result.runId)?.done;
      // Settle any pending emit chain before asserting silence.
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a throwing emitter never reaches the start path or the run", async () => {
    const { db, store, activeRuns, controller } = makeRig({
      bash: "echo done",
      onRibRunEvent: () => {
        throw new Error("listener exploded");
      },
    });
    try {
      const result = controller.startRun({ name: "provision", inputs: {}, workingDir: tmpDir });
      if (!result.ok) throw new Error(result.message);
      await activeRuns.get(result.runId)?.done;
      await until(() => store.getRun(result.runId)?.status === "succeeded");
    } finally {
      db.close();
    }
  });
});

describe("applyRibs onRunEvent wiring", () => {
  test("registers a handler that forwards the event with the rib's ctx", async () => {
    const seen: Array<{ event: RibRunEvent; hasExec: boolean }> = [];
    const rib: Rib = {
      id: "osdu",
      displayName: "OSDU",
      onRunEvent(event, ctx) {
        seen.push({ event, hasExec: typeof ctx.getExec === "function" });
      },
    };
    const result = applyRibs({
      active: ["osdu"],
      available: { osdu: rib },
      ctx: { getExec: () => ({}) as never },
    });
    const handler = result.runEventHandlers.get("osdu");
    if (!handler) throw new Error("expected a run-event handler for rib 'osdu'");
    await handler({
      workflowName: "osdu-cluster-create",
      runId: "run-1",
      status: "running",
      inputs: { provider: "kind" },
      startedAt: "2026-07-13T12:00:00Z",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.status).toBe("running");
    expect(seen[0]?.hasExec).toBe(true);
  });

  test("a hook that throws synchronously rejects instead of throwing at the caller", async () => {
    const rib: Rib = {
      id: "osdu",
      displayName: "OSDU",
      onRunEvent() {
        throw new Error("sync explosion");
      },
    };
    const result = applyRibs({
      active: ["osdu"],
      available: { osdu: rib },
      ctx: { getExec: () => ({}) as never },
    });
    const handler = result.runEventHandlers.get("osdu");
    if (!handler) throw new Error("expected a run-event handler for rib 'osdu'");
    // Must not throw synchronously — the dispatch site attaches .catch to the return value.
    const pending = handler({
      workflowName: "osdu-cluster-create",
      runId: "run-1",
      status: "running",
      inputs: {},
      startedAt: "2026-07-13T12:00:00Z",
    });
    await expect(pending).rejects.toThrow("sync explosion");
  });

  test("a rib without the hook registers no handler", () => {
    const result = applyRibs({
      active: ["bare"],
      available: { bare: { id: "bare", displayName: "Bare" } },
      ctx: { getExec: () => ({}) as never },
    });
    expect(result.runEventHandlers.size).toBe(0);
  });
});

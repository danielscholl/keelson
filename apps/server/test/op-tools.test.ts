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
import type { MessageChunk, OpHandle, ToolContext, ToolDefinition } from "@keelson/shared";
import { openDatabase } from "../src/db/init.ts";
import { createOpRegistry, type OpRegistry } from "../src/op-registry.ts";
import { createOpStore } from "../src/op-store.ts";
import { createOpTools } from "../src/op-tools.ts";
import type { WorkflowController } from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let db: Database;
let registry: OpRegistry;
let tools: ToolDefinition[];
// A mutable fake controller the registry projects; individual tests set its runs.
let fakeRuns: unknown[] = [];
let fakeDetails: Record<string, unknown> = {};
let cancelledRuns: string[] = [];
let liveRuns: Set<string>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-op-tools-"));
  db = openDatabase({ path: join(tmpDir, "test.db") });
  const store = createOpStore(db);
  fakeRuns = [];
  fakeDetails = {};
  cancelledRuns = [];
  liveRuns = new Set();
  const controller = {
    listRuns: () => fakeRuns,
    getRun: (runId: string) => fakeDetails[runId],
  } as unknown as WorkflowController;
  registry = createOpRegistry({
    store,
    getWorkflowController: () => controller,
    cancelWorkflowRun: (runId) => {
      if (!liveRuns.has(runId)) return false;
      cancelledRuns.push(runId);
      return true;
    },
  });
  tools = createOpTools({ registry });
});

afterEach(() => {
  db.close();
  rmTemp(tmpDir);
});

function toolByName(name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not registered`);
  return tool;
}

function makeCtx(): { ctx: ToolContext; chunks: MessageChunk[] } {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: tmpDir,
    emit: (chunk) => chunks.push(chunk),
    abortSignal: new AbortController().signal,
  };
  return { ctx, chunks };
}

async function run(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const { ctx, chunks } = makeCtx();
  await toolByName(name).execute(input, ctx);
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk && chunk.type === "tool_result") {
      return { content: chunk.content, isError: chunk.isError ?? false };
    }
  }
  throw new Error(`no tool_result from ${name}`);
}

describe("op tools — native ops", () => {
  test("the five run_* tools are registered", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "run_cancel",
      "run_events",
      "run_list",
      "run_status",
      "run_steer",
    ]);
    expect(toolByName("run_cancel").state_changing).toBe(true);
    expect(toolByName("run_steer").state_changing).toBe(true);
    expect(toolByName("run_list").state_changing ?? false).toBe(false);
  });

  test("run_status + run_events surface a native op's frames and terminal result", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate", title: "coord" });
    handle.progress("round 1");
    handle.log("thinking");

    const status = await run("run_status", { id: handle.id });
    expect(status.isError).toBe(false);
    expect(status.content).toContain(handle.id);
    expect(status.content).toContain("status running");

    const events = await run("run_events", { id: handle.id, cursor: 0 });
    expect(events.content).toContain("[1] progress round 1");
    expect(events.content).toContain("[2] log thinking");

    // Only-new-frames polling with the cursor.
    const afterOne = await run("run_events", { id: handle.id, cursor: 1 });
    expect(afterOne.content).toContain("[2] log");
    expect(afterOne.content).not.toContain("[1] progress");

    handle.done({ prs: 3 });
    const done = await run("run_status", { id: handle.id });
    expect(done.content).toContain("status done");
    expect(done.content).toContain('"prs":3');
  });

  test("run_status errors for an unknown op id", async () => {
    const res = await run("run_status", { id: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });

  test("run_cancel aborts a live op and preserves the cancelled row", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate" });
    expect(handle.signal.aborted).toBe(false);

    const res = await run("run_cancel", { id: handle.id });
    expect(res.isError).toBe(false);
    expect(handle.signal.aborted).toBe(true);

    const status = await run("run_status", { id: handle.id });
    expect(status.content).toContain("status cancelled");

    // Cancelling again is a clean error, not a false success.
    const again = await run("run_cancel", { id: handle.id });
    expect(again.isError).toBe(true);
    expect(again.content).toContain("already cancelled");
  });

  test("run_steer invokes onSteer for a steerable op and errors otherwise", async () => {
    const notes: string[] = [];
    const steerable = registry.register("rib:squad", {
      kind: "squad_coordinate",
      onSteer: (note) => notes.push(note),
    });
    const ok = await run("run_steer", { id: steerable.id, note: "focus on tests" });
    expect(ok.isError).toBe(false);
    expect(notes).toEqual(["focus on tests"]);

    const plain = registry.register("rib:squad", { kind: "squad_coordinate" });
    const denied = await run("run_steer", { id: plain.id, note: "hi" });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("does not accept steering");
  });

  test("run_list advertises steerability and includes native ops", async () => {
    registry.register("rib:squad", { kind: "squad_coordinate", onSteer: () => {} });
    const res = await run("run_list", {});
    expect(res.content).toContain("squad_coordinate");
    expect(res.content).toContain("(steerable)");
  });

  test("run_list excludes terminal native ops (active only)", async () => {
    const running = registry.register("rib:squad", { kind: "squad_coordinate", title: "live" });
    const done = registry.register("rib:squad", { kind: "squad_coordinate", title: "finished" });
    done.done();
    const res = await run("run_list", {});
    expect(res.content).toContain(running.id);
    expect(res.content).not.toContain(done.id);
  });

  test("run_steer refuses a settled native op by terminal status", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate", onSteer: () => {} });
    handle.done({ ok: true });
    const res = await run("run_steer", { id: handle.id, note: "too late" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("cannot steer");
    expect(res.content).toContain("done");
    // The status guard fired, not the live-controller guard.
    expect(res.content).not.toContain("does not accept steering");
  });

  test("run_status and run_events render the zero-event case", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate" });
    const status = await run("run_status", { id: handle.id });
    expect(status.isError).toBe(false);
    expect(status.content).toContain("No events yet.");
    const events = await run("run_events", { id: handle.id, cursor: 0 });
    expect(events.isError).toBe(false);
    expect(events.content).toContain(`No events for op ${handle.id} after cursor 0.`);
  });

  test("run_events renders bounded frame data", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate" });
    handle.progress("scanning", { files: 12, phase: "index" });
    const events = await run("run_events", { id: handle.id, cursor: 0 });
    expect(events.content).toContain("scanning");
    expect(events.content).toContain('"files":12');
  });

  test("drain aborts live native ops and settles them cancelled", async () => {
    const handle = registry.register("rib:squad", { kind: "squad_coordinate" });
    expect(handle.signal.aborted).toBe(false);
    registry.drain();
    expect(handle.signal.aborted).toBe(true);
    const status = await run("run_status", { id: handle.id });
    expect(status.content).toContain("status cancelled");
    // A post-drain settle no-ops — the op is already terminal.
    handle.done({ late: true });
    const after = await run("run_status", { id: handle.id });
    expect(after.content).toContain("status cancelled");
  });

  test("run_steer records the steer frame before an onSteer that self-settles", async () => {
    let h: OpHandle | undefined;
    h = registry.register("rib:squad", {
      kind: "squad_coordinate",
      onSteer: () => h?.done({ acked: true }),
    });
    const res = await run("run_steer", { id: h.id, note: "wrap up" });
    expect(res.isError).toBe(false);
    const events = await run("run_events", { id: h.id, cursor: 0 });
    const steerAt = events.content.indexOf("steer: wrap up");
    const doneAt = events.content.indexOf("] done");
    expect(steerAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(steerAt);
  });

  test("register creates the row before publishing the controller (no stranded op on FK failure)", () => {
    // A nonexistent projectId violates the ops FK, so create throws before live.set.
    expect(() =>
      registry.register("rib:squad", { kind: "squad_coordinate", projectId: "nope" }),
    ).toThrow();
    // The registry is uncorrupted: a subsequent valid op registers fine.
    const ok = registry.register("rib:squad", { kind: "squad_coordinate" });
    expect(registry.status(ok.id)?.status).toBe("running");
  });
});

describe("op tools — workflow projection", () => {
  test("run_list includes live workflow runs with a wf: id", async () => {
    fakeRuns = [
      {
        runId: "r1",
        workflowName: "fix-issue",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      },
    ];
    const res = await run("run_list", {});
    expect(res.content).toContain("wf:r1");
    expect(res.content).toContain("workflow:fix-issue");
  });

  test("run_events projects node-level frames ordered by completion", async () => {
    fakeDetails.r1 = {
      workflowName: "fix-issue",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:03:00.000Z",
      error: null,
      nodes: [
        {
          nodeId: "plan",
          status: "succeeded",
          completedAt: "2026-01-01T00:02:00.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
        {
          nodeId: "fetch",
          status: "succeeded",
          completedAt: "2026-01-01T00:01:00.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
        {
          nodeId: "impl",
          status: "running",
          completedAt: null,
          outputText: null,
          startedAt: null,
          error: null,
        },
      ],
    };
    const res = await run("run_events", { id: "wf:r1", cursor: 0 });
    // Ordered by completedAt: fetch (00:01) before plan (00:02); running node omitted;
    // terminal run frame appended last.
    const fetchAt = res.content.indexOf("[1] progress [fetch]");
    const planAt = res.content.indexOf("[2] progress [plan]");
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeGreaterThan(fetchAt);
    expect(res.content).toContain("[3] done run succeeded");
    expect(res.content).not.toContain("impl");
  });

  test("run_cancel on a workflow op delegates to the abort-only hook", async () => {
    liveRuns.add("r1");
    const res = await run("run_cancel", { id: "wf:r1" });
    expect(res.isError).toBe(false);
    expect(cancelledRuns).toEqual(["r1"]);

    // A run with no live execution fails cleanly.
    const gone = await run("run_cancel", { id: "wf:missing" });
    expect(gone.isError).toBe(true);
    expect(gone.content).toContain("no live execution");
  });

  test("run_steer refuses workflow ops and points at workflow_respond", async () => {
    const res = await run("run_steer", { id: "wf:r1", note: "go" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("workflow_respond");
  });

  test("run_status projects workflow terminal status, error, and lastSeq", async () => {
    fakeDetails.rf = {
      workflowName: "fix-issue",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:03:00.000Z",
      error: "boom",
      nodes: [
        {
          nodeId: "impl",
          status: "failed",
          completedAt: "2026-01-01T00:02:00.000Z",
          outputText: null,
          startedAt: null,
          error: "boom",
        },
      ],
    };
    const failed = await run("run_status", { id: "wf:rf" });
    expect(failed.isError).toBe(false);
    expect(failed.content).toContain("status error");
    expect(failed.content).toContain("error: boom");
    expect(failed.content).toContain("2 event(s)"); // 1 completed node + terminal frame

    fakeDetails.rp = {
      workflowName: "fix-issue",
      status: "paused",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      nodes: [
        {
          nodeId: "plan",
          status: "succeeded",
          completedAt: "2026-01-01T00:00:30.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
      ],
    };
    const paused = await run("run_status", { id: "wf:rp" });
    expect(paused.content).toContain("status running"); // paused projects to running
  });

  test("run_events returns a resume-safe full snapshot for a workflow op (cursor-independent)", async () => {
    fakeDetails.r1 = {
      workflowName: "fix-issue",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      nodes: [
        {
          nodeId: "fetch",
          status: "succeeded",
          completedAt: "2026-01-01T00:01:00.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
        {
          nodeId: "plan",
          status: "running",
          completedAt: null,
          outputText: null,
          startedAt: null,
          error: null,
        },
      ],
    };
    const first = await run("run_events", { id: "wf:r1", cursor: 0 });
    expect(first.content).toContain("[1] progress [fetch]");
    expect(first.content).not.toContain("[2]");
    expect(first.content).not.toContain("done run");

    // plan completes and the run goes terminal.
    fakeDetails.r1 = {
      workflowName: "fix-issue",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:03:00.000Z",
      error: null,
      nodes: [
        {
          nodeId: "fetch",
          status: "succeeded",
          completedAt: "2026-01-01T00:01:00.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
        {
          nodeId: "plan",
          status: "succeeded",
          completedAt: "2026-01-01T00:02:00.000Z",
          outputText: null,
          startedAt: null,
          error: null,
        },
      ],
    };
    // A workflow op re-emits the full current snapshot even at a non-zero cursor
    // (resume-safe projection), so all three frames come back — nothing is dropped.
    const second = await run("run_events", { id: "wf:r1", cursor: 1 });
    expect(second.content).toContain("[1] progress [fetch]");
    expect(second.content).toContain("[2] progress [plan]");
    expect(second.content).toContain("[3] done run succeeded");
  });
});

describe("op tools — restart", () => {
  test("after a restart, run_* surfaces the durable terminal result and fails cleanly on the orphaned op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-op-restart-"));
    const path = join(dir, "restart.db");

    // Session 1: settle one op, leave one running, then drop the process.
    const db1 = openDatabase({ path });
    const reg1 = createOpRegistry({ store: createOpStore(db1) });
    const settled = reg1.register("rib:squad", { kind: "squad_coordinate", title: "done-op" });
    settled.done({ prs: 3 });
    const orphanId = reg1.register("rib:squad", {
      kind: "squad_coordinate",
      title: "live-op",
      onSteer: () => {},
    }).id;
    db1.close();

    // Session 2: reopen the SAME db; the store constructor runs the boot sweep.
    const db2 = openDatabase({ path });
    const tools2 = createOpTools({ registry: createOpRegistry({ store: createOpStore(db2) }) });
    const run2 = async (name: string, input: unknown) => {
      const chunks: MessageChunk[] = [];
      const ctx: ToolContext = {
        cwd: dir,
        emit: (c) => chunks.push(c),
        abortSignal: new AbortController().signal,
      };
      const tool = tools2.find((t) => t.name === name);
      if (!tool) throw new Error(`tool '${name}' not registered`);
      await tool.execute(input, ctx);
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c && c.type === "tool_result")
          return { content: c.content, isError: c.isError ?? false };
      }
      throw new Error(`no tool_result from ${name}`);
    };

    // The settled op's durable terminal result is retrievable through the tool.
    const done = await run2("run_status", { id: settled.id });
    expect(done.isError).toBe(false);
    expect(done.content).toContain("status done");
    expect(done.content).toContain('"prs":3');

    // The mid-flight op reports orphaned (never 'running') through the tool.
    const orphan = await run2("run_status", { id: orphanId });
    expect(orphan.content).toContain("status orphaned");

    // MUST fail cleanly (never a false success) — no live controller to act on.
    const cancel = await run2("run_cancel", { id: orphanId });
    expect(cancel.isError).toBe(true);
    expect(cancel.content).toContain("orphaned");

    const steer = await run2("run_steer", { id: orphanId, note: "focus" });
    expect(steer.isError).toBe(true);
    expect(steer.content).toContain("orphaned");

    db2.close();
    rmTemp(dir);
  });
});

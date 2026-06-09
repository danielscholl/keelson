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
import type { NodeHandler } from "@keelson/workflows";
import { Hono } from "hono";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createSnapshotManager } from "../src/snapshot-manager.ts";
import { createSnapshotSubscribers } from "../src/snapshot-subscribers.ts";
import { snapshotsRoutes } from "../src/snapshots-handler.ts";
import { createWorkflowStore, type WorkflowStore } from "../src/workflow-store.ts";
import { workflowsRoutes } from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

const ORIGIN = "http://127.0.0.1:5173";

// A prompt handler that emits structured output directly — the stub provider
// echoes the prompt and never produces JSON, so an injected handler is the
// only way to exercise the structured-output path here (#72 owns the
// output_format→structured parsing; this test owns the publish bridge).
const structuredHandler: NodeHandler = {
  type: "prompt",
  handle: async () => ({
    status: "succeeded",
    output: { kind: "structured", value: { markdown: "# Live" } },
  }),
};

let tmpDir: string;
let wfDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-snapshot-bridge-"));
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
});

afterEach(() => {
  rmTemp(tmpDir);
});

function makeRig() {
  const db = openDatabase({ path: join(tmpDir, "test.db") });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const project = projectsStore.create({ name: "test-project", rootPath: tmpDir });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const subscribers = createSnapshotSubscribers();
  const manager = createSnapshotManager(subscribers);
  const app = new Hono();
  workflowsRoutes(app, {
    catalog,
    store,
    conversationStore,
    projectsStore,
    promptHandler: structuredHandler,
    snapshotManager: manager,
  });
  snapshotsRoutes(app, { manager, subscribers });
  return { app, store, manager, projectId: project.id };
}

function postRun(url: string, body: unknown): Request {
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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not reach the expected status in ${timeoutMs}ms`);
}

// recompose() is fire-and-forget off node_done, so the cached frame may land a
// tick after the run reports `paused`. Poll the hydrate endpoint until it 200s.
async function pollSnapshot(app: Hono, key: string, timeoutMs = 2000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/snapshots/${key}`));
    if (res.status === 200) return await res.json();
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`snapshot ${key} was not composed in ${timeoutMs}ms`);
}

async function pollUntilTerminal(app: Hono, runId: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { status: string } };
    if (["succeeded", "failed", "cancelled"].includes(body.run.status)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not complete in ${timeoutMs}ms`);
}

describe("workflow → snapshot publish bridge (#73)", () => {
  // emit (structured) → gate (approval). The pause holds the run open after the
  // structured publish so the run-scoped key is observable, then resume drives
  // it terminal so we can assert the key is dropped.
  const WORKFLOW = `name: snapshot-bridge
description: emit a structured payload, then pause
nodes:
  - id: emit
    prompt: produce the payload
  - id: gate
    depends_on: [emit]
    approval:
      message: hold
`;

  test("publishes the structured node output under workflow:run:<id>", async () => {
    writeFileSync(join(wfDir, "sb.yaml"), WORKFLOW);
    const { app, store, projectId } = makeRig();

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/snapshot-bridge/runs", { inputs: {}, projectId }),
    );
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };
    const key = `workflow:run:${runId}`;

    await pollUntilStoreStatus(store, runId, (s) => s === "paused");

    const frame = (await pollSnapshot(app, key)) as {
      type: string;
      key: string;
      version: number;
      data: unknown;
    };
    expect(frame.type).toBe("snapshot_update");
    expect(frame.key).toBe(key);
    expect(frame.version).toBe(0);
    expect(frame.data).toEqual({ markdown: "# Live" });
  });

  test("unregisters the run-scoped key once the run reaches a terminal state", async () => {
    writeFileSync(join(wfDir, "sb.yaml"), WORKFLOW);
    const { app, store, manager, projectId } = makeRig();

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/snapshot-bridge/runs", { inputs: {}, projectId }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    const key = `workflow:run:${runId}`;

    await pollUntilStoreStatus(store, runId, (s) => s === "paused");
    await pollSnapshot(app, key); // ensure the frame existed while live

    const resumeRes = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "gate",
        text: "approve",
      }),
    );
    expect(resumeRes.status).toBe(200);
    await pollUntilTerminal(app, runId);

    const after = await app.fetch(new Request(`http://test/api/snapshots/${key}`));
    expect(after.status).toBe(404);
    expect(manager.latest(key)).toBeUndefined();
  });

  test("a run started without a snapshot manager still completes (no publish)", async () => {
    writeFileSync(
      join(wfDir, "noop.yaml"),
      `name: no-snapshot
description: structured emit, no manager wired
nodes:
  - id: emit
    prompt: produce the payload
`,
    );
    const db = openDatabase({ path: join(tmpDir, "nomgr.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "test-project", rootPath: tmpDir });
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    // No snapshotManager in opts — the bridge stays inert.
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore,
      projectsStore,
      promptHandler: structuredHandler,
    });

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/no-snapshot/runs", { inputs: {}, projectId: project.id }),
    );
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    expect(store.getRun(runId)?.status).toBe("succeeded");
  });
});

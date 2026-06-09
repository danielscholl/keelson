// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// W4.5 run-as-conversation contract: every workflow run is paired with a
// conversation, the dispatch user message is persisted, the JOIN projection
// surfaces live run status, FK SET NULL preserves runs when the user deletes
// a conversation, and orphan rollback prevents stranded conversation rows.

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRegistry, registerStubProvider, registerWorkflowProvider } from "@keelson/providers";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import { Hono } from "hono";
import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { chatRoutes } from "../src/chat-handler.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createWorkflowStore, type WorkflowStore } from "../src/workflow-store.ts";
import { createActiveRuns, workflowsRoutes } from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let wfDir: string;

const ORIGIN = "http://127.0.0.1:5173";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-w45-"));
  dbPath = join(tmpDir, "test.db");
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  clearRegistry();
  registerWorkflowProvider();
  // Stub provider so the chat surface has a non-workflow option for the
  // negative test that POSTs a regular conversation.
  registerStubProvider();
});

afterEach(() => {
  rmTemp(tmpDir);
  clearRegistry();
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function postRun(url: string, body: unknown): Request {
  // Auto-inject `workingDir: tmpDir` on /runs POSTs that don't already supply
  // a target. The wire schema requires `projectId` or `workingDir` (see
  // packages/shared/src/workflows.ts); these tests intentionally exercise the
  // server's `defaultCwd: tmpDir` seam, but the schema rejects before the
  // route sees the body. Centralizing the injection here keeps the test
  // bodies focused on what they're asserting.
  let finalBody = body;
  if (url.endsWith("/runs") && body !== null && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (!("projectId" in obj) && !("workingDir" in obj)) {
      finalBody = { ...obj, workingDir: tmpDir };
    }
  }
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(finalBody),
  });
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

async function pollUntilTerminal(
  app: Hono,
  runId: string,
  timeoutMs = 5000,
): Promise<{ status: string; conversationId: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as {
      run: { status: string; conversationId: string | null };
    };
    if (TERMINAL_STATUSES.has(body.run.status)) return body.run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not complete in ${timeoutMs}ms`);
}

// W4.6 — wait for the in-memory store row to satisfy `predicate`. Mirrors
// pollUntilStoreStatus in workflows-route.test.ts; not extracted to a shared
// helper because the test files don't share infrastructure yet (the existing
// pollUntilTerminal is also duplicated across them).
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
}

interface Rig {
  app: Hono;
  store: WorkflowStore;
  conversationStore: ReturnType<typeof createConversationStore>;
}

function makeRig(): Rig {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const activeRuns = createActiveRuns();
  const app = new Hono();
  // Share the activeRuns instance so chat-delete can cancel in-flight runs
  // that workflowsRoutes registered.
  chatRoutes(app, conversationStore, { workflowStore: store, activeRuns });
  workflowsRoutes(app, { catalog, store, conversationStore, defaultCwd: tmpDir }, activeRuns);
  return { app, store, conversationStore };
}

describe("W4.5 run-as-conversation contract", () => {
  test("POST /api/workflows/:name/runs creates conversation + dispatch user message + FK link", async () => {
    writeWorkflow(
      "hello.yaml",
      `name: hello
description: say hi
nodes:
  - id: greet
    bash: echo hi
`,
    );
    const { app } = makeRig();

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/hello/runs", {
        inputs: { ARGUMENTS: "to the world" },
      }),
    );
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };

    // Run detail surfaces the conversationId immediately (before terminal).
    const detailRes = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const { run } = (await detailRes.json()) as {
      run: { conversationId: string | null };
    };
    expect(run.conversationId).toBeTypeOf("string");
    const convId = run.conversationId!;

    // The conversation exists with providerId="workflow" and the dispatch
    // message captured the user's intent.
    const convRes = await app.fetch(new Request(`http://test/api/conversations/${convId}`));
    expect(convRes.status).toBe(200);
    const conv = (await convRes.json()) as {
      providerId: string;
      name?: string;
      messages: Array<{ role: string; content: string }>;
      workflow?: { runId: string; workflowName: string; status: string };
    };
    expect(conv.providerId).toBe("workflow");
    expect(conv.name).toMatch(/^hello · /);
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.role).toBe("user");
    expect(conv.messages[0]!.content).toBe("hello: to the world");
    // The JOIN projection echoes the linked run.
    expect(conv.workflow).toEqual({
      runId,
      workflowName: "hello",
      status: expect.any(String) as unknown as string,
    });
  });

  test("GET /api/conversations hides workflow-linked conversations from the chat sidebar", async () => {
    writeWorkflow(
      "fast.yaml",
      `name: fast
description: instant
nodes:
  - id: ok
    bash: 'true'
`,
    );
    const { app } = makeRig();

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/fast/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);

    const listRes = await app.fetch(new Request("http://test/api/conversations"));
    const listBody = (await listRes.json()) as {
      conversations: Array<{
        id: string;
        providerId: string;
        workflow?: { runId: string };
      }>;
    };
    const linked = listBody.conversations.find((c) => c.workflow?.runId === runId);
    // Workflow runs persist as conversations but only surface in the
    // Workflows tab; the chat-sidebar list filters them out.
    expect(linked).toBeUndefined();
    expect(listBody.conversations.some((c) => c.providerId === "workflow")).toBe(false);
  });

  test("GET /api/conversations/:id still resolves a workflow conversation directly", async () => {
    writeWorkflow(
      "direct.yaml",
      `name: direct
description: direct lookup
nodes:
  - id: ok
    bash: 'true'
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/direct/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);

    const detail = store.getRun(runId);
    const conversationId = detail!.conversationId!;
    // Direct lookups stay open so cascade-delete and the linked-run helpers
    // can resolve the row even though the chat list excludes it.
    const getRes = await app.fetch(new Request(`http://test/api/conversations/${conversationId}`));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { providerId: string };
    expect(body.providerId).toBe("workflow");
  });

  test("paused approval run persists as a workflow conversation but stays out of /api/conversations", async () => {
    writeWorkflow(
      "pa.yaml",
      `name: pa
description: approval
nodes:
  - id: review
    approval:
      message: please approve
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(postRun("http://test/api/workflows/pa/runs", { inputs: {} }));
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilStoreStatus(store, runId, (s) => s === "paused");

    const listRes = await app.fetch(new Request("http://test/api/conversations"));
    const body = (await listRes.json()) as {
      conversations: Array<{ providerId: string }>;
    };
    expect(body.conversations.some((c) => c.providerId === "workflow")).toBe(false);

    // Resume to drain the run so the test doesn't leak a paused run.
    await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    await pollUntilTerminal(app, runId);
  });

  test("DELETE /api/conversations/:id cascades into the linked run", async () => {
    writeWorkflow(
      "cascade.yaml",
      `name: cascade
description: run is purged when its conversation is deleted
nodes:
  - id: ok
    bash: 'true'
`,
    );
    const { app } = makeRig();

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/cascade/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    const { conversationId } = await pollUntilTerminal(app, runId);
    expect(conversationId).toBeTypeOf("string");

    const delRes = await app.fetch(
      new Request(`http://test/api/conversations/${conversationId}`, {
        method: "DELETE",
      }),
    );
    expect(delRes.status).toBe(204);

    // Run row is gone too — no orphan in the Workflows list.
    const detailRes = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    expect(detailRes.status).toBe(404);
  });

  test("orphan rollback: store.createRun failure deletes the just-created conversation", async () => {
    writeWorkflow(
      "anything.yaml",
      `name: anything
description: never reaches the executor
nodes:
  - id: ok
    bash: 'true'
`,
    );
    const db = openDatabase({ path: dbPath });
    const conversationStore = createConversationStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    // Synthetic store that throws on createRun — every other method is a no-op
    // since this test never reaches them.
    const throwingStore: WorkflowStore = {
      createRun: () => {
        throw new Error("simulated FK failure");
      },
      updateRunStatus: () => {},
      upsertNodeOutput: () => {},
      getRun: () => undefined,
      listRuns: () => [],
    };
    const app = new Hono();
    chatRoutes(app, conversationStore, {
      workflowStore: throwingStore,
      activeRuns: createActiveRuns(),
    });
    workflowsRoutes(app, {
      catalog,
      store: throwingStore,
      conversationStore,
      defaultCwd: tmpDir,
    });

    const before = conversationStore.list().length;
    const res = await app.fetch(postRun("http://test/api/workflows/anything/runs", { inputs: {} }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("failed to create run");
    const after = conversationStore.list().length;
    expect(after).toBe(before);
  });

  test("POST /api/conversations rejects providerId='workflow' (400)", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "workflow" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("POST /api/workflows");
  });

  test("UNIQUE constraint prevents two runs pointing at the same conversation", async () => {
    writeWorkflow(
      "any.yaml",
      `name: any
description: any
nodes:
  - id: ok
    bash: 'true'
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const conv = conversationStore.create({ providerId: "workflow" });

    store.createRun({
      runId: "r1",
      workflowName: "any",
      inputs: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      conversationId: conv.id,
    });

    expect(() =>
      store.createRun({
        runId: "r2",
        workflowName: "any",
        inputs: {},
        startedAt: "2025-01-01T00:00:01.000Z",
        conversationId: conv.id,
      }),
    ).toThrow();
  });
});

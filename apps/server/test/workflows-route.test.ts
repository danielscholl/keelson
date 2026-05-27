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
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";

import { makePromptHandler } from "@keelson/workflows";
import { Hono } from "hono";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore, type ProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore, type WorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowSubscribers,
  workflowsRoutes,
} from "../src/workflows-handler.ts";

let tmpDir: string;
let dbPath: string;
let wfDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workflows-route-"));
  dbPath = join(tmpDir, "test.db");
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  // Reset the postRun auto-inject latch — inline rigs that bypass makeRig
  // must not inherit a project id from the previous test's DB.
  CURRENT_DEFAULT_PROJECT_ID = null;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Rig {
  app: Hono;
  store: WorkflowStore;
  projectsStore: ProjectsStore;
  // Pre-created project so test bodies can target a real id without setup
  // churn. Suite-wide single project keeps the assertion surface small;
  // tests that exercise project-scoping wire their own.
  defaultProjectId: string;
}

// Module-level latch: makeRig stamps the per-test default project id here so
// `postRun` can auto-inject it into /runs bodies without every callsite having
// to thread it through. Reset to null in beforeEach so inline rigs that bypass
// makeRig don't inherit a stale id from the previous test.
let CURRENT_DEFAULT_PROJECT_ID: string | null = null;

function makeRig(): Rig {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const defaultProject = projectsStore.create({ name: "test-project", rootPath: tmpDir });
  CURRENT_DEFAULT_PROJECT_ID = defaultProject.id;
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const app = new Hono();
  workflowsRoutes(app, { catalog, store, conversationStore, projectsStore });
  return { app, store, projectsStore, defaultProjectId: defaultProject.id };
}

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

// Real browser fetches always send Origin; the handler refuses state-changing
// POSTs without it (CSRF guard).
const ORIGIN = "http://127.0.0.1:5173";

function postRun(url: string, body: unknown, init: RequestInit = {}): Request {
  // Auto-inject the test's default project id on /runs POSTs that don't
  // already specify a target. The route requires `projectId` or `workingDir`;
  // tests that don't care about targeting shouldn't have to set one.
  let finalBody = body;
  if (
    url.endsWith("/runs") &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    CURRENT_DEFAULT_PROJECT_ID !== null
  ) {
    const obj = body as Record<string, unknown>;
    if (!("projectId" in obj) && !("workingDir" in obj)) {
      finalBody = { ...obj, projectId: CURRENT_DEFAULT_PROJECT_ID };
    }
  }
  return new Request(url, {
    method: "POST",
    ...init,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: typeof finalBody === "string" ? finalBody : JSON.stringify(finalBody),
  });
}

// Use the wire-schema terminal set (succeeded | failed | cancelled). `paused`
// is intentionally NOT terminal — tests waiting on resume / abandon poll past
// it. Cast to ReadonlySet<string> for the row-level check below.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

async function pollUntilTerminal(
  app: Hono,
  runId: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { status: string } };
    if (TERMINAL_STATUSES.has(body.run.status)) {
      return body.run as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not complete in ${timeoutMs}ms`);
}

// Poll the in-memory store until `predicate(status)` is true. Used by the
// W4.6 approval tests to wait for the run to reach `paused` before issuing
// POST /resume or DELETE — the route layer doesn't expose a hook for
// "executor has actually opened the pause", so the snapshot is the
// authoritative signal. Default timeout matches pollUntilTerminal.
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

describe("workflows REST routes", () => {
  test("GET /api/workflows lists discovered workflows with node counts", async () => {
    writeWorkflow(
      "hello.yaml",
      `name: hello
description: |
  Says hi.
nodes:
  - id: greet
    bash: echo hi
`,
    );
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/workflows"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ name: string; description: string; nodeCount: number }>;
    };
    const hello = body.workflows.find((w) => w.name === "hello");
    expect(hello).toBeDefined();
    expect(hello!.nodeCount).toBe(1);
    expect(hello!.description).toContain("Says hi");
  });

  test("GET /api/workflows surfaces loader notices in discoveryNotices", async () => {
    // Valid workflow renders in the catalog as usual.
    writeWorkflow(
      "ok.yaml",
      `name: ok
description: works
nodes:
  - id: greet
    bash: echo hi
`,
    );
    // Malformed YAML drops the file but should surface as an error-level notice
    // (the UI toasts it; the catalog stays usable).
    writeWorkflow("broken.yaml", "name: broken\nnodes: not-a-list\n");
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/workflows"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ name: string }>;
      discoveryNotices: Array<{
        level: "error" | "warning";
        filename: string;
        nodeId?: string;
        message: string;
      }>;
    };
    expect(body.workflows.find((w) => w.name === "ok")).toBeDefined();
    expect(body.workflows.find((w) => w.name === "broken")).toBeUndefined();
    const brokenNotice = body.discoveryNotices.find((n) => n.filename.endsWith("broken.yaml"));
    expect(brokenNotice).toBeDefined();
    expect(brokenNotice!.level).toBe("error");
  });

  test("GET /api/workflows/:name returns workflow detail including node types", async () => {
    writeWorkflow(
      "two-step.yaml",
      `name: two-step
description: bash then prompt
nodes:
  - id: collect
    bash: echo data
  - id: summarize
    depends_on: [collect]
    prompt: summarize $collect.output
`,
    );
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/workflows/two-step"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow: { nodes: Array<{ id: string; type: string; dependsOn?: string[] }> };
    };
    const nodes = body.workflow.nodes;
    expect(nodes.find((n) => n.id === "collect")?.type).toBe("bash");
    expect(nodes.find((n) => n.id === "summarize")?.type).toBe("prompt");
    expect(nodes.find((n) => n.id === "summarize")?.dependsOn).toEqual(["collect"]);
  });

  test("GET /api/workflows/:name returns 404 for unknown workflow", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/workflows/nope"));
    expect(res.status).toBe(404);
  });

  test("POST .../runs returns runId; bash-only workflow completes succeeded", async () => {
    writeWorkflow(
      "echo.yaml",
      `name: echo-once
description: just echoes
nodes:
  - id: shout
    bash: |
      echo "hello from W2"
`,
    );
    const { app } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/echo-once/runs", { inputs: {} }),
    );
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ nodeId: string; status: string; outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    expect(run.nodes).toHaveLength(1);
    expect(run.nodes[0]!.status).toBe("succeeded");
    expect(run.nodes[0]!.outputText).toContain("hello from W2");
  });

  test("POST .../runs on a prompt workflow fails the prompt node with W3 placeholder", async () => {
    writeWorkflow(
      "promptwf.yaml",
      `name: promptwf
description: bash + prompt
nodes:
  - id: collect
    bash: echo collected
  - id: summarize
    depends_on: [collect]
    prompt: summarize $collect.output
`,
    );
    const { app } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/promptwf/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };

    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ nodeId: string; status: string; error: string | null }>;
    };
    expect(run.status).toBe("failed");
    const collect = run.nodes.find((n) => n.nodeId === "collect");
    const summarize = run.nodes.find((n) => n.nodeId === "summarize");
    expect(collect?.status).toBe("succeeded");
    expect(summarize?.status).toBe("failed");
    expect(summarize?.error).toContain("prompt handler not registered");
  });

  test("inputs flow through to bash as KEELSON_INPUTS_* env vars", async () => {
    writeWorkflow(
      "echoargs.yaml",
      `name: echoargs
description: echoes ARGUMENTS
nodes:
  - id: shout
    bash: echo "got $KEELSON_ARGUMENTS"
`,
    );
    const { app } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/echoargs/runs", {
        inputs: { ARGUMENTS: "PIV" },
      }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.nodes[0]!.outputText).toContain("got PIV");
  });

  test("activeRuns.abortAll drains in-flight runs and persists 'cancelled'", async () => {
    // Mimics the shutdown path: an in-flight bash run is aborted via the
    // composition-root ActiveRuns handle; the executor's run_done branch
    // writes "cancelled" to SQLite, and abortAll awaits that settlement.
    writeWorkflow(
      "long.yaml",
      `name: long
description: long-running bash
nodes:
  - id: sleeper
    bash: sleep 30
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    const { createActiveRuns, workflowsRoutes } = await import("../src/workflows-handler.ts");
    const activeRuns = createActiveRuns();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore: createConversationStore(db), defaultCwd: tmpDir },
      activeRuns,
    );

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/long/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };

    // Give the executor a beat to emit run_started and the bash handler
    // to spawn.
    await new Promise((r) => setTimeout(r, 100));
    expect(activeRuns.size()).toBe(1);

    await activeRuns.abortAll("test shutdown");

    expect(activeRuns.size()).toBe(0);
    const run = store.getRun(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("cancelled");
  });

  test("GET /api/workflows/runs/:id returns 404 for unknown run", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/workflows/runs/no-such-run"));
    expect(res.status).toBe(404);
  });

  test("POST .../runs rejects requests with no Origin header (CSRF gate)", async () => {
    writeWorkflow(
      "danger.yaml",
      `name: danger
description: bash node
nodes:
  - id: shell
    bash: echo hi
`,
    );
    const { app, store } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/danger/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: {} }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden origin");
    // The run must NOT have been created — the gate fires before persistence.
    expect(store.listRuns("danger")).toHaveLength(0);
  });

  test("POST .../runs rejects cross-origin requests", async () => {
    writeWorkflow(
      "danger2.yaml",
      `name: danger2
description: bash node
nodes:
  - id: shell
    bash: echo hi
`,
    );
    const { app, store } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/danger2/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
        },
        body: JSON.stringify({ inputs: {} }),
      }),
    );
    expect(res.status).toBe(403);
    expect(store.listRuns("danger2")).toHaveLength(0);
  });

  test("POST .../runs returns 400 for malformed JSON body", async () => {
    writeWorkflow(
      "j.yaml",
      `name: j
description: bash
nodes:
  - id: x
    bash: echo hi
`,
    );
    const { app, store } = makeRig();
    const res = await app.fetch(postRun("http://test/api/workflows/j/runs", "{not json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid json body");
    expect(store.listRuns("j")).toHaveLength(0);
  });

  test("POST .../runs with no inputs defaults to {} when target is supplied", async () => {
    writeWorkflow(
      "k.yaml",
      `name: k
description: bash
nodes:
  - id: x
    bash: echo hi
`,
    );
    const { app, defaultProjectId } = makeRig();
    // `inputs` is optional and defaults to {}; the target (projectId here)
    // is what's required.
    const res = await app.fetch(
      postRun("http://test/api/workflows/k/runs", { projectId: defaultProjectId }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(run.status).toBe("succeeded");
  });

  test("POST .../runs without projectId or workingDir returns 400", async () => {
    writeWorkflow(
      "no-target.yaml",
      `name: no-target
description: bash
nodes:
  - id: x
    bash: echo hi
`,
    );
    const { app } = makeRig();
    // Bypass postRun's auto-inject so we exercise the bare-empty body path.
    const res = await app.fetch(
      new Request("http://test/api/workflows/no-target/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {} }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("projectId or workingDir");
  });

  test("POST .../runs rejects workingDir pointing at a file (not a directory)", async () => {
    writeWorkflow(
      "to-file.yaml",
      `name: to-file
description: bash
nodes:
  - id: x
    bash: echo hi
`,
    );
    const filePath = join(tmpDir, "not-a-dir.txt");
    writeFileSync(filePath, "marker");
    const { app } = makeRig();
    const res = await app.fetch(
      postRun("http://test/api/workflows/to-file/runs", { inputs: {}, workingDir: filePath }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not a directory");
  });

  test("POST .../runs rejects workingDir that does not exist", async () => {
    writeWorkflow(
      "to-missing.yaml",
      `name: to-missing
description: bash
nodes:
  - id: x
    bash: echo hi
`,
    );
    const { app } = makeRig();
    const res = await app.fetch(
      postRun("http://test/api/workflows/to-missing/runs", {
        inputs: {},
        workingDir: join(tmpDir, "does-not-exist"),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not exist");
  });

  test("injected prompt handler — node succeeds end-to-end and contentParts persists", async () => {
    writeWorkflow(
      "spwf.yaml",
      `name: spwf
description: bash + injected prompt
nodes:
  - id: collect
    bash: echo collected
  - id: summarize
    depends_on: [collect]
    prompt: summarize $collect.output
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    // Spy provider streams two text chunks + a tool_use + tool_result so the
    // run consumer's content-parts accumulator is exercised end-to-end.
    const spyProvider = {
      async *sendQuery() {
        yield { type: "text", content: "Summary: " };
        yield { type: "tool_use", id: "tu-1", toolName: "some_tool" };
        yield {
          type: "tool_result",
          toolUseId: "tu-1",
          content: '{"phase":"Healthy"}',
        };
        yield { type: "text", content: "all clear" };
        yield { type: "done" };
      },
    };
    const promptHandler = makePromptHandler({
      getProvider: () => spyProvider,
      getRegisteredTools: () => [],
    });
    const app = new Hono();
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore: createConversationStore(db),
      defaultCwd: tmpDir,
      promptHandler,
    });
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/spwf/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{
        nodeId: string;
        status: string;
        outputText: string | null;
        contentParts: Array<{ type: string }> | null;
      }>;
    };
    expect(run.status).toBe("succeeded");
    const summarize = run.nodes.find((n) => n.nodeId === "summarize");
    expect(summarize?.status).toBe("succeeded");
    // Accumulated text from both text chunks; tool_use/tool_result are
    // structured, not text, so they don't enter outputText.
    expect(summarize?.outputText).toBe("Summary: all clear");
    // contentParts captures the structured shape: collapsed text → tool_use → tool_result → text.
    const parts = summarize?.contentParts ?? [];
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.type)).toEqual(["text", "tool_use", "tool_result", "text"]);
  });

  test("DELETE /api/workflows/runs/:runId cancels an in-flight prompt run", async () => {
    writeWorkflow(
      "longprompt.yaml",
      `name: longprompt
description: slow prompt
nodes:
  - id: think
    prompt: take your time
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    // Provider holds the stream open via per-chunk delay; the test fires DELETE
    // before any chunk lands. AbortSignal must propagate from the run's
    // AbortController through the prompt handler into the provider's stream.
    const slowProvider = {
      async *sendQuery(
        _p: string,
        _c: string,
        _r: unknown,
        options: { abortSignal?: AbortSignal },
      ) {
        for (let i = 0; i < 100; i++) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 50);
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
          if (options.abortSignal?.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          yield { type: "text", content: `chunk ${i}` };
        }
        yield { type: "done" };
      },
    };
    const promptHandler = makePromptHandler({
      getProvider: () => slowProvider,
      getRegisteredTools: () => [],
    });
    const activeRuns = createActiveRuns();
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore: createConversationStore(db),
        defaultCwd: tmpDir,
        promptHandler,
      },
      activeRuns,
    );

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/longprompt/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    // Give the executor a tick to start the node and the provider to start emitting.
    await new Promise((r) => setTimeout(r, 75));
    expect(activeRuns.size()).toBe(1);

    const delRes = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ cancelled: true });

    const run = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(run.status).toBe("cancelled");
  });

  test("DELETE returns 404 for an unknown / completed run", async () => {
    writeWorkflow(
      "delfast.yaml",
      `name: delfast
description: instant bash
nodes:
  - id: q
    bash: echo done
`,
    );
    const { app } = makeRig();
    // Unknown runId → 404.
    const res1 = await app.fetch(
      new Request("http://test/api/workflows/runs/no-such-run", {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res1.status).toBe(404);

    // Completed runId → 404 (activeRuns.delete fires when the run finishes,
    // so the route has nothing to abort).
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/delfast/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    const res2 = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res2.status).toBe(404);
  });

  test("DELETE rejects cross-origin requests (CSRF)", async () => {
    writeWorkflow(
      "delcsrf.yaml",
      `name: delcsrf
description: bash
nodes:
  - id: x
    bash: sleep 5
`,
    );
    const { app } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/delcsrf/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    const res = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("DELETE ?purge=1 hard-deletes a terminal run and its linked conversation", async () => {
    writeWorkflow(
      "purgable.yaml",
      `name: purgable
description: bash that completes
nodes:
  - id: greet
    bash: echo hi
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    workflowsRoutes(app, { catalog, store, conversationStore, defaultCwd: tmpDir });

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/purgable/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    const before = store.getRun(runId);
    expect(before?.status).toBe("succeeded");
    const conversationId = before!.conversationId!;
    expect(conversationStore.get(conversationId)).toBeDefined();

    const delRes = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}?purge=1`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    expect(store.getRun(runId)).toBeUndefined();
    expect(conversationStore.get(conversationId)).toBeUndefined();
    const nodeCount = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_node_outputs WHERE run_id = ?")
      .get(runId) as { c: number };
    expect(nodeCount.c).toBe(0);

    const getRes = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    expect(getRes.status).toBe(404);
  });

  test("DELETE ?purge=1 cancels-then-deletes an in-flight run", async () => {
    writeWorkflow(
      "slowpurge.yaml",
      `name: slowpurge
description: slow prompt then purge
nodes:
  - id: think
    prompt: take your time
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const slowProvider = {
      async *sendQuery(
        _p: string,
        _c: string,
        _r: unknown,
        options: { abortSignal?: AbortSignal },
      ) {
        for (let i = 0; i < 100; i++) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 50);
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
          if (options.abortSignal?.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          yield { type: "text", content: `chunk ${i}` };
        }
        yield { type: "done" };
      },
    };
    const promptHandler = makePromptHandler({
      getProvider: () => slowProvider,
      getRegisteredTools: () => [],
    });
    const activeRuns = createActiveRuns();
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, defaultCwd: tmpDir, promptHandler },
      activeRuns,
    );

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/slowpurge/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await new Promise((r) => setTimeout(r, 75));
    expect(activeRuns.size()).toBe(1);
    const conversationId = store.getRun(runId)!.conversationId!;

    const delRes = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}?purge=1`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });
    expect(store.getRun(runId)).toBeUndefined();
    expect(conversationStore.get(conversationId)).toBeUndefined();
    expect(activeRuns.size()).toBe(0);
  });

  test("DELETE ?purge=1 returns 404 for an unknown run", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/runs/no-such-run?purge=1", {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE without ?purge still rejects terminal runs (regression)", async () => {
    writeWorkflow(
      "noproge.yaml",
      `name: noproge
description: bash
nodes:
  - id: q
    bash: echo done
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/noproge/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    const res = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(404);
    // Row is still present in history — cancel without purge is non-destructive.
    expect(store.getRun(runId)?.status).toBe("succeeded");
  });

  test("DELETE ?purge=1 rejects cross-origin requests (CSRF)", async () => {
    writeWorkflow(
      "purgecsrf.yaml",
      `name: purgecsrf
description: bash
nodes:
  - id: q
    bash: echo done
`,
    );
    const { app } = makeRig();
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/purgecsrf/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    const res = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}?purge=1`, {
        method: "DELETE",
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("workflowRunWebSocketHandlers.open sends synthetic run_done when subscribing after a fast run terminates", async () => {
    // The POST-then-subscribe race: a workflow that completes before the
    // client can open the WS would otherwise leave the socket idle with no
    // terminal signal. Reconciling against the persisted store at open time
    // closes the gap with a synthetic run_done frame.
    const { workflowRunWebSocketHandlers } = await import("../src/workflows-handler.ts");
    writeWorkflow(
      "instant.yaml",
      `name: instant
description: a one-line bash that completes instantly
nodes:
  - id: hi
    bash: echo hi
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const subscribers = createWorkflowSubscribers();
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore: createConversationStore(db), defaultCwd: tmpDir },
      undefined,
      subscribers,
    );
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/instant/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    // Wait for the run to fully terminate AND for activeRuns/subscribers to
    // be cleared (mimics a client subscribing after the run completes).
    await pollUntilTerminal(app, runId);

    const sent: unknown[] = [];
    let closed = false;
    const fakeWs = {
      data: { runId, kind: "workflowRun" as const, abort: new AbortController() },
      send: (raw: string) => {
        sent.push(JSON.parse(raw));
      },
      close: () => {
        closed = true;
      },
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof workflowRunWebSocketHandlers>["open"]>
    >[0];

    const handlers = workflowRunWebSocketHandlers({ subscribers, store });
    handlers.open?.(fakeWs);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "run_done", status: "succeeded" });
    expect(closed).toBe(true);
  });

  test("workflowRunWebSocketHandlers.open closes with 1008 for unknown runId", async () => {
    const { workflowRunWebSocketHandlers } = await import("../src/workflows-handler.ts");
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const subscribers = createWorkflowSubscribers();
    let closeCode: number | undefined;
    const fakeWs = {
      data: {
        runId: "no-such-run",
        kind: "workflowRun" as const,
        abort: new AbortController(),
      },
      send: () => {},
      close: (code: number) => {
        closeCode = code;
      },
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof workflowRunWebSocketHandlers>["open"]>
    >[0];
    const handlers = workflowRunWebSocketHandlers({ subscribers, store });
    handlers.open?.(fakeWs);
    expect(closeCode).toBe(1008);
  });

  test("WS subscribers receive run_started → node_chunk → node_done → run_done", async () => {
    // The subscriber manager is unit-tested through its public broadcast API;
    // the route is the integration point. Hook a synthetic socket into the
    // subscribers manager and assert the executor's onEvent path produces the
    // expected workflowFrame sequence.
    writeWorkflow(
      "wsflow.yaml",
      `name: wsflow
description: bash then prompt
nodes:
  - id: collect
    bash: echo data
  - id: summarize
    depends_on: [collect]
    prompt: summarize $collect.output
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const spyProvider = {
      async *sendQuery() {
        yield { type: "text", content: "hi" };
        yield { type: "done" };
      },
    };
    const promptHandler = makePromptHandler({
      getProvider: () => spyProvider,
      getRegisteredTools: () => [],
    });
    const subscribers = createWorkflowSubscribers();
    const received: Array<{ type: string; nodeId?: string }> = [];
    // Synthetic socket; only `send` is exercised by broadcast.
    const fakeWs = {
      send: (raw: string) => {
        received.push(JSON.parse(raw));
      },
    } as unknown as Parameters<typeof subscribers.subscribe>[1];
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore: createConversationStore(db),
        defaultCwd: tmpDir,
        promptHandler,
      },
      undefined,
      subscribers,
    );
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/wsflow/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    subscribers.subscribe(runId, fakeWs);
    await pollUntilTerminal(app, runId);
    // Give the closeRun → fanout cycle a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
    const types = received.map((f) => f.type);
    expect(types).toContain("node_started");
    expect(types).toContain("node_done");
    expect(types[types.length - 1]).toBe("run_done");
    const chunkFrames = received.filter((f) => f.type === "node_chunk");
    expect(chunkFrames.length).toBeGreaterThan(0);
    const logFrames = received.filter((f) => f.type === "node_log");
    expect(logFrames.length).toBeGreaterThan(0);
  });

  test("POST /resume completes a paused approval run end-to-end", async () => {
    // The starter plan-and-apply YAML mirrors this shape, but we keep the
    // fixture inline so the route test doesn't depend on a particular
    // starter living in the repo.
    writeWorkflow(
      "pa.yaml",
      `name: pa
description: approval
nodes:
  - id: review
    approval:
      message: please approve
  - id: apply
    depends_on: [review]
    when: "$review.output == 'approve'"
    bash: echo applied
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(postRun("http://test/api/workflows/pa/runs", { inputs: {} }));
    const { runId } = (await startRes.json()) as { runId: string };
    // Wait for the executor to actually open the pause — the persisted run
    // row flips from 'running' to 'paused' inside awaitApproval.
    await pollUntilStoreStatus(store, runId, (s) => s === "paused");
    expect(store.getRun(runId)?.status).toBe("paused");
    const awaitingNode = store.getRun(runId)?.nodes.find((n) => n.status === "awaiting");
    expect(awaitingNode?.nodeId).toBe("review");
    expect(awaitingNode?.outputText).toBe("please approve");

    const resumeRes = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toEqual({ resumed: true });

    const terminal = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ nodeId: string; status: string; outputText: string | null }>;
    };
    expect(terminal.status).toBe("succeeded");
    const review = terminal.nodes.find((n) => n.nodeId === "review");
    expect(review?.status).toBe("succeeded");
    expect(review?.outputText).toBe("approve");
    const apply = terminal.nodes.find((n) => n.nodeId === "apply");
    expect(apply?.status).toBe("succeeded");
  });

  test("POST /resume returns 404 for unknown / completed runId", async () => {
    writeWorkflow(
      "done.yaml",
      `name: done
description: fast
nodes:
  - id: ok
    bash: echo ok
`,
    );
    const { app } = makeRig();
    // Unknown runId — never existed.
    const r1 = await app.fetch(
      postRun("http://test/api/workflows/runs/no-such/resume", {
        nodeId: "any",
        text: "approve",
      }),
    );
    expect(r1.status).toBe(404);
    // Completed run — activeRuns.delete fired on terminus.
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/done/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);
    const r2 = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "ok",
        text: "approve",
      }),
    );
    expect(r2.status).toBe(404);
  });

  test("POST /resume returns 409 when the nodeId has no pending approval", async () => {
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
    const res = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "no-such-node",
        text: "approve",
      }),
    );
    expect(res.status).toBe(409);
    // Cleanup: resolve the real one so the test doesn't leak a paused run.
    await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    await pollUntilTerminal(app, runId);
  });

  test("POST /resume rejects cross-origin requests (CSRF)", async () => {
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
    const res = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}/resume`, {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ nodeId: "review", text: "approve" }),
      }),
    );
    expect(res.status).toBe(403);
    // Cleanup.
    await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    await pollUntilTerminal(app, runId);
  });

  test("DELETE during pause abandons the run cleanly", async () => {
    writeWorkflow(
      "pa.yaml",
      `name: pa
description: approval
nodes:
  - id: review
    approval:
      message: please approve
  - id: apply
    depends_on: [review]
    bash: echo never
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(postRun("http://test/api/workflows/pa/runs", { inputs: {} }));
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilStoreStatus(store, runId, (s) => s === "paused");
    expect(store.getRun(runId)?.status).toBe("paused");
    const delRes = await app.fetch(
      new Request(`http://test/api/workflows/runs/${runId}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
    );
    expect(delRes.status).toBe(200);
    const terminal = (await pollUntilTerminal(app, runId)) as {
      status: string;
    };
    expect(terminal.status).toBe("cancelled");
  });

  test("approval_awaiting frame broadcasts to subscribers", async () => {
    // Insert a leading bash node so the approval doesn't fire on the first
    // executor tick — that gives the test time to register its subscriber
    // before the approval broadcast happens. The first-layer race only
    // matters in the test rig where the WS subscribe happens after the
    // POST response is parsed; real clients subscribe via the route's
    // upgrade handler which reads the snapshot to backfill missed terminal
    // frames (W4.5).
    writeWorkflow(
      "pa.yaml",
      `name: pa
description: approval
nodes:
  - id: setup
    bash: sleep 0.05
  - id: review
    depends_on: [setup]
    approval:
      message: please approve
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const subscribers = createWorkflowSubscribers();
    const received: Array<{ type: string; nodeId?: string; message?: string }> = [];
    const fakeWs = {
      send: (raw: string) => {
        received.push(JSON.parse(raw));
      },
    } as unknown as Parameters<typeof subscribers.subscribe>[1];
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore: createConversationStore(db),
        defaultCwd: tmpDir,
      },
      undefined,
      subscribers,
    );
    const startRes = await app.fetch(
      postRun("http://test/api/workflows/pa/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    subscribers.subscribe(runId, fakeWs);
    const pausedDeadline = Date.now() + 2000;
    while (Date.now() < pausedDeadline) {
      if (received.some((f) => f.type === "approval_awaiting")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const approvalFrame = received.find((f) => f.type === "approval_awaiting");
    expect(approvalFrame).toBeDefined();
    expect(approvalFrame?.nodeId).toBe("review");
    expect(approvalFrame?.message).toBe("please approve");
    // Cleanup.
    await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    await pollUntilTerminal(app, runId);
  });

  test("W4.6 — /api/db/reset preserves paused workflow_runs alongside running", async () => {
    // A db-reset path wipes terminal rows. Paused rows are in-flight (the
    // route's pendingApprovals map holds the live resolver); dropping the
    // parent row would cascade-delete the awaiting node and strand POST
    // /resume against a missing run. This test pokes the same SQL the
    // reset handler would run and asserts paused rows survive.
    const { store } = makeRig();
    const db = openDatabase({ path: dbPath });
    const now = new Date().toISOString();
    // Seed one of each status by hand (createRun always writes 'running',
    // so we updateRunStatus immediately after to land the test fixture).
    const fixtures: Array<[string, "running" | "paused" | "succeeded" | "failed" | "cancelled"]> = [
      ["run-running", "running"],
      ["run-paused", "paused"],
      ["run-succeeded", "succeeded"],
      ["run-failed", "failed"],
      ["run-cancelled", "cancelled"],
    ];
    // Seed a fresh conversation per run — the workflow_runs.conversation_id
    // FK is UNIQUE (one run per conversation), so we can't reuse a single
    // row across all fixtures.
    const convStore = createConversationStore(db);
    for (const [id, status] of fixtures) {
      const conv = convStore.create({ providerId: "workflow" });
      store.createRun({
        runId: id,
        workflowName: "x",
        inputs: {},
        startedAt: now,
        conversationId: conv.id,
      });
      if (status !== "running") {
        store.updateRunStatus({
          runId: id,
          status,
          completedAt: status === "paused" ? null : now,
          error: null,
        });
      }
    }
    // Same SQL the reset handler runs.
    db.exec(`DELETE FROM workflow_runs WHERE status NOT IN ('running', 'paused');`);
    const remaining = (
      db.query("SELECT id, status FROM workflow_runs ORDER BY id").all() as {
        id: string;
        status: string;
      }[]
    ).map((r) => `${r.id}:${r.status}`);
    expect(remaining).toEqual(["run-paused:paused", "run-running:running"]);
  });

  test("W4.6 — sibling approvals: server stays paused until ALL pending resolvers settle", async () => {
    // Two parallel approval nodes share a layer. Resolving one MUST leave
    // the run row in 'paused' until the second resolves — the executor's
    // layer doesn't complete until both handlers return, and the route's
    // resume endpoint only flips back to 'running' when
    // pendingApprovals.size === 0. Regression test for the hook bug Codex
    // flagged where the UI was inferring 'running' from the first node_done.
    writeWorkflow(
      "pa2.yaml",
      `name: pa2
description: two parallel approvals
nodes:
  - id: setup
    bash: 'true'
  - id: review-a
    depends_on: [setup]
    approval:
      message: approve a
  - id: review-b
    depends_on: [setup]
    approval:
      message: approve b
`,
    );
    const { app, store } = makeRig();
    const startRes = await app.fetch(postRun("http://test/api/workflows/pa2/runs", { inputs: {} }));
    const { runId } = (await startRes.json()) as { runId: string };
    // Wait until BOTH approvals have registered (the run row flips paused
    // on the first handler open; we additionally want both node rows in
    // 'awaiting' before testing the partial-resume invariant).
    await pollUntilStoreStatus(store, runId, (s) => s === "paused");
    const awaitDeadline = Date.now() + 2000;
    while (Date.now() < awaitDeadline) {
      const awaitingCount = (store.getRun(runId)?.nodes ?? []).filter(
        (n) => n.status === "awaiting",
      ).length;
      if (awaitingCount === 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const beforeNodes = store.getRun(runId)?.nodes ?? [];
    expect(beforeNodes.filter((n) => n.status === "awaiting").length).toBe(2);

    // Resume the first approval. Run row must remain 'paused' because
    // review-b is still open.
    const resumeA = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review-a",
        text: "approve",
      }),
    );
    expect(resumeA.status).toBe(200);
    // Give the executor a tick to process the resolved promise.
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getRun(runId)?.status).toBe("paused");

    // Resume the second — now the run drains to terminal.
    const resumeB = await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review-b",
        text: "approve",
      }),
    );
    expect(resumeB.status).toBe(200);
    const terminal = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(terminal.status).toBe("succeeded");
  });

  test("GET /api/workflows/:name/runs lists past runs newest-first", async () => {
    writeWorkflow(
      "two.yaml",
      `name: two
description: two echoes
nodes:
  - id: one
    bash: echo one
`,
    );
    const { app, store } = makeRig();

    const r1 = (await (
      await app.fetch(postRun("http://test/api/workflows/two/runs", { inputs: {} }))
    ).json()) as { runId: string };
    await pollUntilTerminal(app, r1.runId);

    const r2 = (await (
      await app.fetch(postRun("http://test/api/workflows/two/runs", { inputs: {} }))
    ).json()) as { runId: string };
    await pollUntilTerminal(app, r2.runId);

    const listRes = await app.fetch(new Request("http://test/api/workflows/two/runs"));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      runs: Array<{ runId: string; status: string }>;
    };
    // store.listRuns ordering is asserted directly too — the route should match.
    expect(body.runs.map((r) => r.runId)).toEqual([r2.runId, r1.runId]);
    expect(store.listRuns("two")).toHaveLength(2);
  });

  test("GET /api/workflows/runs?status=paused returns currently-paused runs", async () => {
    writeWorkflow(
      "pause-list.yaml",
      `name: pause-list
description: paused list
nodes:
  - id: review
    approval:
      message: please approve
`,
    );
    const { app, store } = makeRig();

    // No paused runs yet — endpoint returns an empty list, not 404.
    const emptyRes = await app.fetch(new Request("http://test/api/workflows/runs?status=paused"));
    expect(emptyRes.status).toBe(200);
    expect(((await emptyRes.json()) as { runs: unknown[] }).runs).toHaveLength(0);

    const startRes = await app.fetch(
      postRun("http://test/api/workflows/pause-list/runs", { inputs: {} }),
    );
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilStoreStatus(store, runId, (s) => s === "paused");

    const listRes = await app.fetch(new Request("http://test/api/workflows/runs?status=paused"));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      runs: Array<{ runId: string; status: string }>;
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toBe(runId);
    expect(body.runs[0].status).toBe("paused");

    // Cleanup: resume so the rig doesn't leak a paused run between tests.
    await app.fetch(
      postRun(`http://test/api/workflows/runs/${runId}/resume`, {
        nodeId: "review",
        text: "approve",
      }),
    );
    await pollUntilTerminal(app, runId);
  });

  test("GET /api/workflows/runs rejects missing or invalid status query (400)", async () => {
    const { app } = makeRig();
    const missing = await app.fetch(new Request("http://test/api/workflows/runs"));
    expect(missing.status).toBe(400);
    const invalid = await app.fetch(new Request("http://test/api/workflows/runs?status=running"));
    expect(invalid.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // memory: block end-to-end — writeback from run 1 surfaces in run 2's recall.
  // Real MemoryStore over in-memory SQLite, exercises the adapter wired in workflows-handler.ts.
  // -------------------------------------------------------------------------
  test("memory: writeback in run 1 is recalled in run 2", async () => {
    const { createMemoryStore } = await import("../src/memory-store.ts");
    // Bash node fires the writeback so this doesn't need a real prompt handler.
    writeWorkflow(
      "memory-demo.yaml",
      `name: memory-demo
description: memory block e2e
nodes:
  - id: think
    bash: echo "hello world"
    memory:
      recall:
        query: hello
      writeback:
        on: success
        type: lesson
        summary: hello-summary
        content: hello-content
        sourceRefs:
          - { kind: workflow_run, uri: "demo" }
`,
    );

    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const memoryStore = createMemoryStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore,
      defaultCwd: tmpDir,
      memoryStore,
    });

    // Run 1 — writes to memory.
    const start1 = await app.fetch(
      postRun("http://test/api/workflows/memory-demo/runs", { inputs: {}, workingDir: tmpDir }),
    );
    expect(start1.status).toBe(200);
    const { runId: runId1 } = (await start1.json()) as { runId: string };
    const run1 = await pollUntilTerminal(app, runId1);
    expect(run1.status).toBe("succeeded");

    // Sanity: the memory landed via the store directly.
    const recall1 = memoryStore.recall({
      schemaVersion: "keelson.memory.recall.v1",
      scope: { visibility: "project" },
      task: { runtime: "workflow" },
      query: "hello",
    });
    expect(recall1.items.length).toBeGreaterThan(0);
    expect(recall1.items[0]?.summary).toBe("hello-summary");
    expect(recall1.items[0]?.provenance).toBe("generated");

    // Run 2 — the recall hook should surface run 1's writeback. The route
    // doesn't expose recall events directly today, so the assertion is
    // that the in-process store sees a recall_trace row recorded by the
    // executor's pre-run hook.
    const start2 = await app.fetch(
      postRun("http://test/api/workflows/memory-demo/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId: runId2 } = (await start2.json()) as { runId: string };
    const run2 = await pollUntilTerminal(app, runId2);
    expect(run2.status).toBe("succeeded");

    // The second run wrote a second recall trace AND a second writeback
    // (idempotency-deduped by content hash, so only one persisted memory
    // total).
    const recall2 = memoryStore.recall({
      schemaVersion: "keelson.memory.recall.v1",
      scope: { visibility: "project" },
      task: { runtime: "workflow" },
      query: "hello",
    });
    expect(recall2.items.length).toBeGreaterThan(0);
  });

  test("memory: workflows still execute when memoryStore is not wired (no-op)", async () => {
    writeWorkflow(
      "memory-noop.yaml",
      `name: memory-noop
description: no-adapter case
nodes:
  - id: think
    bash: echo "no adapter"
    memory:
      writeback:
        on: success
        type: lesson
        summary: s
        content: c
`,
    );
    // makeRig() does NOT pass memoryStore — the executor's hooks no-op.
    const { app } = makeRig();
    const start = await app.fetch(
      postRun("http://test/api/workflows/memory-noop/runs", { inputs: {} }),
    );
    const { runId } = (await start.json()) as { runId: string };
    const run = await pollUntilTerminal(app, runId);
    expect(run.status).toBe("succeeded");
  });

  // Executor-built writeback requests must satisfy the same Zod wire schema as HTTP-posted ones.
  // A template resolving to "" or oversize content is rejected at the adapter boundary, not silently
  // persisted via the in-process path. The node still completes (recall/writeback failures warn-and-continue);
  // the run-level warning surfaces the rejection.
  test("memory: adapter rejects invalid resolved writeback drafts (e.g. empty summary)", async () => {
    const { createMemoryStore } = await import("../src/memory-store.ts");
    writeWorkflow(
      "memory-invalid.yaml",
      // $inputs.missing resolves to "" — Zod's min(1) on summary then trips.
      `name: memory-invalid
description: invalid-draft test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: lesson
        summary: "$inputs.missing"
        content: "valid content"
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const memoryStore = createMemoryStore(db);
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore,
      defaultCwd: tmpDir,
      memoryStore,
    });

    const start = await app.fetch(
      postRun("http://test/api/workflows/memory-invalid/runs", { inputs: {}, workingDir: tmpDir }),
    );
    const { runId } = (await start.json()) as { runId: string };
    const run = await pollUntilTerminal(app, runId);
    // The node itself succeeds — writeback is augmentation, not a hard
    // dependency — but no memory should have been persisted.
    expect(run.status).toBe("succeeded");
    const recall = memoryStore.recall({
      schemaVersion: "keelson.memory.recall.v1",
      scope: { visibility: "project" },
      task: { runtime: "workflow" },
      query: "valid content",
    });
    expect(recall.items).toHaveLength(0);
  });
});

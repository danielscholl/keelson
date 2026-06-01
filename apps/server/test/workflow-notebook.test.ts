// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRegisteredProvider,
  type ProviderCapabilities,
  type ProviderRegistration,
  registerProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import { Hono } from "hono";
import { bootstrapPromptHandler, bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectNotebookStore } from "../src/project-notebook-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { createActiveRuns, workflowsRoutes } from "../src/workflows-handler.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

let tmpDir: string;
let wfDir: string;
let spyCounter = 0;
let savedWorkflowProvider: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-wf-notebook-"));
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  savedWorkflowProvider = process.env.KEELSON_WORKFLOW_PROVIDER;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedWorkflowProvider === undefined) delete process.env.KEELSON_WORKFLOW_PROVIDER;
  else process.env.KEELSON_WORKFLOW_PROVIDER = savedWorkflowProvider;
});

// Spy provider — captures the SendQueryOptions the prompt node forwarded, yields nothing.
function registerSpy(capture: (opts: SendQueryOptions | undefined) => void): string {
  const id = `spy-wf-notebook-${spyCounter++}`;
  const capabilities: ProviderCapabilities = {
    sessionResume: false,
    streaming: true,
    tools: false,
    models: ["spy-model"],
    defaultModel: "spy-model",
  };
  const reg: ProviderRegistration = {
    id,
    displayName: `Spy (${id})`,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "spy",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "spy-model" }],
      // biome-ignore lint/correctness/useYield: spy generator captures and exits
      async *sendQuery(_prompt, _cwd, _resume, options) {
        capture(options);
      },
    }),
  };
  registerProvider(reg);
  return id;
}

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function postRun(name: string, projectId: string): Request {
  return new Request(`http://test/api/workflows/${name}/runs`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ inputs: {}, projectId }),
  });
}

async function pollUntilTerminal(app: Hono, runId: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { status: string } };
    if (TERMINAL.has(body.run.status)) return body.run.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
}

function setup() {
  const db = openDatabase({ path: ":memory:" });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const projectNotebookStore = createProjectNotebookStore(db);
  const project = projectsStore.create({ name: "p", rootPath: tmpDir });
  return { db, store, conversationStore, projectsStore, projectNotebookStore, project };
}

describe("workflow prompt-node notebook injection (read)", () => {
  test("a prompt node receives the project notebook, with ## Archive held back", async () => {
    const { store, conversationStore, projectsStore, projectNotebookStore, project } = setup();
    projectNotebookStore.upsert(
      project.id,
      "## Log\n- 2026-06-01: recent thing\n\n## Archive\n- 2026-01-01: ancient thing\n",
    );

    let captured: SendQueryOptions | undefined;
    const spyId = registerSpy((o) => {
      captured = o;
    });
    expect(isRegisteredProvider(spyId)).toBe(true);
    process.env.KEELSON_WORKFLOW_PROVIDER = spyId;

    writeWorkflow(
      "nb-read.yaml",
      `name: nb-read
description: read test
nodes:
  - id: think
    prompt: hello
`,
    );
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const promptHandler = bootstrapPromptHandler();
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, projectNotebookStore, promptHandler },
      createActiveRuns(),
    );

    const startRes = await app.fetch(postRun("nb-read", project.id));
    const { runId } = (await startRes.json()) as { runId: string };
    await pollUntilTerminal(app, runId);

    const sp = captured?.systemPrompt ?? "";
    expect(sp).toContain("## Project notebook");
    expect(sp).toContain("recent thing");
    expect(sp).not.toContain("ancient thing");
    expect(sp).not.toContain("## Archive");
  });

  test("a display-only projectId (workingDir outside the project) neither reads nor writes the notebook", async () => {
    const { store, conversationStore, projectsStore, projectNotebookStore, project } = setup();
    projectNotebookStore.upsert(project.id, "## Gotchas\n- secret project note\n");

    let captured: SendQueryOptions | undefined;
    const spyId = registerSpy((o) => {
      captured = o;
    });
    process.env.KEELSON_WORKFLOW_PROVIDER = spyId;

    // A directory the run actually executes in, OUTSIDE the project's root.
    const outsideDir = mkdtempSync(join(tmpdir(), "keelson-wf-outside-"));
    try {
      writeWorkflow(
        "nb-leak.yaml",
        `name: nb-leak
description: display-only projectId
nodes:
  - id: think
    prompt: hello
    notebook:
      append: leaked note
`,
      );
      const catalog = bootstrapWorkflows({ workflowDir: wfDir });
      const promptHandler = bootstrapPromptHandler();
      const app = new Hono();
      workflowsRoutes(
        app,
        { catalog, store, conversationStore, projectsStore, projectNotebookStore, promptHandler },
        createActiveRuns(),
      );

      // projectId is preserved for display, but workingDir wins as the run target.
      const startRes = await app.fetch(
        new Request("http://test/api/workflows/nb-leak/runs", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ inputs: {}, projectId: project.id, workingDir: outsideDir }),
        }),
      );
      const { runId } = (await startRes.json()) as { runId: string };
      await pollUntilTerminal(app, runId);

      // Read: the project notebook must not have been injected as context.
      expect(captured?.systemPrompt ?? "").not.toContain("secret project note");
      // Contribute: the project notebook must be untouched.
      const content = projectNotebookStore.get(project.id)?.content ?? "";
      expect(content).not.toContain("leaked note");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("workflow notebook: block (contribute)", () => {
  test("a node with notebook.append writes to the project notebook on success", async () => {
    const { store, conversationStore, projectsStore, projectNotebookStore, project } = setup();

    writeWorkflow(
      "nb-write.yaml",
      `name: nb-write
description: contribute test
nodes:
  - id: build
    bash: echo done
    notebook:
      append: "ran: $build.output"
      section: Workflow Log
`,
    );
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, projectNotebookStore },
      createActiveRuns(),
    );

    const startRes = await app.fetch(postRun("nb-write", project.id));
    const { runId } = (await startRes.json()) as { runId: string };
    const status = await pollUntilTerminal(app, runId);
    expect(status).toBe("succeeded");

    const content = projectNotebookStore.get(project.id)?.content ?? "";
    expect(content).toContain("## Workflow Log");
    expect(content).toContain("ran:");
    expect(content).toContain("done");
  });

  test("on: success does not write when the node fails", async () => {
    const { store, conversationStore, projectsStore, projectNotebookStore, project } = setup();

    writeWorkflow(
      "nb-fail.yaml",
      `name: nb-fail
description: contribute skip test
nodes:
  - id: build
    bash: exit 1
    notebook:
      append: should not write
`,
    );
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, projectNotebookStore },
      createActiveRuns(),
    );

    const startRes = await app.fetch(postRun("nb-fail", project.id));
    const { runId } = (await startRes.json()) as { runId: string };
    const status = await pollUntilTerminal(app, runId);
    expect(status).toBe("failed");

    const content = projectNotebookStore.get(project.id)?.content ?? "";
    expect(content).not.toContain("should not write");
  });
});

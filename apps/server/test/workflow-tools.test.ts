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
import type { MessageChunk, ToolContext, ToolDefinition } from "@keelson/shared";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { createWorkflowChatTools } from "../src/workflow-tools.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  type WorkflowController,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let wfDir: string;
let activeDispose: (() => void) | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-workflow-tools-"));
  dbPath = join(tmpDir, "test.db");
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
});

afterEach(() => {
  activeDispose?.();
  activeDispose = undefined;
  rmTemp(tmpDir);
});

interface Rig {
  controller: WorkflowController;
  tools: ToolDefinition[];
  cwd: string;
  dispose: () => void;
}

function makeRig(): Rig {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  projectsStore.create({ name: "test-project", rootPath: tmpDir });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const activeRuns = createActiveRuns();
  const subscribers = createWorkflowSubscribers();
  const controller = createWorkflowController(
    { catalog, store, conversationStore, projectsStore },
    activeRuns,
    subscribers,
  );
  // Short watch deadline keeps the "still running" fallback from hanging a test,
  // while bash + approval fixtures reach their boundary well inside it.
  const tools = createWorkflowChatTools({ controller, catalog, watchDeadlineMs: 4000 });
  return { controller, tools, cwd: tmpDir, dispose: () => db.close() };
}

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not registered`);
  return tool;
}

function makeCtx(cwd: string): { ctx: ToolContext; chunks: MessageChunk[] } {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd,
    emit: (chunk) => chunks.push(chunk),
    abortSignal: new AbortController().signal,
  };
  return { ctx, chunks };
}

function lastToolResult(chunks: MessageChunk[]): { content: string; isError: boolean } {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk && chunk.type === "tool_result") {
      return { content: chunk.content, isError: chunk.isError ?? false };
    }
  }
  throw new Error("no tool_result chunk was emitted");
}

const PAUSE_REFS_RE = /runId="([^"]+)", nodeId="([^"]+)", pauseId="([^"]+)"/;

function extractPauseRefs(content: string): { runId: string; nodeId: string; pauseId: string } {
  const m = PAUSE_REFS_RE.exec(content);
  if (!m) throw new Error(`paused tool_result did not carry run refs:\n${content}`);
  return { runId: m[1]!, nodeId: m[2]!, pauseId: m[3]! };
}

const NO_APPROVAL_WF = `name: done
description: |
  Use when: a fast deterministic check is needed
nodes:
  - id: ok
    bash: echo run-sentinel-123
`;

const APPROVAL_WF = `name: pa
description: |
  Use when: a human must approve before continuing
nodes:
  - id: review
    approval:
      message: please approve
`;

describe("workflow chat tools", () => {
  test("workflow_list filters by query and lists all when empty", async () => {
    writeWorkflow(
      "alpha.yaml",
      `name: alpha
description: |
  Use when: fixing a thing
  Triggers: fix
nodes:
  - id: ok
    bash: echo ok
`,
    );
    writeWorkflow(
      "beta.yaml",
      `name: beta
description: |
  Use when: reviewing a thing
nodes:
  - id: ok
    bash: echo ok
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const list = toolByName(tools, "workflow_list");

    const filtered = makeCtx(cwd);
    await list.execute({ query: "review" }, filtered.ctx);
    const filteredResult = lastToolResult(filtered.chunks);
    expect(filteredResult.isError).toBe(false);
    expect(filteredResult.content).toContain("beta");
    expect(filteredResult.content).not.toContain("alpha");

    const all = makeCtx(cwd);
    await list.execute({}, all.ctx);
    const allResult = lastToolResult(all.chunks);
    expect(allResult.content).toContain("alpha");
    expect(allResult.content).toContain("beta");
  });

  test("workflow_run resolves a misspelled / unnormalized name", async () => {
    writeWorkflow(
      "smoke-test.yaml",
      `name: smoke-test
description: |
  Use when: verifying the engine
nodes:
  - id: ok
    bash: echo resolved-sentinel-456
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "smoketest", arguments: "" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed successfully");
    expect(result.content).toContain("resolved-sentinel-456");
  });

  test("workflow_run reports available names when nothing matches", async () => {
    writeWorkflow(
      "alpha.yaml",
      `name: alpha
description: |
  Use when: a thing
nodes:
  - id: ok
    bash: echo ok
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "nonesuch", arguments: "" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("workflow_list");
  });

  test("workflow_run completes a no-approval workflow", async () => {
    writeWorkflow("done.yaml", NO_APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "done", arguments: "" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed successfully");
    expect(result.content).toContain("run-sentinel-123");
    // It streamed a kickoff progress line before the final result.
    expect(chunks.some((c) => c.type === "text" && c.content.includes("Started workflow"))).toBe(
      true,
    );
  });

  test("workflow_run with an unknown name returns an error result", async () => {
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "nope" }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No workflow matches "nope"');
    expect(result.content).toContain("No workflows are available");
  });

  test("workflow_run pauses on approval, carries ids, and workflow_respond resumes", async () => {
    writeWorkflow("pa.yaml", APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const respond = toolByName(tools, "workflow_respond");

    const runCtx = makeCtx(cwd);
    await run.execute({ name: "pa" }, runCtx.ctx);
    const paused = lastToolResult(runCtx.chunks);
    expect(paused.isError).toBe(false);
    expect(paused.content).toContain("PAUSED");
    expect(paused.content).toContain("please approve");
    const refs = extractPauseRefs(paused.content);
    expect(refs.nodeId).toBe("review");

    const respondCtx = makeCtx(cwd);
    await respond.execute(
      { runId: refs.runId, nodeId: refs.nodeId, text: "approve", pauseId: refs.pauseId },
      respondCtx.ctx,
    );
    const resumed = lastToolResult(respondCtx.chunks);
    expect(resumed.isError).toBe(false);
    expect(resumed.content).toContain("completed successfully");
  });

  test("workflow_respond rejects a stale pauseId", async () => {
    writeWorkflow("pa.yaml", APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const respond = toolByName(tools, "workflow_respond");

    const runCtx = makeCtx(cwd);
    await run.execute({ name: "pa" }, runCtx.ctx);
    const refs = extractPauseRefs(lastToolResult(runCtx.chunks).content);

    const staleCtx = makeCtx(cwd);
    await respond.execute(
      {
        runId: refs.runId,
        nodeId: refs.nodeId,
        text: "approve",
        pauseId: `${refs.pauseId}-stale`,
      },
      staleCtx.ctx,
    );
    const stale = lastToolResult(staleCtx.chunks);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("pauseId mismatch");

    // The real pauseId still resolves — confirms the stale attempt was rejected,
    // not consumed — and drains the run so it doesn't leak as paused.
    const okCtx = makeCtx(cwd);
    await respond.execute(
      { runId: refs.runId, nodeId: refs.nodeId, text: "approve", pauseId: refs.pauseId },
      okCtx.ctx,
    );
    expect(lastToolResult(okCtx.chunks).isError).toBe(false);
  });

  test("workflow_status lists active runs and returns per-run detail", async () => {
    writeWorkflow("pa.yaml", APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const respond = toolByName(tools, "workflow_respond");
    const status = toolByName(tools, "workflow_status");

    const runCtx = makeCtx(cwd);
    await run.execute({ name: "pa" }, runCtx.ctx);
    const refs = extractPauseRefs(lastToolResult(runCtx.chunks).content);

    const listCtx = makeCtx(cwd);
    await status.execute({}, listCtx.ctx);
    const listed = lastToolResult(listCtx.chunks);
    expect(listed.content).toContain(refs.runId);
    expect(listed.content).toContain("paused");

    const detailCtx = makeCtx(cwd);
    await status.execute({ runId: refs.runId }, detailCtx.ctx);
    const detail = lastToolResult(detailCtx.chunks);
    expect(detail.content).toContain("pa");
    expect(detail.content).toContain('Awaiting approval at node "review"');
    // Status surfaces the live pauseId so a status-polled approval can resume
    // with the same protocol as workflow_run (regression for the in-memory token).
    expect(detail.content).toContain(`pauseId="${refs.pauseId}"`);

    // Drain.
    const okCtx = makeCtx(cwd);
    await respond.execute(
      { runId: refs.runId, nodeId: refs.nodeId, text: "approve", pauseId: refs.pauseId },
      okCtx.ctx,
    );
    expect(lastToolResult(okCtx.chunks).isError).toBe(false);
  });

  test("workflow_respond enforces the 16 KiB reply cap like POST /resume", async () => {
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const respond = toolByName(tools, "workflow_respond");
    const { ctx, chunks } = makeCtx(cwd);
    // Oversized text is rejected at the schema boundary, before resolveApproval —
    // so no live run is needed to exercise the cap.
    await respond.execute({ runId: "any", nodeId: "review", text: "x".repeat(16_385) }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid input");
  });
});

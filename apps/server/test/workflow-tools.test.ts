// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
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

interface RigExtras {
  projectsStore: ReturnType<typeof createProjectsStore>;
}

function makeRig(): Rig & RigExtras {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  projectsStore.create({ name: "test-project", rootPath: tmpDir });
  const catalog = bootstrapWorkflows({
    workflowDir: wfDir,
    listProjects: () => projectsStore.list(),
  });
  const activeRuns = createActiveRuns();
  const subscribers = createWorkflowSubscribers();
  const controller = createWorkflowController(
    { catalog, store, conversationStore, projectsStore },
    activeRuns,
    subscribers,
  );
  // Short watch deadline keeps the "still running" fallback from hanging a test,
  // while bash + approval fixtures reach their boundary well inside it.
  const tools = createWorkflowChatTools({
    controller,
    catalog,
    projectsStore,
    watchDeadlineMs: 4000,
  });
  return { controller, tools, cwd: tmpDir, projectsStore, dispose: () => db.close() };
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

const STARTED_RUN_RE = /\(run ([0-9a-f-]+)\)/;

// Pull the runId from the "Started workflow … (run <id>)." progress line
// workflow_run streams before its final tool_result.
function extractRunId(chunks: MessageChunk[]): string {
  for (const chunk of chunks) {
    if (chunk.type === "text") {
      const m = STARTED_RUN_RE.exec(chunk.content);
      if (m) return m[1]!;
    }
  }
  throw new Error("no 'Started workflow (run …)' line was emitted");
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

const FAIL_WF = `name: boom
description: |
  Use when: exercising a failing gate
nodes:
  - id: boom
    bash: exit 1
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

  test("workflow_run passes declared inputs through to the run", async () => {
    // The gap this closes: a workflow with named parameters was CLI-only, because
    // the tool schema took no `inputs` — never because the run couldn't carry them.
    writeWorkflow(
      "lens-refresh.yaml",
      `name: lens-refresh
description: |
  Use when: re-composing a lens
inputs:
  lens:
    description: the lens id
    required: true
  service:
    description: the service
nodes:
  - id: ok
    bash: echo "lens=$KEELSON_INPUTS_lens service=$KEELSON_INPUTS_service"
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute(
      { name: "lens-refresh", inputs: { lens: "release-status", service: "search" } },
      ctx,
    );

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("lens=release-status service=search");
  });

  test("workflow_run refuses ARGUMENTS named twice rather than picking a winner", async () => {
    // The CLI's rule, so one contract holds across surfaces: either guess would
    // silently discard half of what the caller wrote.
    writeWorkflow(
      "echo-args.yaml",
      `name: echo-args
description: |
  Use when: echoing
nodes:
  - id: ok
    bash: echo "args=$KEELSON_ARGUMENTS"
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute(
      { name: "echo-args", arguments: "from-arguments", inputs: { ARGUMENTS: "from-inputs" } },
      ctx,
    );

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("conflicting ARGUMENTS");
    // Refused before starting: neither value silently won.
    expect(result.content).not.toContain("completed successfully");
  });

  test("workflow_run accepts ARGUMENTS through either spelling, and defaults it to empty", async () => {
    writeWorkflow(
      "echo-args.yaml",
      `name: echo-args
description: |
  Use when: echoing
nodes:
  - id: ok
    bash: echo "args=[$KEELSON_ARGUMENTS]"
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const viaInputs = makeCtx(cwd);
    await run.execute({ name: "echo-args", inputs: { ARGUMENTS: "via-inputs" } }, viaInputs.ctx);
    expect(lastToolResult(viaInputs.chunks).content).toContain("args=[via-inputs]");

    const viaArguments = makeCtx(cwd);
    await run.execute({ name: "echo-args", arguments: "via-arguments" }, viaArguments.ctx);
    expect(lastToolResult(viaArguments.chunks).content).toContain("args=[via-arguments]");

    // Neither named: ARGUMENTS stays present-and-empty, as every caller before
    // this change relied on.
    const neither = makeCtx(cwd);
    await run.execute({ name: "echo-args" }, neither.ctx);
    expect(lastToolResult(neither.chunks).content).toContain("args=[]");
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

  test("workflow_resume is registered and marked state_changing", () => {
    const { tools, dispose } = makeRig();
    activeDispose = dispose;
    const resume = toolByName(tools, "workflow_resume");
    // Must ride the same MCP read-only gate as workflow_run / workflow_respond.
    expect(resume.state_changing).toBe(true);
  });

  test("workflow_resume errors on an unknown run", async () => {
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const resume = toolByName(tools, "workflow_resume");

    const { ctx, chunks } = makeCtx(cwd);
    await resume.execute({ runId: "does-not-exist" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does-not-exist");
  });

  test("workflow_resume refuses a run that already succeeded", async () => {
    writeWorkflow("done.yaml", NO_APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const resume = toolByName(tools, "workflow_resume");

    const started = makeCtx(cwd);
    await run.execute({ name: "done", arguments: "" }, started.ctx);
    const runId = extractRunId(started.chunks);

    const { ctx, chunks } = makeCtx(cwd);
    await resume.execute({ runId }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("resumable");
  });

  test("workflow_resume re-enters a failed run from its last completed node", async () => {
    writeWorkflow("boom.yaml", FAIL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");
    const resume = toolByName(tools, "workflow_resume");

    const started = makeCtx(cwd);
    await run.execute({ name: "boom", arguments: "" }, started.ctx);
    const runId = extractRunId(started.chunks);
    expect(lastToolResult(started.chunks).isError).toBe(true);

    const { ctx, chunks } = makeCtx(cwd);
    await resume.execute({ runId }, ctx);
    const result = lastToolResult(chunks);
    // The resume was accepted (not a "Could not resume" rejection) — it
    // re-entered and reached terminal, re-failing the same gate.
    expect(result.content).not.toContain("Could not resume");
    expect(result.content).toContain(runId);
    expect(result.content).toContain("failed");
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

  test("workflow_run appends a repo-missing hint on git failures", async () => {
    writeWorkflow(
      "git-check.yaml",
      `name: git-check
description: |
  Use when: verifying repository state
nodes:
  - id: check
    bash: git rev-parse --is-inside-work-tree
`,
    );
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "git-check" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`cwd "${cwd}"`);
    expect(result.content).toContain(
      'workflow_run with project="<registered project id or exact name>"',
    );
  });

  const REPO_SCOPED_WF = `name: repo-scoped
requiresProject: true
description: |
  Use when: a repo is required
nodes:
  - id: ok
    bash: echo ok
`;

  function noRunsCreated(controller: WorkflowController): boolean {
    const statuses = ["running", "paused", "succeeded", "failed", "cancelled"] as const;
    return statuses.every((status) => controller.listRuns({ status }).length === 0);
  }

  test("workflow_run rejects a requiresProject workflow in a non-git cwd and suggests a git-backed project", async () => {
    writeWorkflow("repo-scoped.yaml", REPO_SCOPED_WF);
    const { controller, tools, cwd, projectsStore, dispose } = makeRig();
    activeDispose = dispose;
    // makeRig registers "test-project" rooted at the non-git tmp cwd; add a
    // project that IS a git repo so there is a candidate the retry can pass on.
    const gitRoot = join(cwd, "git-project-root");
    mkdirSync(gitRoot, { recursive: true });
    execSync("git init -q", { cwd: gitRoot });
    projectsStore.create({ name: "git-project", rootPath: gitRoot });
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "repo-scoped" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("repo-scoped requires a git repository");
    expect(result.content).toContain(cwd);
    // Only the git-backed project is a valid retry target; the non-git
    // "test-project" (rooted at the failing cwd) must not be suggested back.
    expect(result.content).toContain('Retry with project: "git-project"');
    expect(result.content).not.toContain('Retry with project: "test-project"');
    expect(noRunsCreated(controller)).toBe(true);
  });

  test("workflow_run rejects a requiresProject workflow when the selected project's root is non-git", async () => {
    writeWorkflow("repo-scoped.yaml", REPO_SCOPED_WF);
    const { controller, tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "repo-scoped", project: "test-project" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("repo-scoped requires a git repository");
    expect(result.content).toContain("selected project's root");
    // The project the caller named just failed the repo check — don't suggest
    // it back, and don't claim no projects are registered when one is.
    expect(result.content).not.toContain('Retry with project: "test-project"');
    expect(result.content).toContain("No registered project is a git repository");
    expect(result.content).not.toContain("No projects are registered");
    expect(noRunsCreated(controller)).toBe(true);
  });

  test("workflow_run starts a requiresProject workflow when the working dir is a git repo", async () => {
    writeWorkflow("repo-scoped.yaml", REPO_SCOPED_WF);
    const { controller, tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    execSync("git init -q", { cwd });
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "repo-scoped" }, ctx);

    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed successfully");
    const runId = extractRunId(chunks);
    expect(runId.length).toBeGreaterThan(0);
    expect(noRunsCreated(controller)).toBe(false);
  });

  test("workflow_run notes the resolved working dir when project is omitted", async () => {
    writeWorkflow("done.yaml", NO_APPROVAL_WF);
    const { tools, cwd, dispose } = makeRig();
    activeDispose = dispose;
    const run = toolByName(tools, "workflow_run");

    const { ctx, chunks } = makeCtx(cwd);
    await run.execute({ name: "done" }, ctx);

    const startedLine = chunks.find(
      (c) => c.type === "text" && c.content.includes("Started workflow"),
    );
    expect(startedLine && startedLine.type === "text" ? startedLine.content : "").toContain(
      `in "${cwd}"`,
    );
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

describe("project-scoped workflow chat tools", () => {
  const PROJECT_WF = `name: proj-flow
description: |
  Use when: only this project needs it
nodes:
  - id: step
    bash: echo project-sentinel-456
`;

  function makeScopedRig() {
    const rig = makeRig();
    activeDispose = rig.dispose;
    const projectRoot = join(tmpDir, "proj-root");
    mkdirSync(join(projectRoot, ".keelson", "workflows"), { recursive: true });
    writeFileSync(join(projectRoot, ".keelson", "workflows", "proj-flow.yaml"), PROJECT_WF);
    rig.projectsStore.create({ name: "scoped", rootPath: projectRoot });
    return { ...rig, projectRoot };
  }

  test("workflow_list sees project workflows only from inside that project", async () => {
    const rig = makeScopedRig();
    writeWorkflow("global.yaml", NO_APPROVAL_WF);

    const inProject = makeCtx(rig.projectRoot);
    await toolByName(rig.tools, "workflow_list").execute({}, inProject.ctx);
    const scoped = lastToolResult(inProject.chunks);
    expect(scoped.content).toContain("proj-flow");
    expect(scoped.content).toContain("done");

    const outside = makeCtx(rig.cwd);
    await toolByName(rig.tools, "workflow_list").execute({}, outside.ctx);
    expect(lastToolResult(outside.chunks).content).not.toContain("proj-flow");
  });

  test("workflow_run resolves and runs a project workflow from its project cwd", async () => {
    const rig = makeScopedRig();

    const inProject = makeCtx(rig.projectRoot);
    await toolByName(rig.tools, "workflow_run").execute({ name: "proj-flow" }, inProject.ctx);
    const result = lastToolResult(inProject.chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed successfully");
    expect(result.content).toContain("project-sentinel-456");
  });

  test("workflow_run cannot start a project workflow from outside its project", async () => {
    const rig = makeScopedRig();
    writeWorkflow("global.yaml", NO_APPROVAL_WF);

    const outside = makeCtx(rig.cwd);
    await toolByName(rig.tools, "workflow_run").execute({ name: "proj-flow" }, outside.ctx);
    const result = lastToolResult(outside.chunks);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("project-sentinel-456");
  });

  test("workflow_run can target a project from a non-repo cwd", async () => {
    const rig = makeScopedRig();
    const outsideCwd = join(tmpDir, "outside");
    mkdirSync(outsideCwd, { recursive: true });

    const outside = makeCtx(outsideCwd);
    await toolByName(rig.tools, "workflow_run").execute(
      { name: "proj-flow", project: "scoped" },
      outside.ctx,
    );
    const result = lastToolResult(outside.chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed successfully");
    expect(result.content).toContain("project-sentinel-456");
  });

  test("workflow_run rejects an unknown project selector", async () => {
    const rig = makeScopedRig();
    const outsideCwd = join(tmpDir, "outside");
    mkdirSync(outsideCwd, { recursive: true });

    const outside = makeCtx(outsideCwd);
    await toolByName(rig.tools, "workflow_run").execute(
      { name: "proj-flow", project: "missing" },
      outside.ctx,
    );
    const result = lastToolResult(outside.chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown project");
  });

  test("controller honors explicit project selection over workingDir inference", async () => {
    const rig = makeScopedRig();
    const parentRoot = rig.projectRoot;
    const childRoot = join(parentRoot, "child");
    mkdirSync(join(childRoot, ".keelson", "workflows"), { recursive: true });
    writeFileSync(
      join(parentRoot, ".keelson", "workflows", "dupe.yaml"),
      `name: dupe\ndescription: parent version\nnodes:\n  - id: parent-step\n    bash: echo parent\n`,
    );
    writeFileSync(
      join(childRoot, ".keelson", "workflows", "dupe.yaml"),
      `name: dupe\ndescription: child version\nnodes:\n  - id: child-step\n    bash: echo child\n`,
    );
    const parent = rig.projectsStore.getByName("scoped");
    if (!parent) throw new Error("missing parent project");
    const child = rig.projectsStore.create({ name: "nested", rootPath: childRoot });

    const started = rig.controller.startRun({
      name: "dupe",
      inputs: {},
      workingDir: childRoot,
      project: { id: parent.id, rootPath: parent.rootPath },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("run did not start");
    const detail = await waitForRun(rig.controller, started.runId);
    expect(detail.nodes[0]!.nodeId).toBe("parent-step");
    expect(detail.projectId).toBe(parent.id);
    expect(detail.projectId).not.toBe(child.id);
  });
});

describe("scheduled-run scope (review fix)", () => {
  test("origin 'scheduled' resolves the global definition even from a project cwd", async () => {
    const rig = makeRig();
    activeDispose = rig.dispose;
    const projectRoot = join(tmpDir, "sched-root");
    mkdirSync(join(projectRoot, ".keelson", "workflows"), { recursive: true });
    writeWorkflow(
      "producer.yaml",
      `name: producer\ndescription: global producer\nnodes:\n  - id: global-step\n    bash: echo from-global\n`,
    );
    writeFileSync(
      join(projectRoot, ".keelson", "workflows", "producer.yaml"),
      `name: producer\ndescription: project shadow\nnodes:\n  - id: shadow-step\n    bash: echo from-shadow\n`,
    );
    rig.projectsStore.create({ name: "sched", rootPath: projectRoot });

    const manual = rig.controller.startRun({
      name: "producer",
      inputs: {},
      workingDir: projectRoot,
    });
    expect(manual.ok).toBe(true);

    const scheduled = rig.controller.startRun({
      name: "producer",
      inputs: {},
      workingDir: projectRoot,
      origin: "scheduled",
    });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok || !manual.ok) throw new Error("runs did not start");

    const detail = await waitForRun(rig.controller, scheduled.runId);
    expect(detail.nodes[0]!.nodeId).toBe("global-step");
    const manualDetail = await waitForRun(rig.controller, manual.runId);
    expect(manualDetail.nodes[0]!.nodeId).toBe("shadow-step");
  });
});

async function waitForRun(controller: WorkflowController, runId: string) {
  for (let i = 0; i < 100; i++) {
    const detail = controller.getRun(runId);
    if (detail && (detail.status === "succeeded" || detail.status === "failed")) return detail;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

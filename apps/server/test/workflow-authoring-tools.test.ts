// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, ToolContext, ToolDefinition } from "@keelson/shared";
import type { WorkflowDefinition } from "@keelson/workflows";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createWorkflowAuthoringTools } from "../src/workflow-authoring-tools.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let wfDir: string;
let projectRoot: string;
let projectWfDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-authoring-tools-"));
  wfDir = join(tmpDir, "workflows");
  projectRoot = join(tmpDir, "proj-root");
  projectWfDir = join(projectRoot, ".keelson", "workflows");
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(projectWfDir, { recursive: true });
});

afterEach(() => {
  rmTemp(tmpDir);
});

const PROJECT = { id: "p1", name: "demo", rootPath: "" };

const RIB_WORKFLOW: WorkflowDefinition = {
  name: "rib-flow",
  description: "from a rib",
  nodes: [{ id: "step", bash: "echo rib" }],
} as WorkflowDefinition;

function makeTools(opts: { project?: boolean } = {}): ToolDefinition[] {
  const catalog = bootstrapWorkflows({
    workflowDir: wfDir,
    listProjects: () => [{ ...PROJECT, rootPath: projectRoot }],
    extra: [RIB_WORKFLOW],
  });
  return createWorkflowAuthoringTools({
    catalog,
    globalWorkflowsDir: wfDir,
    project: opts.project === false ? null : { ...PROJECT, rootPath: projectRoot },
  });
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
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

function lastToolResult(chunks: MessageChunk[]): { content: string; isError: boolean } {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk && chunk.type === "tool_result") {
      return { content: chunk.content, isError: chunk.isError ?? false };
    }
  }
  throw new Error("no tool_result chunk was emitted");
}

const VALID_WF = (name: string, marker = "ok") => `name: ${name}
description: |
  Use when: testing the authoring tools
nodes:
  - id: step
    bash: echo ${marker}
`;

describe("workflow_schema", () => {
  test("returns the full guide and per-topic sections", async () => {
    const tools = makeTools();
    const schema = toolByName(tools, "workflow_schema");

    const full = makeCtx();
    await schema.execute({}, full.ctx);
    expect(lastToolResult(full.chunks).content).toContain("# Keelson Workflow Authoring Guide");

    const topic = makeCtx();
    await schema.execute({ topic: "node-types" }, topic.ctx);
    const section = lastToolResult(topic.chunks).content;
    expect(section.startsWith("## Node types")).toBe(true);
    expect(section).not.toContain("# Keelson Workflow Authoring Guide");

    const miss = makeCtx();
    await schema.execute({ topic: "nope" }, miss.ctx);
    const fallback = lastToolResult(miss.chunks).content;
    expect(fallback).toContain("valid topics:");
    expect(fallback).toContain("# Keelson Workflow Authoring Guide");
  });

  test("read-only metadata: only workflow_save is state-changing", () => {
    const tools = makeTools();
    for (const name of ["workflow_schema", "workflow_get", "workflow_validate"]) {
      const tool = toolByName(tools, name);
      expect(tool.state_changing ?? false).toBe(false);
      expect(tool.requires_confirmation ?? false).toBe(false);
    }
    const save = toolByName(tools, "workflow_save");
    expect(save.state_changing).toBe(true);
    expect(save.requires_confirmation).toBe(true);
  });
});

describe("workflow_get", () => {
  test("returns raw YAML with scope and path; project copy wins", async () => {
    writeFileSync(join(wfDir, "shared.yaml"), VALID_WF("shared", "global-copy"));
    writeFileSync(join(projectWfDir, "shared.yaml"), VALID_WF("shared", "project-copy"));
    const tools = makeTools();

    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_get").execute({ name: "shared" }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("scope: project");
    expect(result.content).toContain(join(projectWfDir, "shared.yaml"));
    expect(result.content).toContain("echo project-copy");
  });

  test("suggests close names and lists available on a miss", async () => {
    writeFileSync(join(wfDir, "smoke-test.yaml"), VALID_WF("smoke-test"));
    const tools = makeTools();

    const close = makeCtx();
    await toolByName(tools, "workflow_get").execute({ name: "smoke-tst" }, close.ctx);
    const suggestion = lastToolResult(close.chunks);
    expect(suggestion.isError).toBe(true);
    expect(suggestion.content).toContain("smoke-test");

    const miss = makeCtx();
    await toolByName(tools, "workflow_get").execute({ name: "zzz" }, miss.ctx);
    const missResult = lastToolResult(miss.chunks);
    expect(missResult.isError).toBe(true);
    expect(missResult.content).toContain("smoke-test");
  });

  test("rib-contributed workflows have no file to fetch", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_get").execute({ name: "rib-flow" }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("contributed by a rib");
  });
});

describe("workflow_validate", () => {
  test("VALID result lists name, nodes, and the next step", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_validate").execute({ yaml: VALID_WF("draft") }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('VALID — workflow "draft"');
    expect(result.content).toContain("step");
    expect(result.content).toContain("workflow_save");
  });

  test("YAML syntax errors carry line info; node errors carry node ids", async () => {
    const tools = makeTools();

    const syntax = makeCtx();
    await toolByName(tools, "workflow_validate").execute(
      { yaml: "name: x\ndescription: y\nnodes:\n  - id: a\n   bash: echo hi\n" },
      syntax.ctx,
    );
    const syntaxResult = lastToolResult(syntax.chunks);
    expect(syntaxResult.isError).toBe(true);
    expect(syntaxResult.content).toContain("INVALID");

    const node = makeCtx();
    await toolByName(tools, "workflow_validate").execute(
      {
        yaml: `name: x
description: y
nodes:
  - id: a
    bash: echo hi
  - id: b
    prompt: do it
    depends_on: [missing-node]
`,
      },
      node.ctx,
    );
    const nodeResult = lastToolResult(node.chunks);
    expect(nodeResult.isError).toBe(true);
    expect(nodeResult.content).toContain("missing-node");
  });

  test("warning-only YAML is VALID with the warnings listed, and writes nothing", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_validate").execute(
      {
        yaml: `name: warned
description: y
sandbox:
  enabled: true
nodes:
  - id: a
    bash: echo hi
`,
      },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("VALID");
    expect(result.content).toContain("ignored_capability");
    expect(readdirSync(wfDir)).toEqual([]);
    expect(readdirSync(projectWfDir)).toEqual([]);
  });
});

describe("workflow_save", () => {
  test("saves to the global scope and the catalog sees it immediately", async () => {
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [{ ...PROJECT, rootPath: projectRoot }],
    });
    const tools = createWorkflowAuthoringTools({
      catalog,
      globalWorkflowsDir: wfDir,
      project: { ...PROJECT, rootPath: projectRoot },
    });

    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "fresh-flow", yaml: VALID_WF("fresh-flow"), scope: "global" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(join(wfDir, "fresh-flow.yaml"));
    expect(readFileSync(join(wfDir, "fresh-flow.yaml"), "utf-8")).toBe(VALID_WF("fresh-flow"));
    expect(catalog.get("fresh-flow")?.name).toBe("fresh-flow");
  });

  test("saves to the project scope, creating .keelson/workflows on demand", async () => {
    rmTemp(projectWfDir);
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "proj-flow", yaml: VALID_WF("proj-flow"), scope: "project" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("scope: project");
    expect(existsSync(join(projectWfDir, "proj-flow.yaml"))).toBe(true);
  });

  test("scope project without a linked project is an instructive error", async () => {
    const tools = makeTools({ project: false });
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "x-flow", yaml: VALID_WF("x-flow"), scope: "project" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('scope "global"');
  });

  test("scope project with a vanished root path errors without recreating it", async () => {
    const catalog = bootstrapWorkflows({ workflowDir: wfDir, listProjects: () => [] });
    const gone = join(tmpDir, "deleted-root");
    const tools = createWorkflowAuthoringTools({
      catalog,
      globalWorkflowsDir: wfDir,
      project: { id: "p2", rootPath: gone },
    });
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "x-flow", yaml: VALID_WF("x-flow"), scope: "project" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(gone);
    expect(existsSync(gone)).toBe(false);
  });

  test("invalid YAML blocks the write entirely", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "broken", yaml: "name: broken\nnodes: nope\n", scope: "global" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Save blocked");
    expect(readdirSync(wfDir)).toEqual([]);
  });

  test("the YAML name must match the save name", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "alpha", yaml: VALID_WF("beta"), scope: "global" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('name: "beta"');
    expect(readdirSync(wfDir)).toEqual([]);
  });

  test("refuses to overwrite without the flag, rewrites the existing .yml with it", async () => {
    writeFileSync(join(wfDir, "keep.yml"), VALID_WF("keep", "v1"));
    const tools = makeTools();

    const refused = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "keep", yaml: VALID_WF("keep", "v2"), scope: "global" },
      refused.ctx,
    );
    const refusal = lastToolResult(refused.chunks);
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toContain("overwrite: true");
    expect(readFileSync(join(wfDir, "keep.yml"), "utf-8")).toContain("v1");

    const allowed = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "keep", yaml: VALID_WF("keep", "v2"), scope: "global", overwrite: true },
      allowed.ctx,
    );
    expect(lastToolResult(allowed.chunks).isError).toBe(false);
    // The .yml is rewritten in place; no .yaml twin appears.
    expect(readFileSync(join(wfDir, "keep.yml"), "utf-8")).toContain("v2");
    expect(existsSync(join(wfDir, "keep.yaml"))).toBe(false);
  });

  test("refuses when the name is owned by a different file in the same scope", async () => {
    writeFileSync(join(wfDir, "other-file.yaml"), VALID_WF("claimed"));
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "claimed", yaml: VALID_WF("claimed"), scope: "global", overwrite: true },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("other-file.yaml");
    expect(existsSync(join(wfDir, "claimed.yaml"))).toBe(false);
  });

  test("reports shadowing in both directions", async () => {
    writeFileSync(join(wfDir, "shared.yaml"), VALID_WF("shared", "global-copy"));
    const tools = makeTools();

    const projectSave = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "shared", yaml: VALID_WF("shared", "project-copy"), scope: "project" },
      projectSave.ctx,
    );
    const projectResult = lastToolResult(projectSave.chunks);
    expect(projectResult.isError).toBe(false);
    expect(projectResult.content).toContain("shadows the global");

    const globalSave = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "shared", yaml: VALID_WF("shared", "global-v2"), scope: "global", overwrite: true },
      globalSave.ctx,
    );
    const globalResult = lastToolResult(globalSave.chunks);
    expect(globalResult.isError).toBe(false);
    expect(globalResult.content).toContain("continue to shadow");
  });

  test("rejects reserved and traversal-shaped names", async () => {
    const tools = makeTools();

    const reserved = makeCtx();
    await toolByName(tools, "workflow_save").execute(
      { name: "runs", yaml: VALID_WF("runs"), scope: "global" },
      reserved.ctx,
    );
    const reservedResult = lastToolResult(reserved.chunks);
    expect(reservedResult.isError).toBe(true);
    expect(reservedResult.content).toContain("reserved");

    for (const name of ["../escape", "a/b", ".hidden", "-lead", "UPPER"]) {
      const { ctx, chunks } = makeCtx();
      await toolByName(tools, "workflow_save").execute(
        { name, yaml: VALID_WF(name), scope: "global" },
        ctx,
      );
      expect(lastToolResult(chunks).isError).toBe(true);
    }
    expect(readdirSync(wfDir)).toEqual([]);
  });

  test("leaves no temp residue when the write fails", async () => {
    const tools = makeTools();
    const { ctx, chunks } = makeCtx();
    // Make the target dir a FILE so mkdir/rename fail.
    rmTemp(projectWfDir);
    rmTemp(join(projectRoot, ".keelson"));
    mkdirSync(join(projectRoot, ".keelson"), { recursive: true });
    writeFileSync(join(projectRoot, ".keelson", "workflows"), "not a dir");

    await toolByName(tools, "workflow_save").execute(
      { name: "x-flow", yaml: VALID_WF("x-flow"), scope: "project" },
      ctx,
    );
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(readdirSync(join(projectRoot, ".keelson")).filter((f) => f.includes("savetmp"))).toEqual(
      [],
    );
  });
});

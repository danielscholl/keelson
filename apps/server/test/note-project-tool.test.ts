// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import type { MessageChunk, ToolContext } from "@keelson/shared";
import { openDatabase } from "../src/db/init.ts";
import { createNoteProjectTool } from "../src/note-project-tool.ts";
import {
  createProjectNotebookStore,
  NOTEBOOK_CONTENT_LIMIT,
} from "../src/project-notebook-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  const projects = createProjectsStore(db);
  const store = createProjectNotebookStore(db);
  const project = projects.create({ name: "p", rootPath: "/tmp/p" });
  const tool = createNoteProjectTool({ store, projectId: project.id });
  return { store, project, tool };
}

function makeCtx(): { ctx: ToolContext; chunks: MessageChunk[] } {
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: "/tmp/p",
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

describe("note_project tool", () => {
  test("is named note_project and is state-changing", () => {
    const { tool } = setup();
    expect(tool.name).toBe("note_project");
    expect(tool.state_changing).toBe(true);
  });

  test("appends a dated bullet under the default Log section", async () => {
    const { store, project, tool } = setup();
    const { ctx, chunks } = makeCtx();
    await tool.execute({ entry: "cwd defaults to ~/keelson" }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Log");
    const content = store.get(project.id)?.content ?? "";
    expect(content).toContain("## Log");
    expect(content).toContain("cwd defaults to ~/keelson");
  });

  test("routes to an explicit section", async () => {
    const { store, project, tool } = setup();
    const { ctx } = makeCtx();
    await tool.execute({ entry: "comments are terse", section: "Conventions" }, ctx);
    expect(store.get(project.id)?.content).toContain("## Conventions");
  });

  test("emits isError on empty entry and leaves the notebook untouched", async () => {
    const { store, project, tool } = setup();
    const { ctx, chunks } = makeCtx();
    await tool.execute({ entry: "" }, ctx);
    expect(lastToolResult(chunks).isError).toBe(true);
    expect(store.get(project.id)).toBeUndefined();
  });

  test("emits isError when the notebook is full", async () => {
    const { store, project, tool } = setup();
    store.upsert(project.id, "x".repeat(NOTEBOOK_CONTENT_LIMIT));
    const { ctx, chunks } = makeCtx();
    await tool.execute({ entry: "one note too many" }, ctx);
    const result = lastToolResult(chunks);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("full");
  });

  test("emitted tool_result carries the placeholder toolUseId", async () => {
    const { tool } = setup();
    const { ctx, chunks } = makeCtx();
    await tool.execute({ entry: "x" }, ctx);
    const block = chunks.find((c) => c.type === "tool_result");
    expect(block).toBeDefined();
    if (block?.type === "tool_result") expect(block.toolUseId).toBe("");
  });
});

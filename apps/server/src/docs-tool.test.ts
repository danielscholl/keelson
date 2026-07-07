// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { MessageChunk, ToolContext } from "@keelson/shared";
import { DocsCatalog, type DocsSource } from "./docs-catalog.ts";
import { createDocsTool } from "./docs-tool.ts";

const CORPUS = `# Alpha\n\n> Alpha summary.\n\nAlpha body.\n\n# Beta\n\nBeta body.\n`;

function makeCatalog(): DocsCatalog {
  const sources: DocsSource[] = [
    { id: "keelson", title: "Keelson", summary: "core", content: CORPUS },
    { id: "chamber", title: "Chamber", summary: "a rib", content: "# Rooms\n\nrooms body.\n" },
  ];
  return new DocsCatalog({ sources, cacheDir: "/nonexistent" });
}

function run(input: unknown): Promise<{ content: string; isError: boolean }> {
  const tool = createDocsTool({ catalog: makeCatalog() });
  const chunks: MessageChunk[] = [];
  const ctx: ToolContext = {
    cwd: "/tmp",
    emit: (c) => chunks.push(c),
    abortSignal: new AbortController().signal,
  };
  return tool.execute(input, ctx).then(() => {
    const last = chunks.at(-1) as Extract<MessageChunk, { type: "tool_result" }>;
    return { content: String(last.content), isError: last.isError === true };
  });
}

describe("keelson_docs tool", () => {
  test("is read-only (not state_changing)", () => {
    const tool = createDocsTool({ catalog: makeCatalog() });
    expect(tool.name).toBe("keelson_docs");
    expect(tool.state_changing).toBeUndefined();
  });

  test("no args lists every source, core and rib alike", async () => {
    const { content, isError } = await run({});
    expect(isError).toBe(false);
    expect(content).toContain("keelson — Keelson");
    expect(content).toContain("chamber — Chamber");
  });

  test("a source id returns that source's table of contents", async () => {
    const { content, isError } = await run({ source: "keelson" });
    expect(isError).toBe(false);
    expect(content).toContain("table of contents");
    expect(content).toContain("- alpha — Alpha summary.");
    expect(content).toContain("- beta");
    // The TOC lists topic names, not their bodies.
    expect(content).not.toContain("Alpha body.");
  });

  test("source + section returns just that topic", async () => {
    const { content, isError } = await run({ source: "keelson", section: "alpha" });
    expect(isError).toBe(false);
    expect(content).toContain("Keelson › Alpha");
    expect(content).toContain("Alpha body.");
    expect(content).not.toContain("Beta body.");
  });

  test("an unknown section errors and shows the available sections", async () => {
    const { content, isError } = await run({ source: "keelson", section: "ghost" });
    expect(isError).toBe(true);
    expect(content).toContain("Available sections");
    expect(content).toContain("alpha");
  });

  test("an unknown source errors", async () => {
    const { content, isError } = await run({ source: "ghost" });
    expect(isError).toBe(true);
    expect(content).toContain("Unknown docs source");
  });

  test("a section without a source is rejected, not silently listed", async () => {
    const { content, isError } = await run({ section: "alpha" });
    expect(isError).toBe(true);
    expect(content).toContain("invalid input");
    // It must not fall through to the source-listing path.
    expect(content).not.toContain("table of contents");
  });
});

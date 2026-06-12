// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  AssistantTurnView,
  summarizeToolResult,
  summarizeToolUse,
} from "../src/interactive/transcript.ts";

interface Renderable {
  render(width: number): string[];
}

function fakeSurface() {
  const children: Renderable[] = [];
  return {
    children,
    addChild(component: Renderable) {
      children.push(component);
    },
    requestRender() {},
  };
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderedText(children: readonly Renderable[]): string {
  return children
    .flatMap((c) => c.render(80))
    .map(stripAnsi)
    .join("\n");
}

describe("summarizeToolUse", () => {
  test("renders name and flattened args on one line", () => {
    const line = summarizeToolUse("read_file", { path: "/tmp/a.txt", limit: 5 });
    expect(line).toBe("⚙ read_file path: /tmp/a.txt, limit: 5");
  });

  test("truncates long input to a bounded single line", () => {
    const line = summarizeToolUse("bash", { command: "x".repeat(500) });
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("\n");
  });
});

describe("summarizeToolResult", () => {
  test("keeps only the first line, marked by an arrow", () => {
    expect(summarizeToolResult("ok\nsecond line")).toBe("→ ok second line");
  });

  test("marks errors", () => {
    expect(summarizeToolResult("nope", true)).toBe("✗ nope");
  });
});

describe("AssistantTurnView", () => {
  test("text chunks accumulate into a single markdown block", () => {
    const surface = fakeSurface();
    const view = new AssistantTurnView(surface);
    view.handleChunk({ type: "text", content: "Hello " });
    view.handleChunk({ type: "text", content: "world." });
    expect(surface.children).toHaveLength(1);
    expect(renderedText(surface.children)).toContain("Hello world.");
  });

  test("a tool call splits the text into ordered blocks", () => {
    const surface = fakeSurface();
    const view = new AssistantTurnView(surface);
    view.handleChunk({ type: "text", content: "before" });
    view.handleChunk({ type: "tool_use", toolName: "bash", toolInput: { command: "ls" } });
    view.handleChunk({ type: "tool_result", toolUseId: "t1", content: "a.txt" });
    view.handleChunk({ type: "text", content: "after" });
    expect(surface.children).toHaveLength(4);
    const text = renderedText(surface.children);
    expect(text.indexOf("before")).toBeLessThan(text.indexOf("⚙ bash"));
    expect(text.indexOf("⚙ bash")).toBeLessThan(text.indexOf("→ a.txt"));
    expect(text.indexOf("→ a.txt")).toBeLessThan(text.indexOf("after"));
  });

  test("error tool results are marked", () => {
    const surface = fakeSurface();
    const view = new AssistantTurnView(surface);
    view.handleChunk({ type: "tool_result", toolUseId: "t1", content: "denied", isError: true });
    expect(renderedText(surface.children)).toContain("✗ denied");
  });

  test("thinking stays hidden unless enabled", () => {
    const hidden = fakeSurface();
    new AssistantTurnView(hidden).handleChunk({ type: "thinking", content: "pondering" });
    expect(hidden.children).toHaveLength(0);

    const shown = fakeSurface();
    new AssistantTurnView(shown, { showThinking: true }).handleChunk({
      type: "thinking",
      content: "pondering",
    });
    expect(renderedText(shown.children)).toContain("pondering");
  });

  test("error chunks and fail() append marked lines", () => {
    const surface = fakeSurface();
    const view = new AssistantTurnView(surface);
    view.handleChunk({ type: "error", message: "provider exploded" });
    view.fail("stream ended");
    const text = renderedText(surface.children);
    expect(text).toContain("✗ provider exploded");
    expect(text).toContain("✗ stream ended");
  });

  test("usage and done chunks render nothing", () => {
    const surface = fakeSurface();
    const view = new AssistantTurnView(surface);
    view.handleChunk({
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    view.handleChunk({ type: "done" });
    expect(surface.children).toHaveLength(0);
  });
});

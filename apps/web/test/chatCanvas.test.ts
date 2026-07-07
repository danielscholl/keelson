import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@keelson/shared";
import {
  type LiveToolCall,
  toolCallsFromContentParts,
} from "../src/components/Chat/ToolCallsBlock.tsx";
import { parsePublishedArtifact, publishedCanvasResult } from "../src/lib/chatCanvas.ts";

describe("publishedCanvasResult", () => {
  test("returns the result string for a successful publish", () => {
    const result = JSON.stringify({ key: "canvas:artifact:wide-demo", slug: "wide-demo" });
    const calls: LiveToolCall[] = [{ id: "call-1", toolName: "canvas_publish", result }];

    expect(publishedCanvasResult(calls)).toBe(result);
  });

  test("ignores errored publishes", () => {
    const result = JSON.stringify({ key: "canvas:artifact:failed", slug: "failed" });
    const calls: LiveToolCall[] = [
      { id: "call-1", toolName: "canvas_publish", result, isError: true },
    ];

    expect(publishedCanvasResult(calls)).toBeUndefined();
  });

  test("ignores non-publish tool calls", () => {
    const result = JSON.stringify({ key: "canvas:artifact:ignored", slug: "ignored" });
    const calls: LiveToolCall[] = [{ id: "call-1", toolName: "memory_search", result }];

    expect(publishedCanvasResult(calls)).toBeUndefined();
  });

  test("returns the last successful publish", () => {
    const first = JSON.stringify({ key: "canvas:artifact:first", slug: "first" });
    const second = JSON.stringify({ key: "canvas:artifact:second", slug: "second" });
    const calls: LiveToolCall[] = [
      { id: "call-1", toolName: "canvas_publish", result: first },
      { id: "call-2", toolName: "canvas_publish", result: "not json" },
      { id: "call-3", toolName: "canvas_publish", result: second },
    ];

    expect(publishedCanvasResult(calls)).toBe(second);
  });
});

describe("parsePublishedArtifact", () => {
  test("extracts key and title from a publish result", () => {
    const result = JSON.stringify({ key: "canvas:artifact:audit", slug: "audit", title: "Audit" });
    expect(parsePublishedArtifact(result)).toEqual({
      key: "canvas:artifact:audit",
      title: "Audit",
    });
  });

  test("omits an absent or blank title", () => {
    const result = JSON.stringify({ key: "canvas:artifact:x", title: "   " });
    expect(parsePublishedArtifact(result)).toEqual({ key: "canvas:artifact:x" });
  });

  test("returns undefined without a usable key", () => {
    expect(parsePublishedArtifact(JSON.stringify({ slug: "x" }))).toBeUndefined();
    expect(parsePublishedArtifact(JSON.stringify({ key: "" }))).toBeUndefined();
    expect(parsePublishedArtifact("not json")).toBeUndefined();
  });
});

describe("toolCallsFromContentParts", () => {
  const publish = JSON.stringify({ key: "canvas:artifact:audit", slug: "audit", title: "Audit" });

  test("pairs a tool_result that follows its tool_use", () => {
    const parts: ContentBlock[] = [
      { type: "tool_use", id: "t1", toolName: "canvas_publish", toolInput: { title: "Audit" } },
      { type: "tool_result", toolUseId: "t1", content: publish },
    ];
    expect(publishedCanvasResult(toolCallsFromContentParts(parts))).toBe(publish);
  });

  // Regression: the copilot bridge persists a tool_result BEFORE its tool_use.
  // A single forward pass dropped it as an orphan, so the reopened chat lost the
  // artifact affordance even though the live turn had shown it.
  test("pairs a tool_result that precedes its tool_use (copilot order)", () => {
    const parts: ContentBlock[] = [
      { type: "tool_result", toolUseId: "t1", content: publish },
      { type: "tool_use", id: "t1", toolName: "canvas_publish", toolInput: { title: "Audit" } },
    ];
    expect(publishedCanvasResult(toolCallsFromContentParts(parts))).toBe(publish);
  });

  test("drops a truly orphaned tool_result", () => {
    const parts: ContentBlock[] = [{ type: "tool_result", toolUseId: "missing", content: publish }];
    expect(toolCallsFromContentParts(parts)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import type { LiveToolCall } from "../src/components/Chat/ToolCallsBlock.tsx";
import { CANVAS_OPEN_THRESHOLD, publishedCanvasResult, shouldOfferCanvas } from "../src/lib/chatCanvas.ts";

const long = "x".repeat(CANVAS_OPEN_THRESHOLD + 1);
const short = "x".repeat(CANVAS_OPEN_THRESHOLD - 1);

describe("shouldOfferCanvas", () => {
  test("a finished, long assistant answer qualifies", () => {
    expect(shouldOfferCanvas("assistant", long, false)).toBe(true);
  });

  test("a still-streaming answer does not (content is still growing)", () => {
    expect(shouldOfferCanvas("assistant", long, true)).toBe(false);
  });

  test("a short assistant answer reads fine in the bubble", () => {
    expect(shouldOfferCanvas("assistant", short, false)).toBe(false);
  });

  test("the threshold is exclusive — exactly THRESHOLD chars does not qualify", () => {
    expect(shouldOfferCanvas("assistant", "x".repeat(CANVAS_OPEN_THRESHOLD), false)).toBe(false);
  });

  test("only assistant rows qualify — user/system/command are not markdown-rendered", () => {
    expect(shouldOfferCanvas("user", long, false)).toBe(false);
    expect(shouldOfferCanvas("system", long, false)).toBe(false);
    expect(shouldOfferCanvas("command", long, false)).toBe(false);
  });

  test("length is measured after trimming whitespace", () => {
    expect(shouldOfferCanvas("assistant", `${" ".repeat(5000)}hi`, false)).toBe(false);
  });
});

describe("publishedCanvasResult", () => {
  test("returns the result string for a successful publish", () => {
    const result = JSON.stringify({ key: "canvas:artifact:wide-demo", slug: "wide-demo" });
    const calls: LiveToolCall[] = [{ id: "call-1", toolName: "canvas_publish", result }];

    expect(publishedCanvasResult(calls)).toBe(result);
  });

  test("ignores errored publishes", () => {
    const result = JSON.stringify({ key: "canvas:artifact:failed", slug: "failed" });
    const calls: LiveToolCall[] = [{ id: "call-1", toolName: "canvas_publish", result, isError: true }];

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

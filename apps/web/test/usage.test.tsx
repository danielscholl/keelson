// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { UsageChip } from "../src/components/Chat/UsageChip.tsx";
import { UsagePopover } from "../src/components/Chat/UsagePopover.tsx";
import { contextFillLevel, contextPercent, formatTokens } from "../src/lib/formatTokens.ts";

describe("formatTokens", () => {
  test("formats across magnitudes", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(199_500)).toBe("200k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  test("degrades garbage to 0", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("contextPercent / contextFillLevel", () => {
  test("returns null when either side is missing — never a fake 0%", () => {
    expect(contextPercent(undefined, 200000)).toBeNull();
    expect(contextPercent(42, undefined)).toBeNull();
    expect(contextPercent(42, 0)).toBeNull();
  });

  test("clamps and rounds", () => {
    expect(contextPercent(42_000, 200_000)).toBe(21);
    expect(contextPercent(500_000, 200_000)).toBe(100);
  });

  test("thresholds match the cross-harness convention", () => {
    expect(contextFillLevel(69)).toBe("ok");
    expect(contextFillLevel(70)).toBe("warn");
    expect(contextFillLevel(85)).toBe("hot");
  });
});

describe("UsageChip", () => {
  test("renders the context gauge when the latest turn carries a window", () => {
    render(
      <UsageChip
        latest={{
          inputTokens: 100,
          outputTokens: 20,
          contextTokens: 42_000,
          contextWindow: 200_000,
        }}
        totals={{ inputTokens: 100, outputTokens: 20, turns: 1 }}
        popoverId="usage-pop"
      />,
    );
    expect(screen.getByText("21%")).toBeDefined();
  });

  test("falls back to session ↑/↓ totals when no context window is reported", () => {
    render(
      <UsageChip
        latest={{ inputTokens: 1200, outputTokens: 300 }}
        totals={{ inputTokens: 2400, outputTokens: 700, turns: 2 }}
        popoverId="usage-pop-2"
      />,
    );
    expect(screen.getByText(/↑ 2\.4k ↓ 700/)).toBeDefined();
  });
});

describe("UsagePopover", () => {
  test("renders context, last-turn, and session groups with cache rows", () => {
    render(
      <UsagePopover
        popoverId="usage-pop-3"
        latest={{
          inputTokens: 1500,
          outputTokens: 340,
          cacheReadInputTokens: 9000,
          cacheCreationInputTokens: 1200,
          contextTokens: 60_000,
          contextWindow: 200_000,
        }}
        totals={{ inputTokens: 4000, outputTokens: 900, turns: 3 }}
      />,
    );
    expect(screen.getByText("Context")).toBeDefined();
    expect(screen.getByText("60k of 200k (30%)")).toBeDefined();
    expect(screen.getByText("Last turn")).toBeDefined();
    expect(screen.getByText("Cache read")).toBeDefined();
    expect(screen.getByText("9k")).toBeDefined();
    expect(screen.getByText("Session")).toBeDefined();
    expect(screen.getByText("Turns")).toBeDefined();
  });

  test("omits the cache rows when the provider reported none", () => {
    render(
      <UsagePopover
        popoverId="usage-pop-4"
        latest={{ inputTokens: 10, outputTokens: 5 }}
        totals={{ inputTokens: 10, outputTokens: 5, turns: 1 }}
      />,
    );
    expect(screen.queryByText("Cache read")).toBeNull();
    expect(screen.queryByText("Cache write")).toBeNull();
    expect(screen.queryByText("Context")).toBeNull();
  });
});

describe("UsageChip — fabricated-zero guard", () => {
  test("renders nothing when there is neither a context gauge nor session spend", () => {
    const { container } = render(
      <UsageChip
        latest={{ inputTokens: 0, outputTokens: 0, contextTokens: 900 }}
        totals={{ inputTokens: 0, outputTokens: 0, turns: 0 }}
        popoverId="usage-pop-5"
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("still renders the gauge for a context-only turn with a window", () => {
    render(
      <UsageChip
        latest={{ inputTokens: 0, outputTokens: 0, contextTokens: 32_000, contextWindow: 64_000 }}
        totals={{ inputTokens: 0, outputTokens: 0, turns: 0 }}
        popoverId="usage-pop-6"
      />,
    );
    expect(screen.getByText("50%")).toBeDefined();
  });
});

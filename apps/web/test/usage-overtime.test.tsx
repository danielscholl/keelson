// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UsageSeriesResponseWire, UsageSeriesRowWire } from "@keelson/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realApi from "../src/api.ts";

// Stub the snapshot hook so the Pulse section's live sparkline never touches
// the WS layer — this file's concern is the Over-time stacked chart only.
mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: () => ({
    status: "empty",
    data: null,
    version: null,
    composedAt: null,
    reload: () => {},
  }),
}));

let seriesRows: UsageSeriesResponseWire = [];

// Reassignable impls behind stable wrappers (the Canvas.test.tsx /
// useRibActionDispatch.test.tsx idiom): bun's mock.module is process-global
// and unrestorable, so the wrappers must delegate to bindings this file can
// point back at the real api once its tests finish — otherwise whichever
// test file loads later inherits these fixtures (order differs between
// macOS and Linux readdir, so it fails only on CI).
let getUsageSummaryImpl: typeof realApi.getUsageSummary = async () => summaryFixture();
let getUsageEventsImpl: typeof realApi.getUsageEvents = async () => [];
let getUsageSeriesImpl: typeof realApi.getUsageSeries = async () => seriesRows;
let getUsageBreakdownImpl: typeof realApi.getUsageBreakdown = async () => [];
let getUsageJobsImpl: typeof realApi.getUsageJobs = async () => [];

function summaryFixture() {
  return {
    totals: {
      events: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      pricedCostUsd: 0,
      pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      unpricedEvents: 1,
      cacheHitRatio: null,
      priceCards: [],
    },
    groups: [],
  };
}

mock.module("../src/api.ts", () => ({
  ...realApi,
  getUsageBreakdown: (...args: Parameters<typeof realApi.getUsageBreakdown>) =>
    getUsageBreakdownImpl(...args),
  getUsageSummary: (...args: Parameters<typeof realApi.getUsageSummary>) =>
    getUsageSummaryImpl(...args),
  getUsageEvents: (...args: Parameters<typeof realApi.getUsageEvents>) =>
    getUsageEventsImpl(...args),
  getUsageJobs: (...args: Parameters<typeof realApi.getUsageJobs>) => getUsageJobsImpl(...args),
  getUsageSeries: (...args: Parameters<typeof realApi.getUsageSeries>) =>
    getUsageSeriesImpl(...args),
}));

afterAll(() => {
  getUsageSummaryImpl = realApi.getUsageSummary;
  getUsageEventsImpl = realApi.getUsageEvents;
  getUsageSeriesImpl = realApi.getUsageSeries;
  getUsageBreakdownImpl = realApi.getUsageBreakdown;
  getUsageJobsImpl = realApi.getUsageJobs;
  mock.module("../src/api.ts", () => realApi);
});

async function renderUsage() {
  const { Usage } = await import("../src/views/Usage.tsx");
  return render(<Usage />);
}

beforeEach(() => {
  seriesRows = [];
  getUsageSummaryImpl = async () => summaryFixture();
});

function seriesRow(
  key: string,
  tokens: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
  bucketIso = "2026-07-01T00:00:00.000Z",
): UsageSeriesRowWire {
  return {
    bucketIso,
    key,
    events: 1,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    costUsd: null,
    pricedCostUsd: 0,
    pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    unpricedEvents: 1,
    cacheHitRatio: null,
  };
}

const NINE_MODELS = [
  "a-model",
  "b-model",
  "c-model",
  "d-model",
  "e-model",
  "f-model",
  "g-model",
  "h-model",
  "i-model",
];

describe("Usage — token series", () => {
  test("the series counts every token type, cache reads included", async () => {
    const { pivotSeries } = await import("../src/views/Usage.tsx");
    const { series, buckets } = pivotSeries([
      seriesRow("gemini-3.7-flash", { input: 900_000, output: 20_000 }),
      seriesRow("gpt-6.1-sol", {
        input: 2_267,
        output: 50_000,
        cacheWrite: 2_080_000,
        cacheRead: 5_000_000,
      }),
    ]);
    expect(series.map((s) => s.key)).toEqual(["gemini-3.7-flash", "gpt-6.1-sol"]);
    expect(buckets[0]?.values).toEqual([920_000, 7_132_267]);
    expect(buckets[0]?.total).toBe(8_052_267);
  });

  test("up to six models each get their own slot in alphabetical order", async () => {
    const { assignSeriesColors } = await import("../src/views/Usage.tsx");
    const palette = assignSeriesColors(
      new Map([
        ["zeta", 1],
        ["alpha", 100],
        ["mid", 50],
      ]),
    );
    expect(palette.named).toEqual(["alpha", "mid", "zeta"]);
    expect(palette.folded).toEqual([]);
    expect(palette.named.map(palette.colorOf)).toEqual(["var(--s1)", "var(--s2)", "var(--s3)"]);
  });

  test("past six models the tail folds into Other so no two series share a color", async () => {
    const { assignSeriesColors, pivotSeries } = await import("../src/views/Usage.tsx");
    const totals = new Map(NINE_MODELS.map((m, i) => [m, (i + 1) * 1000]));
    const palette = assignSeriesColors(totals);
    expect(palette.named).toEqual(["e-model", "f-model", "g-model", "h-model", "i-model"]);
    expect(palette.folded).toEqual(["a-model", "b-model", "c-model", "d-model"]);
    expect(palette.colorOf("a-model")).toBe("var(--s-other)");

    const { series, buckets } = pivotSeries(
      NINE_MODELS.map((m, i) => seriesRow(m, { input: (i + 1) * 1000, output: 0 })),
    );
    expect(series).toHaveLength(6);
    expect(new Set(series.map((s) => s.color)).size).toBe(6);
    expect(series.at(-1)?.label).toBe("Other (4 models)");
    expect(buckets[0]?.values.at(-1)).toBe(1000 + 2000 + 3000 + 4000);
  });

  test("the legend names the folded tail instead of reusing a color", async () => {
    seriesRows = NINE_MODELS.map((m, i) => seriesRow(m, { input: (i + 1) * 1000, output: 0 }));

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByText("Other (4 models)")).toBeDefined());
    const legend = within(document.querySelector(".usage-legend") as HTMLElement);
    expect(legend.getByText("i-model")).toBeDefined();
    expect(legend.queryByText("a-model")).toBeNull();
  });

  test("the pulse tile counts every token type and cache writes in the cache-hit denominator", async () => {
    getUsageSummaryImpl = async () => ({
      totals: {
        events: 18,
        inputTokens: 2_267,
        outputTokens: 50_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 2_080_000,
        costUsd: null,
        pricedCostUsd: 0,
        pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unpricedEvents: 18,
        cacheHitRatio: 1_000_000 / 3_082_267,
        priceCards: [],
      },
      groups: [],
    });

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByText("3.1M")).toBeDefined());
    expect(screen.getByLabelText("Tokens: 3.1M")).toBeDefined();
    expect(screen.getByText("1M of 3.1M input")).toBeDefined();
  });
});

describe("Usage — Over time stacked chart", () => {
  test("renders a stacked bar per bucket and a legend entry per model", async () => {
    seriesRows = [
      {
        bucketIso: "2026-07-01T00:00:00.000Z",
        key: "claude-sonnet-5",
        events: 3,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        pricedCostUsd: 0,
        pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unpricedEvents: 3,
        cacheHitRatio: null,
      },
      {
        bucketIso: "2026-07-01T00:00:00.000Z",
        key: "gpt-5.5",
        events: 2,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        pricedCostUsd: 0,
        pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unpricedEvents: 2,
        cacheHitRatio: null,
      },
      {
        bucketIso: "2026-07-02T00:00:00.000Z",
        key: "claude-sonnet-5",
        events: 1,
        inputTokens: 500_000,
        outputTokens: 90_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        pricedCostUsd: 0,
        pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unpricedEvents: 1,
        cacheHitRatio: null,
      },
    ];

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByLabelText(/Tokens over time by model/)).toBeDefined());
    const legend = within(document.querySelector(".usage-legend") as HTMLElement);
    expect(legend.getByText("claude-sonnet-5")).toBeDefined();
    expect(legend.getByText("gpt-5.5")).toBeDefined();
    expect(
      within(screen.getByLabelText(/Tokens over time by model/)).getByText("Jul 2"),
    ).toBeDefined();

    const table = within(screen.getByRole("table", { name: "Tokens by model per day" }));
    expect(table.getAllByRole("row")).toHaveLength(4);
    expect(table.getByRole("row", { name: "Jul 1 claude-sonnet-5 1.2M 71%" })).toBeDefined();
    expect(table.getByRole("row", { name: "Jul 1 gpt-5.5 500k 29%" })).toBeDefined();
    expect(table.getByRole("row", { name: "Jul 2 claude-sonnet-5 590k 100%" })).toBeDefined();
  });

  test("hovering a bar names every model in its stack and opens the Other tail", async () => {
    seriesRows = NINE_MODELS.map((m, i) => seriesRow(m, { input: (i + 1) * 1000, output: 0 }));

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByLabelText(/Tokens over time by model/)).toBeDefined());
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(screen.getByTestId("usage-stack-hit-2026-07-01T00:00:00.000Z"));
    const tooltip = within(screen.getByRole("tooltip"));
    expect(tooltip.getByText("Jul 1")).toBeDefined();
    expect(tooltip.getByText("45k")).toBeDefined();
    expect(tooltip.getByText("i-model")).toBeDefined();
    expect(tooltip.getByText("Other")).toBeDefined();
    expect(tooltip.getByText("a-model")).toBeDefined();
    expect(tooltip.getByText("d-model")).toBeDefined();
    const table = within(screen.getByRole("table", { name: "Tokens by model per day" }));
    expect(table.getByRole("row", { name: "Jul 1 a-model 1k 2%" })).toBeDefined();

    fireEvent.pointerLeave(screen.getByLabelText(/Tokens over time by model/));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("a focused bar opens the same details and ends a long Other list with a count", async () => {
    const ELEVEN = [...NINE_MODELS, "j-model", "k-model"];
    seriesRows = ELEVEN.map((m, i) => seriesRow(m, { input: (i + 1) * 1000, output: 0 }));

    await act(async () => {
      await renderUsage();
    });

    const bar = await screen.findByRole("img", { name: "Jul 1: 66k tokens" });
    fireEvent.focus(bar);
    const tooltip = screen.getByRole("tooltip");
    expect(bar.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(within(tooltip).getByText("+2 more")).toBeDefined();
    expect(within(tooltip).getByText("f-model")).toBeDefined();
    expect(within(tooltip).queryByText("a-model")).toBeNull();

    fireEvent.blur(bar);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("Escape closes the card, and the pointer leaving keeps a focused bar's card open", async () => {
    seriesRows = [
      seriesRow("a-model", { input: 1000, output: 0 }, "2026-07-01T00:00:00.000Z"),
      seriesRow("a-model", { input: 2000, output: 0 }, "2026-07-02T00:00:00.000Z"),
    ];

    await act(async () => {
      await renderUsage();
    });

    const chart = await screen.findByLabelText(/Tokens over time by model/);
    const jul1 = screen.getByRole("img", { name: "Jul 1: 1k tokens" });

    fireEvent.pointerEnter(screen.getByTestId("usage-stack-hit-2026-07-02T00:00:00.000Z"));
    expect(within(screen.getByRole("tooltip")).getByText("Jul 2")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(jul1);
    fireEvent.pointerEnter(screen.getByTestId("usage-stack-hit-2026-07-02T00:00:00.000Z"));
    expect(within(screen.getByRole("tooltip")).getByText("Jul 2")).toBeDefined();
    fireEvent.pointerLeave(chart);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("Jul 1")).toBeDefined();
    expect(jul1.getAttribute("aria-describedby")).toBe(tooltip.id);
  });

  test("shows a quiet placeholder line instead of a broken chart when the series is empty", async () => {
    seriesRows = [];

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() =>
      expect(screen.getByText("No token spend recorded in this window yet.")).toBeDefined(),
    );
    expect(screen.queryByLabelText(/Tokens over time by model/)).toBeNull();
  });

  test("the Cost switch stacks priced cost instead of tokens", async () => {
    seriesRows = [
      {
        ...seriesRow("gpt-6-sol", { input: 0, output: 0, cacheRead: 9_000_000 }),
        pricedCostUsd: 1.8,
      },
      { ...seriesRow("gpt-6-astra", { input: 0, output: 100_000 }), pricedCostUsd: 5 },
    ];

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByLabelText(/Tokens over time by model/)).toBeDefined());
    fireEvent.click(screen.getAllByLabelText("Cost")[0] as HTMLElement);
    await waitFor(() => expect(screen.getByLabelText(/Cost over time by model/)).toBeDefined());
    const table = within(screen.getByRole("table", { name: "Cost by model per day" }));
    expect(table.getByRole("row", { name: "Jul 1 gpt-6-astra $5.00 74%" })).toBeDefined();
    expect(table.getByRole("row", { name: "Jul 1 gpt-6-sol $1.80 26%" })).toBeDefined();
  });
});

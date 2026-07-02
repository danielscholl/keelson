// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UsageSeriesResponseWire } from "@keelson/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
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
});

async function renderUsage() {
  const { Usage } = await import("../src/views/Usage.tsx");
  return render(<Usage />);
}

beforeEach(() => {
  seriesRows = [];
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
      },
      {
        bucketIso: "2026-07-01T00:00:00.000Z",
        key: "gpt-5.5",
        events: 2,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        bucketIso: "2026-07-02T00:00:00.000Z",
        key: "claude-sonnet-5",
        events: 1,
        inputTokens: 500_000,
        outputTokens: 90_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];

    await act(async () => {
      await renderUsage();
    });

    await waitFor(() => expect(screen.getByLabelText(/Tokens over time by model/)).toBeDefined());
    expect(screen.getByText("claude-sonnet-5")).toBeDefined();
    expect(screen.getByText("gpt-5.5")).toBeDefined();
    expect(screen.getByText("Jul 2")).toBeDefined();
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
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realApi from "../src/api.ts";
import { UsageChip } from "../src/components/Chat/UsageChip.tsx";
import { UsageBreakdown, UsagePopover } from "../src/components/Chat/UsagePopover.tsx";
import {
  contextFillLevel,
  contextPercent,
  formatTokens,
  sumTokenSpend,
} from "../src/lib/formatTokens.ts";

mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: () => ({
    status: "empty",
    data: null,
    version: null,
    composedAt: null,
    reload: () => {},
  }),
}));

let getUsageSummaryImpl: typeof realApi.getUsageSummary = async () => ({
  totals: {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  groups: [],
});
let getUsageEventsImpl: typeof realApi.getUsageEvents = async () => [];
let getUsageSeriesImpl: typeof realApi.getUsageSeries = async () => [];
let getUsageBreakdownImpl: typeof realApi.getUsageBreakdown = async () => [];
let getUsageJobsImpl: typeof realApi.getUsageJobs = async () => [];

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

async function renderUsagePage() {
  const { Usage } = await import("../src/views/Usage.tsx");
  return render(<Usage />);
}

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

describe("sumTokenSpend", () => {
  test("sums input/output across reporting nodes, skipping non-reporters", () => {
    expect(
      sumTokenSpend([
        { inputTokens: 14_000, outputTokens: 34 },
        undefined,
        { inputTokens: 865_000, outputTokens: 7800 },
        null,
      ]),
    ).toEqual({ inputTokens: 879_000, outputTokens: 7834 });
  });

  test("returns null when nothing was spent — never a fabricated 0", () => {
    expect(sumTokenSpend([])).toBeNull();
    expect(sumTokenSpend([undefined, null])).toBeNull();
    expect(sumTokenSpend([{ inputTokens: 0, outputTokens: 0 }])).toBeNull();
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
  test("UsageBreakdown renders reported zero cache rows without inventing absent rows", () => {
    render(
      <UsageBreakdown
        usage={{
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          contextTokens: 300,
          contextWindow: 1000,
        }}
      />,
    );
    expect(screen.getByText("Context")).toBeDefined();
    expect(screen.getByText("300 of 1k (30%)")).toBeDefined();
    expect(screen.getByText("Cache read")).toBeDefined();
    expect(screen.queryByText("Cache write")).toBeNull();
    expect(screen.queryByText("↑ Input")).toBeNull();
    expect(screen.queryByText("↓ Output")).toBeNull();
  });

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

  test("cache-write-only turn shows Cache write row but not ↑/↓ rows", () => {
    render(
      <UsagePopover
        popoverId="usage-pop-7"
        latest={{ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1200 }}
        totals={{ inputTokens: 0, outputTokens: 0, turns: 0 }}
      />,
    );
    expect(screen.getByText("Cache write")).toBeDefined();
    expect(screen.queryByText("↑ Input")).toBeNull();
    expect(screen.queryByText("↓ Output")).toBeNull();
    expect(screen.queryByText("Cache read")).toBeNull();
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

describe("Usage page", () => {
  test("switches between usage sub-views", async () => {
    await act(async () => {
      await renderUsagePage();
    });

    await waitFor(() => expect(screen.getByText("Pulse")).toBeDefined());
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeDefined();

    fireEvent.click(screen.getByLabelText("Models"));
    await waitFor(() => expect(screen.getByText("Model roster")).toBeDefined());
    expect(screen.queryByText("Pulse")).toBeNull();

    fireEvent.click(screen.getByLabelText("Jobs"));
    await waitFor(() =>
      expect(
        screen.getByText("No recurring workflow or rib spend in this window yet."),
      ).toBeDefined(),
    );

    fireEvent.click(screen.getByLabelText("Ledger"));
    await waitFor(() =>
      expect(screen.getByText("No events recorded in this window yet.")).toBeDefined(),
    );
  });

  test("renders source to model flow from one breakdown aggregate call", async () => {
    const calls: Parameters<typeof realApi.getUsageBreakdown>[0][] = [];
    getUsageBreakdownImpl = async (query) => {
      calls.push(query);
      return [
        {
          key: "workflow",
          split: "gpt-5.5",
          events: 2,
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ];
    };

    await act(async () => {
      await renderUsagePage();
    });

    await waitFor(() => expect(screen.getByLabelText("Source to model token flow")).toBeDefined());
    expect(screen.getByText("workflow")).toBeDefined();
    expect(screen.getAllByText("gpt-5.5").length).toBeGreaterThan(0);
    expect(calls).toEqual([{ window: "7d", groupBy: "source", splitBy: "model" }]);
    getUsageBreakdownImpl = async () => [];
  });

  test("renders recurring jobs table and burn bars", async () => {
    getUsageJobsImpl = async () => [
      {
        key: "smoke-test",
        runs: 3,
        totalTokens: 1200,
        avgTokensPerRun: 400,
        p95TokensPerRun: 700,
      },
    ];

    await act(async () => {
      await renderUsagePage();
    });

    fireEvent.click(screen.getByLabelText("Jobs"));
    await waitFor(() => expect(screen.getAllByText("smoke-test").length).toBeGreaterThan(0));
    expect(screen.getByText("Avg tokens/run")).toBeDefined();
    expect(screen.getByLabelText("Weekly burn by job")).toBeDefined();
    getUsageJobsImpl = async () => [];
  });

  test("renders deterministic usage signals", async () => {
    getUsageSummaryImpl = async () => ({
      totals: {
        events: 1,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 250,
        cacheWriteTokens: 0,
      },
      groups: [
        {
          key: "claude-sonnet-5",
          events: 1,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 250,
          cacheWriteTokens: 0,
        },
      ],
    });
    getUsageJobsImpl = async () => [
      {
        key: "standing-lens",
        runs: 5,
        totalTokens: 1500,
        avgTokensPerRun: 300,
        p95TokensPerRun: 400,
      },
    ];
    getUsageEventsImpl = async (query) =>
      query.status === "error"
        ? [
            {
              id: 1,
              ts: "2026-07-01T00:00:00.000Z",
              source: "workflow",
              provider: "codex",
              model: "gpt-5.5",
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              durationMs: 1000,
              status: "error",
              conversationId: null,
              runId: "run-1",
              nodeId: null,
              workflowName: "standing-lens",
              ribId: null,
              projectId: null,
            },
          ]
        : [];

    await act(async () => {
      await renderUsagePage();
    });

    await waitFor(() => expect(screen.getAllByText("Failure burn").length).toBeGreaterThan(0));
    expect(screen.getByText(/top: standing-lens/)).toBeDefined();
    expect(screen.getByText("Downshift candidate")).toBeDefined();
    expect(screen.getByText("standing-lens")).toBeDefined();
    expect(screen.getByText("250 of 1.3k input")).toBeDefined();
    expect(screen.getAllByText("20%").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText("Models"));
    await waitFor(() => expect(screen.getByText("claude-sonnet-5")).toBeDefined());
    expect(screen.getByText("20%")).toBeDefined();
    getUsageSummaryImpl = async () => ({
      totals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      groups: [],
    });
    getUsageJobsImpl = async () => [];
    getUsageEventsImpl = async () => [];
  });

  test("labels auto model rows as unresolved", async () => {
    getUsageSummaryImpl = async (query) =>
      query.groupBy === "model"
        ? {
            totals: {
              events: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            groups: [
              {
                key: "auto",
                events: 1,
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            ],
          }
        : {
            totals: {
              events: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            groups: [],
          };
    getUsageEventsImpl = async () => [
      {
        id: 1,
        ts: "2026-07-01T00:00:00.000Z",
        source: "chat",
        provider: "copilot",
        model: "auto",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 1000,
        status: "ok",
        conversationId: null,
        runId: null,
        nodeId: null,
        workflowName: null,
        ribId: null,
        projectId: null,
      },
    ];

    await act(async () => {
      await renderUsagePage();
    });

    fireEvent.click(screen.getByLabelText("Models"));
    await waitFor(() => expect(screen.getByText("auto (unresolved)")).toBeDefined());

    fireEvent.click(screen.getByLabelText("Ledger"));
    await waitFor(() => expect(screen.getByText("copilot · auto (unresolved)")).toBeDefined());
    getUsageSummaryImpl = async () => ({
      totals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      groups: [],
    });
    getUsageEventsImpl = async () => [];
  });

  test("passes active ledger filters to the events query", async () => {
    const eventCalls: Parameters<typeof realApi.getUsageEvents>[0][] = [];
    getUsageSummaryImpl = async (query) =>
      query.groupBy === "model"
        ? {
            totals: {
              events: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            groups: [
              {
                key: "auto",
                events: 1,
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            ],
          }
        : {
            totals: {
              events: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            groups: [],
          };
    getUsageEventsImpl = async (query) => {
      eventCalls.push(query);
      return [];
    };

    await act(async () => {
      await renderUsagePage();
    });

    fireEvent.click(screen.getByLabelText("Ledger"));
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Ledger filters" })).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "workflow" }));
    fireEvent.click(await screen.findByRole("button", { name: "auto (unresolved)" }));
    fireEvent.click(screen.getByRole("button", { name: "error" }));

    await waitFor(() =>
      expect(eventCalls).toContainEqual({
        window: "7d",
        limit: 50,
        source: "workflow",
        model: "auto",
        status: "error",
      }),
    );
    expect(screen.getByText("0 events")).toBeDefined();
    getUsageSummaryImpl = async () => ({
      totals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      groups: [],
    });
    getUsageEventsImpl = async () => [];
  });
});

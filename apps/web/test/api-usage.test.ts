// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getUsageBreakdown,
  getUsageEvents,
  getUsageJobs,
  getUsageSeries,
  getUsageSummary,
} from "../src/api.ts?api-usage";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: unknown): void {
  const fetchMock = mock(async () => Response.json(body));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

const validTotals = {
  events: 3,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("getUsageSummary", () => {
  test("parses a valid usage summary payload", async () => {
    stubFetch({ totals: validTotals, groups: [{ ...validTotals, key: "claude-sonnet-5" }] });
    const result = await getUsageSummary();
    expect(result.totals).toEqual(validTotals);
    expect(result.groups[0]?.key).toBe("claude-sonnet-5");
  });

  test("rejects a malformed usage summary payload", async () => {
    stubFetch({ totals: { ...validTotals, inputTokens: "not-a-number" }, groups: [] });
    await expect(getUsageSummary()).rejects.toThrow();
  });
});

describe("getUsageSeries", () => {
  test("parses a valid usage series payload", async () => {
    stubFetch([{ ...validTotals, bucketIso: "2026-07-01T00:00:00.000Z", key: "claude-sonnet-5" }]);
    const result = await getUsageSeries();
    expect(result).toHaveLength(1);
    expect(result[0]?.bucketIso).toBe("2026-07-01T00:00:00.000Z");
  });

  test("rejects a malformed usage series payload (missing key)", async () => {
    stubFetch([{ ...validTotals, bucketIso: "2026-07-01T00:00:00.000Z" }]);
    await expect(getUsageSeries()).rejects.toThrow();
  });
});

describe("getUsageBreakdown", () => {
  test("parses a valid usage breakdown payload", async () => {
    stubFetch([{ ...validTotals, key: "chat", split: "claude-sonnet-5" }]);
    const result = await getUsageBreakdown();
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("chat");
  });

  test("rejects a malformed usage breakdown payload (missing split)", async () => {
    stubFetch([{ ...validTotals, key: "chat" }]);
    await expect(getUsageBreakdown()).rejects.toThrow();
  });
});

describe("getUsageJobs", () => {
  test("parses a valid usage jobs payload", async () => {
    stubFetch([
      {
        key: "smoke-test",
        runs: 2,
        totalTokens: 100,
        avgTokensPerRun: 50,
        p95TokensPerRun: 75,
      },
    ]);
    const result = await getUsageJobs();
    expect(result[0]?.key).toBe("smoke-test");
  });

  test("rejects a malformed usage jobs payload", async () => {
    stubFetch([{ key: "smoke-test", runs: -1 }]);
    await expect(getUsageJobs()).rejects.toThrow();
  });
});

const validEventRow = {
  id: 1,
  ts: "2026-07-01T00:00:00.000Z",
  source: "chat",
  provider: "anthropic",
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  durationMs: null,
  status: "ok",
  conversationId: null,
  runId: null,
  nodeId: null,
  workflowName: null,
  ribId: null,
  projectId: null,
};

describe("getUsageEvents", () => {
  test("parses a valid usage events payload", async () => {
    stubFetch([validEventRow]);
    const result = await getUsageEvents();
    expect(result).toHaveLength(1);
    expect(result[0]?.model).toBe("claude-sonnet-5");
  });

  test("accepts a foreign status (read side outlives writer enums)", async () => {
    stubFetch([{ ...validEventRow, status: "succeeded" }]);
    const result = await getUsageEvents();
    expect(result[0]?.status).toBe("succeeded");
  });

  test("rejects a malformed usage events payload (negative token count)", async () => {
    stubFetch([{ ...validEventRow, inputTokens: -1 }]);
    await expect(getUsageEvents()).rejects.toThrow();
  });
});

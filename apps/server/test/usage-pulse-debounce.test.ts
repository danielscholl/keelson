// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import { withUsagePulseDebounce } from "../src/usage-pulse-debounce.ts";
import type { UsageStore } from "../src/usage-store.ts";

function fakeStore(): UsageStore {
  return {
    record: () => {},
    listEvents: () => [],
    totals: () => ({ events: 0, inputTokens: 0, outputTokens: 0 }),
    summary: () => ({
      totals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      groups: [],
    }),
    series: () => [],
    breakdown: () => [],
    events: () => [],
    pulse: () => ({
      composedTotals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      minuteSeries: [],
    }),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withUsagePulseDebounce", () => {
  test("a single record() call schedules exactly one recompose after the quiet window", async () => {
    let settled = 0;
    const decorated = withUsagePulseDebounce(
      fakeStore(),
      () => {
        settled++;
      },
      30,
    );

    decorated.record({ source: "chat", provider: "claude", model: "m" });
    expect(settled).toBe(0);
    await wait(60);
    expect(settled).toBe(1);
  });

  test("a burst of record() calls within the quiet window coalesces into exactly one recompose", async () => {
    let settled = 0;
    const decorated = withUsagePulseDebounce(
      fakeStore(),
      () => {
        settled++;
      },
      30,
    );

    for (let i = 0; i < 5; i++) {
      decorated.record({ source: "chat", provider: "claude", model: "m" });
      await wait(10);
    }
    expect(settled).toBe(0);
    await wait(60);
    expect(settled).toBe(1);
  });

  test("record() still delegates to the wrapped store on every call", () => {
    const base = fakeStore();
    let calls = 0;
    const spiedStore: UsageStore = {
      ...base,
      record: (input) => {
        calls++;
        base.record(input);
      },
    };
    const decorated = withUsagePulseDebounce(spiedStore, () => {}, 30);

    decorated.record({ source: "chat", provider: "claude", model: "m" });
    decorated.record({ source: "workflow", provider: "codex", model: "m2" });
    expect(calls).toBe(2);
  });

  test("passes through every non-record method untouched", () => {
    const base = fakeStore();
    const decorated = withUsagePulseDebounce(base, () => {}, 30);
    expect(decorated.listEvents).toBe(base.listEvents);
    expect(decorated.totals).toBe(base.totals);
    expect(decorated.summary).toBe(base.summary);
    expect(decorated.series).toBe(base.series);
    expect(decorated.breakdown).toBe(base.breakdown);
    expect(decorated.events).toBe(base.events);
    expect(decorated.pulse).toBe(base.pulse);
  });

  test("separate quiet windows each trigger their own recompose", async () => {
    let settled = 0;
    const decorated = withUsagePulseDebounce(
      fakeStore(),
      () => {
        settled++;
      },
      30,
    );

    decorated.record({ source: "chat", provider: "claude", model: "m" });
    await wait(60);
    expect(settled).toBe(1);

    decorated.record({ source: "chat", provider: "claude", model: "m" });
    await wait(60);
    expect(settled).toBe(2);
  });
});

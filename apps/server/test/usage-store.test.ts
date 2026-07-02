// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import { createUsageStore, type UsageStore } from "../src/usage-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: UsageStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-usage-store-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  store = createUsageStore(db);
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("SQLite UsageStore", () => {
  test("record + listEvents round-trips a full event", () => {
    store.record({
      source: "chat",
      provider: "claude",
      model: "claude-opus",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      durationMs: 1234,
      status: "ok",
      conversationId: "conv-1",
    });
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "chat",
      provider: "claude",
      model: "claude-opus",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      durationMs: 1234,
      status: "ok",
      conversationId: "conv-1",
      runId: null,
      nodeId: null,
      workflowName: null,
      ribId: null,
      projectId: null,
    });
    expect(typeof events[0].id).toBe("number");
    expect(typeof events[0].ts).toBe("string");
  });

  test("record omits ts and status → defaults to now and 'ok'", () => {
    const before = new Date().toISOString();
    store.record({
      source: "workflow",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 1,
      outputTokens: 1,
    });
    const [event] = store.listEvents();
    expect(event.status).toBe("ok");
    expect(event.ts >= before).toBe(true);
  });

  test("listEvents filters by source", () => {
    store.record({
      source: "chat",
      provider: "claude",
      model: "claude-opus",
      inputTokens: 1,
      outputTokens: 1,
    });
    store.record({
      source: "workflow",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 2,
      outputTokens: 2,
    });
    store.record({ source: "rib", provider: "pi", model: "pi-1", inputTokens: 3, outputTokens: 3 });

    expect(store.listEvents({ source: "workflow" })).toHaveLength(1);
    expect(store.listEvents({ source: "workflow" })[0].provider).toBe("codex");
    expect(store.listEvents()).toHaveLength(3);
  });

  test("listEvents orders newest first and respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.record({
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: i,
        outputTokens: 0,
      });
    }
    const limited = store.listEvents({ limit: 2 });
    expect(limited).toHaveLength(2);
    // Insertion order within the same instant is id DESC.
    expect(limited[0].inputTokens).toBe(4);
    expect(limited[1].inputTokens).toBe(3);
  });

  test("totals sums input/output tokens across all events", () => {
    store.record({
      source: "chat",
      provider: "claude",
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
    });
    store.record({
      source: "workflow",
      provider: "codex",
      model: "m",
      inputTokens: 3,
      outputTokens: 7,
    });
    expect(store.totals()).toEqual({ events: 2, inputTokens: 13, outputTokens: 12 });
  });

  test("totals respects sinceIso", () => {
    store.record({
      ts: "2020-01-01T00:00:00.000Z",
      source: "chat",
      provider: "claude",
      model: "m",
      inputTokens: 100,
      outputTokens: 100,
    });
    store.record({
      ts: "2030-01-01T00:00:00.000Z",
      source: "chat",
      provider: "claude",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(store.totals({ sinceIso: "2025-01-01T00:00:00.000Z" })).toEqual({
      events: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  describe("token flooring", () => {
    test("floors fractional input/output counts", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 10.9,
        outputTokens: 5.4,
      });
      const [event] = store.listEvents();
      expect(event.inputTokens).toBe(10);
      expect(event.outputTokens).toBe(5);
    });

    test("a negative or non-finite input/output count falls back to 0", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: -5,
        outputTokens: Number.NaN,
      });
      const [event] = store.listEvents();
      expect(event.inputTokens).toBe(0);
      expect(event.outputTokens).toBe(0);
    });

    test("floors fractional nullable counts (cache tokens, duration)", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 2.7,
        cacheWriteTokens: 3.2,
        durationMs: 999.9,
      });
      const [event] = store.listEvents();
      expect(event.cacheReadTokens).toBe(2);
      expect(event.cacheWriteTokens).toBe(3);
      expect(event.durationMs).toBe(999);
    });

    test("a negative nullable count is dropped to null rather than clamped", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: -1,
        durationMs: -100,
      });
      const [event] = store.listEvents();
      expect(event.cacheReadTokens).toBeNull();
      expect(event.durationMs).toBeNull();
    });
  });

  describe("nullable attribution", () => {
    test("omitted attribution fields persist as null, not undefined or empty string", () => {
      store.record({
        source: "rib",
        provider: "pi",
        model: "pi-1",
        inputTokens: 1,
        outputTokens: 1,
      });
      const [event] = store.listEvents();
      expect(event.conversationId).toBeNull();
      expect(event.runId).toBeNull();
      expect(event.nodeId).toBeNull();
      expect(event.workflowName).toBeNull();
      expect(event.ribId).toBeNull();
      expect(event.projectId).toBeNull();
    });

    test("explicit null attribution fields persist as null", () => {
      store.record({
        source: "workflow",
        provider: "codex",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        conversationId: null,
        runId: null,
        nodeId: null,
        workflowName: null,
        ribId: null,
        projectId: null,
      });
      const [event] = store.listEvents();
      expect(event.conversationId).toBeNull();
      expect(event.runId).toBeNull();
      expect(event.nodeId).toBeNull();
      expect(event.workflowName).toBeNull();
      expect(event.ribId).toBeNull();
      expect(event.projectId).toBeNull();
    });

    test("provided attribution fields persist verbatim", () => {
      store.record({
        source: "workflow",
        provider: "codex",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        conversationId: "conv-1",
        runId: "run-1",
        nodeId: "node-1",
        workflowName: "smoke-test",
        ribId: "osdu",
        projectId: "proj-1",
      });
      const [event] = store.listEvents();
      expect(event.conversationId).toBe("conv-1");
      expect(event.runId).toBe("run-1");
      expect(event.nodeId).toBe("node-1");
      expect(event.workflowName).toBe("smoke-test");
      expect(event.ribId).toBe("osdu");
      expect(event.projectId).toBe("proj-1");
    });
  });

  describe("summary", () => {
    test("groups by model with overall totals", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 3,
        outputTokens: 7,
      });
      const result = store.summary({ groupBy: "model" });
      expect(result.totals).toEqual({
        events: 2,
        inputTokens: 13,
        outputTokens: 12,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
      expect(result.groups).toEqual([
        {
          key: "claude-opus",
          events: 1,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        {
          key: "gpt-5",
          events: 1,
          inputTokens: 3,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
    });

    test("groups nullable attribution (rib, workflow) under the '(none)' key", () => {
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 1,
        workflowName: "smoke-test",
      });
      store.record({
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 2,
        outputTokens: 2,
      });
      const byWorkflow = store.summary({ groupBy: "workflow" });
      expect(byWorkflow.groups).toContainEqual(
        expect.objectContaining({ key: "(none)", events: 1 }),
      );
      expect(byWorkflow.groups).toContainEqual(
        expect.objectContaining({ key: "smoke-test", events: 1 }),
      );

      const byRib = store.summary({ groupBy: "rib" });
      expect(byRib.groups).toEqual([expect.objectContaining({ key: "(none)", events: 2 })]);
    });

    test("respects sinceIso", () => {
      store.record({
        ts: "2020-01-01T00:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 100,
        outputTokens: 100,
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      });
      const result = store.summary({
        groupBy: "model",
        sinceIso: "2025-01-01T00:00:00.000Z",
      });
      expect(result.totals.events).toBe(1);
      expect(result.totals.inputTokens).toBe(1);
    });
  });

  describe("series", () => {
    test("buckets totals per hour and per group", () => {
      store.record({
        ts: "2026-01-01T10:15:00.000Z",
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 1,
        outputTokens: 1,
      });
      store.record({
        ts: "2026-01-01T10:45:00.000Z",
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 2,
        outputTokens: 2,
      });
      store.record({
        ts: "2026-01-01T11:05:00.000Z",
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 4,
        outputTokens: 4,
      });
      const rows = store.series({ bucket: "hour", groupBy: "model" });
      expect(rows).toEqual([
        {
          bucketIso: "2026-01-01T10:00:00.000Z",
          key: "claude-opus",
          events: 2,
          inputTokens: 3,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          bucketIso: "2026-01-01T11:00:00.000Z",
          key: "claude-opus",
          events: 1,
          inputTokens: 4,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
    });

    test("buckets totals per day", () => {
      store.record({
        ts: "2026-01-01T23:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      });
      store.record({
        ts: "2026-01-02T01:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 2,
        outputTokens: 2,
      });
      const rows = store.series({ bucket: "day", groupBy: "source" });
      expect(rows.map((r) => r.bucketIso)).toEqual([
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ]);
    });
  });

  describe("breakdown", () => {
    test("returns a source x model matrix by default", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 1,
        outputTokens: 1,
      });
      store.record({
        source: "chat",
        provider: "claude",
        model: "claude-haiku",
        inputTokens: 2,
        outputTokens: 2,
      });
      store.record({
        source: "workflow",
        provider: "codex",
        model: "claude-opus",
        inputTokens: 3,
        outputTokens: 3,
      });
      const rows = store.breakdown();
      expect(rows).toEqual([
        {
          key: "chat",
          split: "claude-haiku",
          events: 1,
          inputTokens: 2,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          key: "chat",
          split: "claude-opus",
          events: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          key: "workflow",
          split: "claude-opus",
          events: 1,
          inputTokens: 3,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
    });

    test("supports alternate splitBy dimensions and nullable coalescing", () => {
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 1,
        workflowName: "smoke-test",
      });
      store.record({
        source: "workflow",
        provider: "copilot",
        model: "auto",
        inputTokens: 2,
        outputTokens: 2,
      });
      const rows = store.breakdown({ groupBy: "workflow", splitBy: "provider" });
      expect(rows).toEqual([
        expect.objectContaining({ key: "(none)", split: "copilot", events: 1 }),
        expect.objectContaining({ key: "smoke-test", split: "codex", events: 1 }),
      ]);
    });

    test("respects sinceIso", () => {
      store.record({
        ts: "2020-01-01T00:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "old",
        inputTokens: 100,
        outputTokens: 100,
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "workflow",
        provider: "codex",
        model: "new",
        inputTokens: 1,
        outputTokens: 1,
      });
      const rows = store.breakdown({ sinceIso: "2025-01-01T00:00:00.000Z" });
      expect(rows).toEqual([expect.objectContaining({ key: "workflow", split: "new" })]);
    });
  });

  describe("jobs", () => {
    test("groups recurring run spend and excludes chat turns", () => {
      store.record({
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 100,
        outputTokens: 100,
      });
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        runId: "run-1",
        workflowName: "smoke-test",
      });
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 20,
        outputTokens: 5,
        runId: "run-1",
        workflowName: "smoke-test",
      });
      store.record({
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 9,
        runId: "run-2",
        workflowName: "smoke-test",
      });
      const rows = store.jobs();
      expect(rows).toEqual([
        {
          key: "smoke-test",
          runs: 2,
          totalTokens: 50,
          avgTokensPerRun: 25,
          p95TokensPerRun: 40,
        },
      ]);
    });

    test("falls back from workflow to rib to source and respects sinceIso", () => {
      store.record({
        ts: "2020-01-01T00:00:00.000Z",
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 100,
        runId: "old",
        workflowName: "old-job",
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "rib",
        provider: "pi",
        model: "pi-1",
        inputTokens: 3,
        outputTokens: 7,
        ribId: "osdu",
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "rib",
        provider: "pi",
        model: "pi-1",
        inputTokens: 1,
        outputTokens: 9,
        ribId: "osdu",
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 4,
        outputTokens: 6,
        runId: "source-run",
      });
      const rows = store.jobs({ sinceIso: "2025-01-01T00:00:00.000Z" });
      expect(rows).toEqual([
        expect.objectContaining({ key: "osdu", runs: 2, totalTokens: 20 }),
        expect.objectContaining({ key: "workflow", runs: 1, totalTokens: 10 }),
      ]);
    });
  });

  describe("events", () => {
    test("filters by source, model, status, and sinceIso", () => {
      store.record({
        ts: "2020-01-01T00:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 1,
        outputTokens: 1,
        status: "ok",
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "chat",
        provider: "claude",
        model: "claude-opus",
        inputTokens: 2,
        outputTokens: 2,
        status: "error",
      });
      store.record({
        ts: "2030-01-01T00:00:00.000Z",
        source: "workflow",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 3,
        outputTokens: 3,
        status: "ok",
      });

      expect(store.events({ source: "workflow" })).toHaveLength(1);
      expect(store.events({ model: "claude-opus" })).toHaveLength(2);
      expect(store.events({ status: "error" })).toHaveLength(1);
      expect(store.events({ sinceIso: "2025-01-01T00:00:00.000Z" })).toHaveLength(2);
      expect(store.events({})).toHaveLength(3);
    });

    test("respects limit and newest-first order", () => {
      for (let i = 0; i < 5; i++) {
        store.record({
          source: "chat",
          provider: "claude",
          model: "m",
          inputTokens: i,
          outputTokens: 0,
        });
      }
      const limited = store.events({ limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited[0].inputTokens).toBe(4);
      expect(limited[1].inputTokens).toBe(3);
    });
  });

  describe("pulse", () => {
    // Fixed instant so "today" and the trailing-60-minute window are
    // deterministic regardless of when the test runs.
    const now = new Date(2026, 5, 15, 12, 30, 0, 0);

    test("minuteSeries is a zero-filled 60-length series when there are no events", () => {
      const { minuteSeries } = store.pulse(now);
      expect(minuteSeries).toHaveLength(60);
      expect(minuteSeries.every((m) => m.inputTokens === 0 && m.outputTokens === 0)).toBe(true);
      // Oldest bucket first, newest (current minute) last.
      const first = new Date(minuteSeries[0].minuteIso);
      const last = new Date(minuteSeries[59].minuteIso);
      expect(last.getTime() - first.getTime()).toBe(59 * 60_000);
    });

    test("composedTotals sums only today's (local-day) events, including cache tokens", () => {
      store.record({
        ts: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0).toISOString(),
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
      store.record({
        ts: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).toISOString(),
        source: "workflow",
        provider: "codex",
        model: "m",
        inputTokens: 3,
        outputTokens: 7,
      });
      // Yesterday — must not count toward today's composedTotals.
      store.record({
        ts: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 0, 0).toISOString(),
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 100,
        outputTokens: 100,
      });
      const { composedTotals } = store.pulse(now);
      expect(composedTotals).toEqual({
        events: 2,
        inputTokens: 13,
        outputTokens: 12,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
    });

    test("minuteSeries buckets events into their per-minute slot and drops events outside the window", () => {
      const inWindowMinute = new Date(now);
      inWindowMinute.setMinutes(inWindowMinute.getMinutes() - 5, 30, 0);
      store.record({
        ts: inWindowMinute.toISOString(),
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
      });
      // A second event in the same minute — should accumulate, not overwrite.
      const sameMinute = new Date(inWindowMinute);
      sameMinute.setSeconds(45);
      store.record({
        ts: sameMinute.toISOString(),
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      });
      // Older than 60 minutes back — must be excluded from minuteSeries.
      const outOfWindow = new Date(now);
      outOfWindow.setMinutes(outOfWindow.getMinutes() - 90);
      store.record({
        ts: outOfWindow.toISOString(),
        source: "chat",
        provider: "claude",
        model: "m",
        inputTokens: 999,
        outputTokens: 999,
      });

      const { minuteSeries } = store.pulse(now);
      const bucketIso = new Date(inWindowMinute);
      bucketIso.setSeconds(0, 0);
      const bucket = minuteSeries.find((m) => m.minuteIso === bucketIso.toISOString());
      expect(bucket).toEqual({
        minuteIso: bucketIso.toISOString(),
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
      });
      const total = minuteSeries.reduce((sum, m) => sum + m.inputTokens, 0);
      expect(total).toBe(5);
    });
  });
});

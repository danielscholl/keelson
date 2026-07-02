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
});

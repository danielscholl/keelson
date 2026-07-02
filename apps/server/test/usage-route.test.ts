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
import {
  usageBreakdownResponseSchema,
  usageEventsResponseSchema,
  usageSeriesResponseSchema,
  usageSummaryResponseSchema,
} from "@keelson/shared";
import { Hono } from "hono";
import { openDatabase } from "../src/db/init.ts";
import { usageRoutes } from "../src/usage-handler.ts";
import { createUsageStore, type UsageStore } from "../src/usage-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: UsageStore;
let app: Hono;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-usage-route-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  store = createUsageStore(db);
  app = new Hono();
  usageRoutes(app, { store });

  // Fixture rows spanning "now" (within all windows), 10 days back (outside
  // 24h/7d, inside 30d), and 40 days back (outside every window) so the
  // window→sinceIso defaulting is exercised implicitly by each endpoint.
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

  store.record({
    ts: now.toISOString(),
    source: "chat",
    provider: "claude",
    model: "claude-opus",
    inputTokens: 10,
    outputTokens: 5,
    status: "ok",
  });
  store.record({
    ts: tenDaysAgo.toISOString(),
    source: "workflow",
    provider: "codex",
    model: "gpt-5",
    inputTokens: 3,
    outputTokens: 7,
    status: "ok",
    workflowName: "smoke-test",
  });
  store.record({
    ts: fortyDaysAgo.toISOString(),
    source: "rib",
    provider: "pi",
    model: "pi-1",
    inputTokens: 100,
    outputTokens: 100,
    status: "error",
    ribId: "osdu",
  });
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("GET /api/usage/summary", () => {
  test("200 with a schema-valid body, defaulting window to 7d", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/summary"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = usageSummaryResponseSchema.parse(body);
    // 7d default excludes the 10-day-old and 40-day-old rows.
    expect(parsed.totals.events).toBe(1);
  });

  test("30d window picks up the older-but-not-oldest row", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/summary?window=30d"));
    expect(res.status).toBe(200);
    const parsed = usageSummaryResponseSchema.parse(await res.json());
    expect(parsed.totals.events).toBe(2);
  });

  test("400 on a bad window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/summary?window=bogus"));
    expect(res.status).toBe(400);
  });

  test("400 on a bad groupBy", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/summary?groupBy=bogus"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/usage/series", () => {
  test("200 with a schema-valid body, bucketing by hour under the 24h window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series?window=24h"));
    expect(res.status).toBe(200);
    const parsed = usageSeriesResponseSchema.parse(await res.json());
    expect(parsed.length).toBeGreaterThan(0);
    for (const row of parsed) {
      expect(row.bucketIso.endsWith(":00.000Z") || row.bucketIso.endsWith(":00:00.000Z")).toBe(
        true,
      );
    }
  });

  test("200 with a schema-valid body, bucketing by day under the default 7d window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series"));
    expect(res.status).toBe(200);
    const parsed = usageSeriesResponseSchema.parse(await res.json());
    for (const row of parsed) {
      expect(row.bucketIso.endsWith("T00:00:00.000Z")).toBe(true);
    }
  });

  test("an explicit bucket overrides the window-derived default", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series?window=30d&bucket=hour"));
    expect(res.status).toBe(200);
    const parsed = usageSeriesResponseSchema.parse(await res.json());
    for (const row of parsed) {
      expect(row.bucketIso.endsWith(":00.000Z")).toBe(true);
    }
  });

  test("400 on a bad window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series?window=bogus"));
    expect(res.status).toBe(400);
  });

  test("400 on a bad bucket", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series?bucket=bogus"));
    expect(res.status).toBe(400);
  });

  test("400 on a bad groupBy", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/series?groupBy=bogus"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/usage/breakdown", () => {
  test("200 with a schema-valid source x model matrix", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/breakdown?window=30d"));
    expect(res.status).toBe(200);
    const parsed = usageBreakdownResponseSchema.parse(await res.json());
    expect(parsed).toContainEqual(expect.objectContaining({ source: "workflow", model: "gpt-5" }));
  });

  test("400 on a bad window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/breakdown?window=bogus"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/usage/events", () => {
  test("200 with a schema-valid ledger tail, defaulting window to 7d", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events"));
    expect(res.status).toBe(200);
    const parsed = usageEventsResponseSchema.parse(await res.json());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ source: "chat", model: "claude-opus" });
  });

  test("filters by source within the requested window", async () => {
    const res = await app.fetch(
      new Request("http://test/api/usage/events?window=30d&source=workflow"),
    );
    expect(res.status).toBe(200);
    const parsed = usageEventsResponseSchema.parse(await res.json());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].workflowName).toBe("smoke-test");
  });

  test("200 at the limit cap boundary", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events?limit=500"));
    expect(res.status).toBe(200);
  });

  test("400 on a limit past the 500 cap", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events?limit=100000"));
    expect(res.status).toBe(400);
  });

  test("400 on a bad window", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events?window=bogus"));
    expect(res.status).toBe(400);
  });

  test("400 on an invalid events filter (bad source enum)", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events?source=bogus"));
    expect(res.status).toBe(400);
  });

  test("400 on an invalid events filter (negative limit)", async () => {
    const res = await app.fetch(new Request("http://test/api/usage/events?limit=-1"));
    expect(res.status).toBe(400);
  });
});

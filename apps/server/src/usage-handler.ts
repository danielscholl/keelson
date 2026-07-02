// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  usageBreakdownResponseSchema,
  usageEventsResponseSchema,
  usageSeriesResponseSchema,
  usageSummaryResponseSchema,
} from "@keelson/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type {
  UsageEventSource,
  UsageGroupBy,
  UsageSeriesBucket,
  UsageStore,
} from "./usage-store.ts";

export interface UsageRoutesDeps {
  store: UsageStore;
}

const WINDOW_MS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const windowSchema = z.enum(["24h", "7d", "30d"]).default("7d");

// Since `window` picks the lookback horizon, sinceIso is derived from it
// rather than accepted as a separate param — one less way for a caller to
// send an inconsistent (window, sinceIso) pair.
function windowToSinceIso(window: "24h" | "7d" | "30d"): string {
  return new Date(Date.now() - WINDOW_MS[window]).toISOString();
}

const groupBySchema: z.ZodType<UsageGroupBy> = z.enum([
  "model",
  "provider",
  "source",
  "rib",
  "workflow",
]);

const bucketSchema: z.ZodType<UsageSeriesBucket> = z.enum(["hour", "day"]);

const eventSourceSchema: z.ZodType<UsageEventSource> = z.enum(["chat", "workflow", "rib"]);

const summaryQuerySchema = z
  .object({
    window: windowSchema,
    groupBy: groupBySchema.default("model"),
  })
  .strict();

const seriesQuerySchema = z
  .object({
    window: windowSchema,
    groupBy: groupBySchema.default("model"),
    bucket: bucketSchema.optional(),
  })
  .strict();

const breakdownQuerySchema = z
  .object({
    window: windowSchema,
  })
  .strict();

const eventsQuerySchema = z
  .object({
    window: windowSchema,
    limit: z.coerce.number().int().nonnegative().optional(),
    source: eventSourceSchema.optional(),
    model: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

// window=24h charts by hour, else by day — mirrors the horizon a user picks:
// a day's worth of hourly buckets is legible, a month of hourly buckets isn't.
function resolveBucket(window: "24h" | "7d" | "30d", explicit: UsageSeriesBucket | undefined) {
  return explicit ?? (window === "24h" ? "hour" : "day");
}

export function usageRoutes(app: Hono, deps: UsageRoutesDeps): void {
  const { store } = deps;

  app.get("/api/usage/summary", (c) => {
    const parsed = summaryQuerySchema.safeParse({
      window: c.req.query("window"),
      groupBy: c.req.query("groupBy"),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const sinceIso = windowToSinceIso(parsed.data.window);
    const result = usageSummaryResponseSchema.parse(
      store.summary({ sinceIso, groupBy: parsed.data.groupBy }),
    );
    return c.json(result);
  });

  app.get("/api/usage/series", (c) => {
    const parsed = seriesQuerySchema.safeParse({
      window: c.req.query("window"),
      groupBy: c.req.query("groupBy"),
      bucket: c.req.query("bucket"),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const sinceIso = windowToSinceIso(parsed.data.window);
    const bucket = resolveBucket(parsed.data.window, parsed.data.bucket);
    const result = usageSeriesResponseSchema.parse(
      store.series({ sinceIso, bucket, groupBy: parsed.data.groupBy }),
    );
    return c.json(result);
  });

  app.get("/api/usage/breakdown", (c) => {
    const parsed = breakdownQuerySchema.safeParse({
      window: c.req.query("window"),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const sinceIso = windowToSinceIso(parsed.data.window);
    const result = usageBreakdownResponseSchema.parse(store.breakdown({ sinceIso }));
    return c.json(result);
  });

  app.get("/api/usage/events", (c) => {
    const parsed = eventsQuerySchema.safeParse({
      window: c.req.query("window"),
      limit: c.req.query("limit"),
      source: c.req.query("source"),
      model: c.req.query("model"),
      status: c.req.query("status"),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const sinceIso = windowToSinceIso(parsed.data.window);
    const result = usageEventsResponseSchema.parse(
      store.events({
        sinceIso,
        limit: parsed.data.limit,
        source: parsed.data.source,
        model: parsed.data.model,
        status: parsed.data.status,
      }),
    );
    return c.json(result);
  });
}

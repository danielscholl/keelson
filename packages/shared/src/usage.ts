// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// The harness-owned snapshot key the usage pulse widget subscribes to: a
// minute-resolution rollup republished on the base snapshot manager, mirroring
// RIBS_VERSION_SNAPSHOT_KEY's not-under-a-`rib:*`-namespace convention.
export const USAGE_PULSE_SNAPSHOT_KEY = "keelson:usage:pulse";

export const usageEventSourceSchema = z.enum(["chat", "workflow", "rib"]);
export type UsageEventSourceWire = z.infer<typeof usageEventSourceSchema>;

export const usageEventStatusSchema = z.enum(["ok", "error", "aborted", "timeout"]);
export type UsageEventStatusWire = z.infer<typeof usageEventStatusSchema>;

export const usageGroupBySchema = z.enum([
  "model",
  "provider",
  "source",
  "rib",
  "workflow",
  "sourceDetail",
]);
export type UsageGroupByWire = z.infer<typeof usageGroupBySchema>;

// Aggregated token counts shared by the summary/series/breakdown responses.
// These are COALESCE'd SUM(...) results, so unlike the per-event ledger row
// they're always non-negative integers, never null.
export const usageTotalsSchema = z
  .object({
    events: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
  })
  .strict();
export type UsageTotalsWire = z.infer<typeof usageTotalsSchema>;

// Derived at read time from token counts and the price table, never stored, so
// a price correction reprices history. `costUsd` is null when any contributing
// event's model has no price (`unpricedEvents` says how many), while
// `pricedCostUsd` always carries the cost of the events that were priced, a
// floor on the true total; `cacheHitRatio`
// is cacheRead / (input + cacheRead + cacheWrite), null when no event reported
// cache reads or the denominator is zero. Neither ever degrades to a fabricated
// zero. `pricedCostByTypeUsd` splits `pricedCostUsd` by the token type that
// incurred it.
export const usageCostByTypeSchema = z
  .object({
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    output: z.number().nonnegative(),
  })
  .strict();
export type UsageCostByTypeWire = z.infer<typeof usageCostByTypeSchema>;

export const usageCostFieldsSchema = z
  .object({
    costUsd: z.number().nonnegative().nullable(),
    pricedCostUsd: z.number().nonnegative(),
    pricedCostByTypeUsd: usageCostByTypeSchema,
    unpricedEvents: z.number().int().nonnegative(),
    cacheHitRatio: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type UsageCostFieldsWire = z.infer<typeof usageCostFieldsSchema>;

export const usagePricedTotalsSchema = usageTotalsSchema
  .extend(usageCostFieldsSchema.shape)
  .strict();
export type UsagePricedTotalsWire = z.infer<typeof usagePricedTotalsSchema>;

// The rates (USD per 1M tokens) a provider/model's turns were priced at, and
// where they came from.
export const usagePriceCardSchema = z
  .object({
    provider: z.string(),
    source: z.enum(["override", "catalog", "bundled"]),
    inputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative(),
    cacheWritePerMTok: z.number().nonnegative(),
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
    outputPerMTok: z.number().nonnegative(),
  })
  .strict();
export type UsagePriceCardWire = z.infer<typeof usagePriceCardSchema>;

// (a) GET /api/usage/summary — overall totals plus a per-group (source,
// provider, model, etc. — grouping is a query param) breakdown. `priceCards`
// lists each distinct card the row's priced turns used.
export const usageGroupRowSchema = usagePricedTotalsSchema
  .extend({
    key: z.string(),
    priceCards: z.array(usagePriceCardSchema),
  })
  .strict();
export type UsageGroupRowWire = z.infer<typeof usageGroupRowSchema>;

export const usageSummaryResponseSchema = z
  .object({
    totals: usagePricedTotalsSchema.extend({ priceCards: z.array(usagePriceCardSchema) }).strict(),
    groups: z.array(usageGroupRowSchema),
  })
  .strict();
export type UsageSummaryResponseWire = z.infer<typeof usageSummaryResponseSchema>;

// (b) GET /api/usage/series — time-bucketed totals per group, for charting.
export const usageSeriesRowSchema = usagePricedTotalsSchema
  .extend({
    bucketIso: z.string(),
    key: z.string(),
  })
  .strict();
export type UsageSeriesRowWire = z.infer<typeof usageSeriesRowSchema>;

export const usageSeriesResponseSchema = z.array(usageSeriesRowSchema);
export type UsageSeriesResponseWire = z.infer<typeof usageSeriesResponseSchema>;

// (c) GET /api/usage/breakdown — a groupBy x splitBy matrix; defaults to source x model.
export const usageBreakdownRowSchema = usagePricedTotalsSchema
  .extend({
    key: z.string(),
    split: z.string(),
  })
  .strict();
export type UsageBreakdownRowWire = z.infer<typeof usageBreakdownRowSchema>;

export const usageBreakdownResponseSchema = z.array(usageBreakdownRowSchema);
export type UsageBreakdownResponseWire = z.infer<typeof usageBreakdownResponseSchema>;

// (d) GET /api/usage/jobs — recurring workflow/rib spend grouped by job.
export const usageJobsRowSchema = z
  .object({
    key: z.string(),
    runs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    avgTokensPerRun: z.number().nonnegative(),
    p95TokensPerRun: z.number().nonnegative(),
    // Same null rules as usageCostFieldsSchema; a job with one unpriced run
    // has no honest total, so both cost fields go null together.
    totalCostUsd: z.number().nonnegative().nullable(),
    pricedTotalCostUsd: z.number().nonnegative(),
    costUsdPerRun: z.number().nonnegative().nullable(),
    pricedEvents: z.number().int().nonnegative(),
    unpricedEvents: z.number().int().nonnegative(),
    cacheHitRatio: z.number().min(0).max(1).nullable(),
    // Events recorded without a run id; each one counts as its own run above,
    // so a job with any is measured in turns rather than runs.
    eventsWithoutRun: z.number().int().nonnegative(),
    // The model that incurred the most priced cost (most events when nothing
    // was priced), and its share of the job's priced cost.
    mainModel: z.string().nullable(),
    mainModelCostShare: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type UsageJobsRowWire = z.infer<typeof usageJobsRowSchema>;

export const usageJobsResponseSchema = z.array(usageJobsRowSchema);
export type UsageJobsResponseWire = z.infer<typeof usageJobsResponseSchema>;

// (e) GET /api/usage/events — a ledger tail, camelCase mirror of the
// usage_events row (apps/server/src/usage-store.ts's UsageEvent). Cache
// tokens/duration/attribution columns stay nullable: "not reported" is
// distinct from "reported as zero" there, unlike the aggregated rows above.
export const usageEventRowSchema = z
  .object({
    id: z.number().int().nonnegative(),
    ts: z.string(),
    source: usageEventSourceSchema,
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    // Priced at read time from this row's counts; null when the model has no price.
    costUsd: z.number().nonnegative().nullable(),
    priceCard: usagePriceCardSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    // Read-side stays open: the ledger is append-only history, so rows written
    // by another writer version must render, not 500 the whole tail. The
    // closed enum governs writers only.
    status: z.string().min(1),
    conversationId: z.string().nullable(),
    runId: z.string().nullable(),
    nodeId: z.string().nullable(),
    workflowName: z.string().nullable(),
    ribId: z.string().nullable(),
    projectId: z.string().nullable(),
  })
  .strict();
export type UsageEventRowWire = z.infer<typeof usageEventRowSchema>;

export const usageEventsResponseSchema = z.array(usageEventRowSchema);
export type UsageEventsResponseWire = z.infer<typeof usageEventsResponseSchema>;

// The per-minute rollup carried in the pulse snapshot's `minuteSeries`.
export const usagePulseMinuteSchema = usageTotalsSchema
  .omit({ events: true })
  .extend({
    minuteIso: z.string(),
  })
  .strict();
export type UsagePulseMinuteWire = z.infer<typeof usagePulseMinuteSchema>;

// Payload published under USAGE_PULSE_SNAPSHOT_KEY: today's running totals
// plus the last 60 minutes of per-minute token counts, for a live sparkline.
export const usagePulseSnapshotSchema = z
  .object({
    composedTotals: usageTotalsSchema,
    minuteSeries: z.array(usagePulseMinuteSchema),
  })
  .strict();
export type UsagePulseSnapshotWire = z.infer<typeof usagePulseSnapshotSchema>;

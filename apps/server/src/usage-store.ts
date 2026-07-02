// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import type {
  UsageBreakdownRowWire,
  UsageEventRowWire,
  UsagePulseMinuteWire,
  UsagePulseSnapshotWire,
  UsageSeriesRowWire,
  UsageSummaryResponseWire,
} from "@keelson/shared";

export type UsageEventSource = "chat" | "workflow" | "rib";

export interface RecordUsageEventInput {
  // ISO timestamp. Omitted → captured at record() time.
  ts?: string;
  source: UsageEventSource;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  durationMs?: number | null;
  // Omitted → 'ok'.
  status?: string;
  conversationId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  workflowName?: string | null;
  ribId?: string | null;
  projectId?: string | null;
}

export interface UsageEvent {
  id: number;
  ts: string;
  source: UsageEventSource;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number | null;
  status: string;
  conversationId: string | null;
  runId: string | null;
  nodeId: string | null;
  workflowName: string | null;
  ribId: string | null;
  projectId: string | null;
}

export interface ListUsageEventsFilter {
  limit?: number;
  source?: UsageEventSource;
}

export interface UsageTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
}

// Attribution columns (rib_id, workflow_name) are nullable; grouping by them
// buckets ungrouped rows under this literal key rather than dropping them.
export const UNGROUPED_KEY = "(none)";

export type UsageGroupBy = "model" | "provider" | "source" | "rib" | "workflow";
export type UsageSeriesBucket = "hour" | "day";

export interface UsageSummaryArgs {
  sinceIso?: string;
  groupBy: UsageGroupBy;
}

export interface UsageSeriesArgs {
  sinceIso?: string;
  bucket: UsageSeriesBucket;
  groupBy: UsageGroupBy;
}

export interface UsageBreakdownArgs {
  sinceIso?: string;
}

export interface UsageEventsFilter {
  limit?: number;
  source?: UsageEventSource;
  model?: string;
  status?: string;
  sinceIso?: string;
}

export interface UsageStore {
  record(input: RecordUsageEventInput): void;
  listEvents(filter?: ListUsageEventsFilter): UsageEvent[];
  totals(args?: { sinceIso?: string }): UsageTotals;
  summary(args: UsageSummaryArgs): UsageSummaryResponseWire;
  series(args: UsageSeriesArgs): UsageSeriesRowWire[];
  breakdown(args?: UsageBreakdownArgs): UsageBreakdownRowWire[];
  events(filter?: UsageEventsFilter): UsageEventRowWire[];
  // Backs USAGE_PULSE_SNAPSHOT_KEY: today's (local-day) running totals plus a
  // zero-filled per-minute series over the trailing 60 minutes. `now` is
  // injectable for tests; defaults to the wall clock.
  pulse(now?: Date): UsagePulseSnapshotWire;
}

interface UsageEventRow {
  id: number;
  ts: string;
  source: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  duration_ms: number | null;
  status: string;
  conversation_id: string | null;
  run_id: string | null;
  node_id: string | null;
  workflow_name: string | null;
  rib_id: string | null;
  project_id: string | null;
}

function rowToEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source as UsageEventSource,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    durationMs: row.duration_ms,
    status: row.status,
    conversationId: row.conversation_id,
    runId: row.run_id,
    nodeId: row.node_id,
    workflowName: row.workflow_name,
    ribId: row.rib_id,
    projectId: row.project_id,
  };
}

// Floors a non-negative finite number, mirroring @keelson/shared's
// coerceTokenUsage count() convention; anything else (negative, NaN,
// missing) falls back to `fallback` rather than persisting a malformed count.
function floorCount(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

// Same flooring rule as floorCount but for nullable columns (cache tokens,
// duration) where "not reported" (null) is distinct from "reported as zero".
function floorNullableCount(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

// groupBy is always one of the fixed UsageGroupBy literals, never
// user-supplied SQL, so interpolating the resolved column name is safe.
const GROUP_BY_COLUMN: Record<UsageGroupBy, string> = {
  model: "model",
  provider: "provider",
  source: "source",
  rib: "rib_id",
  workflow: "workflow_name",
};

const TOTALS_SELECT = `
  COUNT(*) AS events,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
`;

interface TotalsRow {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface GroupRow extends TotalsRow {
  key: string;
}

interface SeriesRow extends TotalsRow {
  bucketIso: string;
  key: string;
}

interface BreakdownRow extends TotalsRow {
  source: string;
  model: string;
}

interface MinuteRow extends Omit<TotalsRow, "events"> {
  minuteIso: string;
}

// Floors `d` to the start of its UTC minute, matching the strftime bucket
// query below — a minute bucket is the same instant regardless of timezone.
function minuteFloor(d: Date): Date {
  const floored = new Date(d);
  floored.setUTCSeconds(0, 0);
  return floored;
}

// "Today" for the pulse's composedTotals is the server's LOCAL calendar day,
// per the spec — distinct from the UTC-bucketed minuteSeries below.
function startOfLocalDayIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
}

export function createUsageStore(db: Database): UsageStore {
  const insertEvent = db.prepare(
    `INSERT INTO usage_events(
       ts, source, provider, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, duration_ms, status,
       conversation_id, run_id, node_id, workflow_name, rib_id, project_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listAll = db.prepare("SELECT * FROM usage_events ORDER BY ts DESC, id DESC LIMIT ?");
  const listBySource = db.prepare(
    "SELECT * FROM usage_events WHERE source = ? ORDER BY ts DESC, id DESC LIMIT ?",
  );
  const totalsAll = db.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens FROM usage_events",
  );
  const totalsSince = db.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens FROM usage_events WHERE ts >= ?",
  );
  const pulseTotalsSince = db.prepare(`SELECT ${TOTALS_SELECT} FROM usage_events WHERE ts >= ?`);
  const pulseMinuteRows = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:00.000Z', ts) AS minuteIso,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
       FROM usage_events
      WHERE ts >= ?
      GROUP BY minuteIso`,
  );

  return {
    record(input) {
      insertEvent.run(
        input.ts ?? new Date().toISOString(),
        input.source,
        input.provider,
        input.model,
        floorCount(input.inputTokens, 0),
        floorCount(input.outputTokens, 0),
        floorNullableCount(input.cacheReadTokens),
        floorNullableCount(input.cacheWriteTokens),
        floorNullableCount(input.durationMs),
        input.status ?? "ok",
        input.conversationId ?? null,
        input.runId ?? null,
        input.nodeId ?? null,
        input.workflowName ?? null,
        input.ribId ?? null,
        input.projectId ?? null,
      );
    },
    listEvents(filter = {}) {
      const limit =
        filter.limit !== undefined && filter.limit >= 0 ? Math.floor(filter.limit) : 100;
      const rows = (
        filter.source !== undefined ? listBySource.all(filter.source, limit) : listAll.all(limit)
      ) as UsageEventRow[];
      return rows.map(rowToEvent);
    },
    totals(args = {}) {
      const row = (
        args.sinceIso !== undefined ? totalsSince.get(args.sinceIso) : totalsAll.get()
      ) as { events: number; inputTokens: number; outputTokens: number };
      return row;
    },
    summary(args) {
      const column = GROUP_BY_COLUMN[args.groupBy];
      const clauses: string[] = [];
      const params: Array<string> = [];
      if (args.sinceIso !== undefined) {
        clauses.push("ts >= ?");
        params.push(args.sinceIso);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const totalsRow = db
        .query(`SELECT ${TOTALS_SELECT} FROM usage_events ${where}`)
        .get(...params) as TotalsRow;
      const groupRows = db
        .query(
          `SELECT COALESCE(${column}, '${UNGROUPED_KEY}') AS key, ${TOTALS_SELECT}
             FROM usage_events ${where}
             GROUP BY key
             ORDER BY key ASC`,
        )
        .all(...params) as GroupRow[];
      return { totals: totalsRow, groups: groupRows };
    },
    series(args) {
      const column = GROUP_BY_COLUMN[args.groupBy];
      const strftimeFormat =
        args.bucket === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";
      const clauses: string[] = [];
      const params: Array<string> = [];
      if (args.sinceIso !== undefined) {
        clauses.push("ts >= ?");
        params.push(args.sinceIso);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .query(
          `SELECT strftime('${strftimeFormat}', ts) AS bucketIso,
                  COALESCE(${column}, '${UNGROUPED_KEY}') AS key, ${TOTALS_SELECT}
             FROM usage_events ${where}
             GROUP BY bucketIso, key
             ORDER BY bucketIso ASC, key ASC`,
        )
        .all(...params) as SeriesRow[];
      return rows;
    },
    breakdown(args = {}) {
      const clauses: string[] = [];
      const params: Array<string> = [];
      if (args.sinceIso !== undefined) {
        clauses.push("ts >= ?");
        params.push(args.sinceIso);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .query(
          `SELECT source, model, ${TOTALS_SELECT}
             FROM usage_events ${where}
             GROUP BY source, model
             ORDER BY source ASC, model ASC`,
        )
        .all(...params) as BreakdownRow[];
      return rows as UsageBreakdownRowWire[];
    },
    events(filter = {}) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.source !== undefined) {
        clauses.push("source = ?");
        params.push(filter.source);
      }
      if (filter.model !== undefined) {
        clauses.push("model = ?");
        params.push(filter.model);
      }
      if (filter.status !== undefined) {
        clauses.push("status = ?");
        params.push(filter.status);
      }
      if (filter.sinceIso !== undefined) {
        clauses.push("ts >= ?");
        params.push(filter.sinceIso);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit =
        filter.limit !== undefined && filter.limit >= 0 ? Math.floor(filter.limit) : 100;
      params.push(limit);
      const rows = db
        .query(`SELECT * FROM usage_events ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(...params) as UsageEventRow[];
      return rows.map(rowToEvent) as UsageEventRowWire[];
    },
    pulse(now = new Date()) {
      const composedTotals = pulseTotalsSince.get(startOfLocalDayIso(now)) as TotalsRow;

      const currentMinute = minuteFloor(now);
      const windowStart = new Date(currentMinute);
      windowStart.setUTCMinutes(windowStart.getUTCMinutes() - 59);
      const rows = pulseMinuteRows.all(windowStart.toISOString()) as MinuteRow[];
      const byMinute = new Map(rows.map((row) => [row.minuteIso, row]));

      const minuteSeries: UsagePulseMinuteWire[] = [];
      const cursor = new Date(windowStart);
      for (let i = 0; i < 60; i++) {
        const minuteIso = cursor.toISOString();
        const row = byMinute.get(minuteIso);
        minuteSeries.push({
          minuteIso,
          inputTokens: row?.inputTokens ?? 0,
          outputTokens: row?.outputTokens ?? 0,
          cacheReadTokens: row?.cacheReadTokens ?? 0,
          cacheWriteTokens: row?.cacheWriteTokens ?? 0,
        });
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      }

      return { composedTotals, minuteSeries };
    },
  };
}

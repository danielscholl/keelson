// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";

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

export interface UsageStore {
  record(input: RecordUsageEventInput): void;
  listEvents(filter?: ListUsageEventsFilter): UsageEvent[];
  totals(args?: { sinceIso?: string }): UsageTotals;
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
  };
}

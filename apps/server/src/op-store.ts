// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import type { OpFrameKind } from "@keelson/shared";

export type OpStatus = "running" | "done" | "error" | "cancelled" | "orphaned";

// Bound the durable tables: keep every active op plus the most recent terminal
// ops (op_events cascade-delete with their op). A rib registering an op per task
// would otherwise grow the ops table forever.
const OP_TERMINAL_RETENTION = 1000;

export interface OpRecord {
  id: string;
  kind: string;
  title: string | null;
  owner: string;
  projectId: string | null;
  status: OpStatus;
  steerable: boolean;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OpEventRecord {
  seq: number;
  kind: OpFrameKind;
  message: string | null;
  data: unknown;
  createdAt: string;
}

export interface CreateOpParams {
  id: string;
  kind: string;
  title?: string | null;
  owner: string;
  projectId?: string | null;
  steerable: boolean;
  createdAt: string;
}

export interface AppendOpEvent {
  kind: OpFrameKind;
  message?: string;
  data?: unknown;
}

export interface SetTerminalOptions {
  result?: unknown;
  error?: string;
}

export interface OpStore {
  create(params: CreateOpParams): void;
  get(id: string): OpRecord | undefined;
  // Newest first. Pass a status filter to bound the result (run_list wants only
  // `running` native ops — a terminal-op history would grow unbounded).
  list(filter?: { status?: OpStatus }): OpRecord[];
  // Append one frame with a per-op monotonic seq; returns that seq.
  appendEvent(opId: string, frame: AppendOpEvent, at: string): number;
  // Append a terminal frame AND flip the row to `status` in a single transaction
  // (crash-atomic — never a durable terminal frame with a still-'running' row).
  settle(
    id: string,
    status: OpStatus,
    frame: AppendOpEvent,
    at: string,
    opts?: SetTerminalOptions,
  ): number;
  // Frames with seq > cursor, in order — cursor-based polling for run_events.
  // `limit` bounds the SQL read so a long backlog can't be materialized at once.
  listEvents(opId: string, cursor: number, limit?: number): OpEventRecord[];
  // Highest seq for an op (0 if none) — a cheap MAX(seq) so the poll hot path
  // need not load the whole event log just to report the cursor ceiling.
  lastSeq(opId: string): number;
  setTerminal(id: string, status: OpStatus, at: string, opts?: SetTerminalOptions): void;
}

interface OpRow {
  id: string;
  kind: string;
  title: string | null;
  owner: string;
  project_id: string | null;
  status: string;
  steerable: number;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface OpEventRow {
  seq: number;
  kind: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

function safeParse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Frame data / op results are `unknown` at the contract boundary. A cyclic value
// or a BigInt would make JSON.stringify throw — which, on a terminal write, would
// leave the op stuck 'running'. Never throw: fall back to a valid-JSON placeholder.
function safeStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return '"[unserializable value]"';
  }
}

function rowToRecord(row: OpRow): OpRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    owner: row.owner,
    projectId: row.project_id,
    status: row.status as OpStatus,
    steerable: row.steerable === 1,
    result: safeParse(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function createOpStore(db: Database): OpStore {
  // Boot-time reconcile: a row still 'running' belongs to a prior process whose
  // in-memory controller (AbortController / onSteer) is gone. Flip it to
  // 'orphaned' so run_status can never report it running and run_cancel/run_steer
  // fail cleanly (no live controller). Mirrors the workflow-store boot sweep.
  // strftime(...'%f'...) yields the ISO-8601 `YYYY-MM-DDTHH:MM:SS.SSSZ` shape that
  // new Date().toISOString() (every other write path) produces — a plain
  // datetime('now') would emit a space-separated, timezone-less string that a
  // parsing consumer reads as local time.
  db.exec(
    `UPDATE ops
       SET status = 'orphaned',
           completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE status = 'running';`,
  );

  const insertStmt = db.prepare(
    `INSERT INTO ops(id, kind, title, owner, project_id, status, steerable, result_json, error, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL)`,
  );
  const getStmt = db.prepare(
    `SELECT id, kind, title, owner, project_id, status, steerable, result_json, error, created_at, updated_at, completed_at
     FROM ops WHERE id = ?`,
  );
  const OP_COLUMNS =
    "id, kind, title, owner, project_id, status, steerable, result_json, error, created_at, updated_at, completed_at";
  const listStmt = db.prepare(`SELECT ${OP_COLUMNS} FROM ops ORDER BY created_at DESC, id ASC`);
  // Uses ix_ops_status_created (status, created_at DESC).
  const listByStatusStmt = db.prepare(
    `SELECT ${OP_COLUMNS} FROM ops WHERE status = ? ORDER BY created_at DESC, id ASC`,
  );
  const nextSeqStmt = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM op_events WHERE op_id = ?",
  );
  const lastSeqStmt = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS last FROM op_events WHERE op_id = ?",
  );
  const insertEventStmt = db.prepare(
    `INSERT INTO op_events(op_id, seq, kind, message, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const listEventsStmt = db.prepare(
    `SELECT seq, kind, message, data_json, created_at
     FROM op_events WHERE op_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  );
  const setTerminalStmt = db.prepare(
    `UPDATE ops
       SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  );
  // Keep active ops + the most recent terminal ops; older terminal rows (and
  // their cascaded op_events) are pruned so the tables stay bounded.
  const pruneStmt = db.prepare(
    `DELETE FROM ops
       WHERE status != 'running'
         AND id NOT IN (
           SELECT id FROM ops WHERE status != 'running'
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
  );
  pruneStmt.run(OP_TERMINAL_RETENTION);

  const appendEventRow = (opId: string, frame: AppendOpEvent, at: string): number => {
    const seq = (nextSeqStmt.get(opId) as { next: number }).next;
    insertEventStmt.run(
      opId,
      seq,
      frame.kind,
      frame.message ?? null,
      safeStringify(frame.data),
      at,
    );
    return seq;
  };
  const setTerminalRow = (
    id: string,
    status: OpStatus,
    at: string,
    opts?: SetTerminalOptions,
  ): void => {
    setTerminalStmt.run(status, safeStringify(opts?.result), opts?.error ?? null, at, at, id);
    // Prune on every terminal transition too, not just on create — a burst of ops
    // that all settle without a fresh create would otherwise stay over the bound.
    pruneStmt.run(OP_TERMINAL_RETENTION);
  };
  const appendTxn = db.transaction(appendEventRow);
  // One transaction so a crash can't leave a durable terminal frame with the row
  // still 'running' (which boot reconcile would flip to 'orphaned', losing the
  // result). The terminal frame and the row transition settle together.
  const settleTxn = db.transaction(
    (id: string, status: OpStatus, frame: AppendOpEvent, at: string, opts?: SetTerminalOptions) => {
      const seq = appendEventRow(id, frame, at);
      setTerminalRow(id, status, at, opts);
      return seq;
    },
  );

  return {
    create(params) {
      insertStmt.run(
        params.id,
        params.kind,
        params.title ?? null,
        params.owner,
        params.projectId ?? null,
        params.steerable ? 1 : 0,
        params.createdAt,
        params.createdAt,
      );
      // Bound the tables continuously, not just at boot.
      pruneStmt.run(OP_TERMINAL_RETENTION);
    },
    get(id) {
      const row = getStmt.get(id) as OpRow | null;
      return row ? rowToRecord(row) : undefined;
    },
    list(filter) {
      const rows = (
        filter?.status ? listByStatusStmt.all(filter.status) : listStmt.all()
      ) as OpRow[];
      return rows.map(rowToRecord);
    },
    appendEvent(opId, frame, at) {
      return appendTxn(opId, frame, at);
    },
    settle(id, status, frame, at, opts) {
      return settleTxn(id, status, frame, at, opts);
    },
    lastSeq(opId) {
      return (lastSeqStmt.get(opId) as { last: number }).last;
    },
    listEvents(opId, cursor, limit = 1_000_000) {
      const rows = listEventsStmt.all(opId, cursor, limit) as OpEventRow[];
      return rows.map((row) => ({
        seq: row.seq,
        kind: row.kind as OpFrameKind,
        message: row.message,
        data: safeParse(row.data_json),
        createdAt: row.created_at,
      }));
    },
    setTerminal(id, status, at, opts) {
      setTerminalRow(id, status, at, opts);
    },
  };
}

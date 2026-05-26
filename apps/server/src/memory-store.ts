// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import {
  type Memory,
  RECALL_RESPONSE_SCHEMA_VERSION,
  REVIEW_LIST_DEFAULT_LIMIT,
  REVIEW_LIST_MAX_LIMIT,
  type RecallItem,
  type RecallRequest,
  type RecallResponse,
  type ReviewActionRequest,
  type ReviewItem,
  type ReviewListQuery,
  type ReviewListResponse,
  type SourceRef,
  WRITEBACK_RESPONSE_SCHEMA_VERSION,
  type WritebackRequest,
  type WritebackResponse,
} from "@keelson/shared";
import { evaluateDraft } from "./memory-guardrails.ts";

export interface MemoryStore {
  recall(req: RecallRequest): RecallResponse;
  writeback(req: WritebackRequest): WritebackResponse;
  // Returns { applied: false } when memoryId is unknown — silent no-op,
  // matches ConversationStore.delete posture so callers don't need try/catch.
  confirm(input: ReviewActionRequest): { applied: boolean };
  // Pending review queue. Cursor encodes (createdAt, id) so concurrent
  // writebacks during pagination don't shuffle pages.
  listPending(query: ReviewListQuery): ReviewListResponse;
  // Debug/test helper. Returns the full Memory shape including storage-
  // internal fields (idempotencyKey, contentHash) that the wire projections
  // trim. Not surfaced over the wire — recall and the review queue read
  // through their trimmed shapes; this method exists only for tests and
  // direct script use.
  getById(id: string): Memory | undefined;
}

interface MemoryRow {
  id: string;
  type: string;
  summary: string;
  content: string;
  provenance: string;
  use_policy_can_use_as_instruction: number;
  use_policy_can_use_as_evidence: number;
  use_policy_requires_user_confirmation: number;
  use_policy_do_not_inject_automatically: number;
  scope_project_id: string | null;
  scope_visibility: string;
  lifecycle: string;
  review_status: string;
  content_hash: string;
  idempotency_key: string;
  confidence: number | null;
  runtime: string;
  task_id: string | null;
  flow_id: string | null;
  model: string | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
  stale_after: string | null;
}

interface RecallRow extends MemoryRow {
  bm25_score: number;
}

interface SourceRefRow {
  memory_id: string;
  kind: string;
  identifier: string;
  url: string | null;
}

interface ArtifactRow {
  memory_id: string;
  kind: string;
  content: string;
}

// Split on non-letter/digit codepoints (Unicode-aware) so path separators
// become token boundaries and FTS5 operators in user input are stripped.
// Quoted tokens joined with OR for recall-oriented matching.
function buildFtsQuery(raw: string): string {
  const tokens = raw.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function daysSince(iso: string): number {
  const created = Date.parse(iso);
  if (Number.isNaN(created)) return 0;
  const ms = Date.now() - created;
  return Math.max(0, ms / 86_400_000);
}

// Half-life ~30 days: a result from a month ago scores half what an identical
// result from today would. Pulled from the PRD's BM25 + recency formulation.
function recencyDecay(days: number): number {
  return 1 / (1 + days / 30);
}

function rowToMemory(
  row: MemoryRow,
  sourceRefs: SourceRef[],
  artifacts: Memory["artifacts"],
): Memory {
  const usePolicy = {
    canUseAsInstruction: row.use_policy_can_use_as_instruction === 1,
    canUseAsEvidence: row.use_policy_can_use_as_evidence === 1,
    requiresUserConfirmation: row.use_policy_requires_user_confirmation === 1,
    doNotInjectAutomatically: row.use_policy_do_not_inject_automatically === 1,
  };
  const scope: Memory["scope"] = {
    visibility: row.scope_visibility as Memory["scope"]["visibility"],
    ...(row.scope_project_id !== null ? { projectId: row.scope_project_id } : {}),
  };
  return {
    id: row.id,
    type: row.type as Memory["type"],
    summary: row.summary,
    content: row.content,
    provenance: row.provenance as Memory["provenance"],
    usePolicy,
    scope,
    lifecycle: row.lifecycle as Memory["lifecycle"],
    reviewStatus: row.review_status as Memory["reviewStatus"],
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    runtime: row.runtime,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.flow_id !== null ? { flowId: row.flow_id } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.stale_after !== null ? { staleAfter: row.stale_after } : {}),
    sourceRefs,
    artifacts,
  };
}

function groupBy<T extends { memory_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const existing = m.get(r.memory_id);
    if (existing) existing.push(r);
    else m.set(r.memory_id, [r]);
  }
  return m;
}

// M1 adjacency table is (kind, identifier, url); the M2 wire shape carries
// (kind, uri, title?, sourceTimestamp?). M3 persists only kind+identifier+url;
// title and sourceTimestamp don't round-trip until a future schema bump adds
// the columns. Reads echo a minimal SourceRef — schema accepts that since
// title/sourceTimestamp are optional.
function srRowToSourceRef(r: SourceRefRow): SourceRef {
  return { kind: r.kind, uri: r.identifier };
}

// Same story for artifacts — M1 stores (kind, content); M2 wire is
// (kind, uri, description?). We map content back to uri; description drops.
function arRowToArtifact(r: ArtifactRow): Memory["artifacts"][number] {
  return { kind: r.kind, uri: r.content };
}

interface ConfirmState {
  reviewStatus: string;
  lifecycle: string;
  provenance: string;
  canUseAsInstruction: boolean;
  doNotInjectAutomatically: boolean;
}

// Thrown by listPending when the caller supplies a cursor that doesn't
// decode to the expected `{ createdAt, id }` payload. The route layer
// catches by class name and surfaces a 400; everything else bubbles as 500.
export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

interface PendingCursor {
  createdAt: string;
  id: string;
}

function encodePendingCursor(c: PendingCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodePendingCursor(raw: string): PendingCursor {
  // Buffer.from(..., "base64url") is lenient — it never throws on garbage,
  // it silently emits whatever bytes it can. The downstream JSON.parse +
  // shape + datetime checks are the actual validation gate.
  const json = Buffer.from(raw, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as PendingCursor).createdAt !== "string" ||
    typeof (parsed as PendingCursor).id !== "string"
  ) {
    throw new InvalidCursorError();
  }
  // Reject a non-parseable createdAt: SQLite TEXT comparison is lexical, so
  // a payload like `{createdAt: "foo"}` would compare against every ISO
  // timestamp (which all start with a digit < 'f') and return the entire
  // page on the very first call. Parseable here is a necessary precondition.
  const cursor = parsed as PendingCursor;
  if (Number.isNaN(Date.parse(cursor.createdAt))) {
    throw new InvalidCursorError("invalid cursor: createdAt is not a parseable datetime");
  }
  return cursor;
}

// Projection of MemoryRow → ReviewItem. Storage-internal fields
// (idempotency_key, content_hash) are intentionally dropped — the review
// queue is the surface that lands in front of the operator, and the
// dedupe key has no business being there.
function rowToReviewItem(
  row: MemoryRow,
  sourceRefs: SourceRef[],
  artifacts: Memory["artifacts"],
): ReviewItem {
  const usePolicy = {
    canUseAsInstruction: row.use_policy_can_use_as_instruction === 1,
    canUseAsEvidence: row.use_policy_can_use_as_evidence === 1,
    requiresUserConfirmation: row.use_policy_requires_user_confirmation === 1,
    doNotInjectAutomatically: row.use_policy_do_not_inject_automatically === 1,
  };
  const scope: Memory["scope"] = {
    visibility: row.scope_visibility as Memory["scope"]["visibility"],
    ...(row.scope_project_id !== null ? { projectId: row.scope_project_id } : {}),
  };
  return {
    memoryId: row.id,
    type: row.type as Memory["type"],
    summary: row.summary,
    content: row.content,
    provenance: row.provenance as Memory["provenance"],
    usePolicy,
    scope,
    lifecycle: row.lifecycle as Memory["lifecycle"],
    reviewStatus: row.review_status as Memory["reviewStatus"],
    sourceRefs,
    artifacts,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    runtime: row.runtime,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.flow_id !== null ? { flowId: row.flow_id } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.stale_after !== null ? { staleAfter: row.stale_after } : {}),
  };
}

// Action → terminal state. Confirm is the only action that may set
// canUseAsInstruction = 1; to keep the storage CHECK satisfied for agent-
// authored memory we also upgrade provenance to `user_confirmed`. That
// upgrade is the explicit operator gesture invariant #1 (PRD §"Load-bearing
// invariants") demands before promotion.
function computeConfirmState(action: ReviewActionRequest["action"], row: MemoryRow): ConfirmState {
  const base: ConfirmState = {
    reviewStatus: row.review_status,
    lifecycle: row.lifecycle,
    provenance: row.provenance,
    canUseAsInstruction: row.use_policy_can_use_as_instruction === 1,
    doNotInjectAutomatically: row.use_policy_do_not_inject_automatically === 1,
  };
  switch (action) {
    case "confirm": {
      const provenance =
        row.provenance === "user_confirmed" || row.provenance === "imported"
          ? row.provenance
          : "user_confirmed";
      return {
        ...base,
        reviewStatus: "confirmed",
        provenance,
        canUseAsInstruction: true,
      };
    }
    case "evidence_only":
      return { ...base, reviewStatus: "evidence_only", canUseAsInstruction: false };
    case "restrict":
      return {
        ...base,
        reviewStatus: "restricted",
        canUseAsInstruction: false,
        doNotInjectAutomatically: true,
      };
    case "reject":
      return {
        ...base,
        reviewStatus: "rejected",
        lifecycle: "rejected",
        canUseAsInstruction: false,
      };
    case "merge":
      return {
        ...base,
        reviewStatus: "merged",
        lifecycle: "superseded",
        canUseAsInstruction: false,
      };
    case "mark_stale":
      return { ...base, reviewStatus: "stale", lifecycle: "stale", canUseAsInstruction: false };
  }
}

export function createMemoryStore(db: Database): MemoryStore {
  const insertMemory = db.prepare(`
    INSERT INTO memories (
      id, type, summary, content, provenance,
      use_policy_can_use_as_instruction, use_policy_can_use_as_evidence,
      use_policy_requires_user_confirmation, use_policy_do_not_inject_automatically,
      scope_project_id, scope_visibility, lifecycle, review_status,
      content_hash, idempotency_key, confidence, runtime,
      task_id, flow_id, model, provider,
      created_at, updated_at, stale_after
    ) VALUES (
      $id, $type, $summary, $content, $provenance,
      $use_policy_can_use_as_instruction, $use_policy_can_use_as_evidence,
      $use_policy_requires_user_confirmation, $use_policy_do_not_inject_automatically,
      $scope_project_id, $scope_visibility, $lifecycle, $review_status,
      $content_hash, $idempotency_key, $confidence, $runtime,
      $task_id, $flow_id, $model, $provider,
      $created_at, $updated_at, $stale_after
    )
  `);
  const insertSourceRef = db.prepare(
    "INSERT INTO memory_source_refs (memory_id, kind, identifier, url) VALUES (?, ?, ?, ?)",
  );
  const insertArtifact = db.prepare(
    "INSERT INTO memory_artifacts (memory_id, kind, content) VALUES (?, ?, ?)",
  );
  const insertAuditEvent = db.prepare(
    "INSERT INTO memory_audit_events (event_type, memory_id, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectByIdempotencyKey = db.prepare("SELECT id FROM memories WHERE idempotency_key = ?");
  const selectMemoryById = db.prepare("SELECT * FROM memories WHERE id = ?");
  const insertRecallTrace = db.prepare(
    "INSERT INTO memory_recall_traces (id, request_id, query, scope_json, returned_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // `rank` is a regular column name on memory_recall_items but a reserved
  // FTS5 special column — bracket-quote to be unambiguous wherever it appears.
  const insertRecallItem = db.prepare(
    'INSERT INTO memory_recall_items (trace_id, memory_id, "rank", used) VALUES (?, ?, ?, ?)',
  );
  const insertReviewAction = db.prepare(
    "INSERT INTO memory_review_actions (memory_id, action, actor, notes, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const updateMemoryForConfirm = db.prepare(`
    UPDATE memories
       SET review_status = ?,
           lifecycle = ?,
           provenance = ?,
           use_policy_can_use_as_instruction = ?,
           use_policy_do_not_inject_automatically = ?,
           updated_at = ?
     WHERE id = ?
  `);

  // Adjacency lookups can't be pre-compiled — the IN-clause arity depends on
  // the page size. Prepared per call; recall pages are bounded so the cost is
  // negligible.
  function fetchSourceRefs(ids: string[]): SourceRefRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT memory_id, kind, identifier, url FROM memory_source_refs WHERE memory_id IN (${placeholders})`,
      )
      .all(...ids) as SourceRefRow[];
  }
  function fetchArtifacts(ids: string[]): ArtifactRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT memory_id, kind, content FROM memory_artifacts WHERE memory_id IN (${placeholders})`,
      )
      .all(...ids) as ArtifactRow[];
  }

  function hydrate(rows: MemoryRow[]): Memory[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const srGroups = groupBy(fetchSourceRefs(ids));
    const arGroups = groupBy(fetchArtifacts(ids));
    return rows.map((row) =>
      rowToMemory(
        row,
        (srGroups.get(row.id) ?? []).map(srRowToSourceRef),
        (arGroups.get(row.id) ?? []).map(arRowToArtifact),
      ),
    );
  }

  // ORDER BY the combined score before LIMIT — sorting by bm25 alone would
  // drop fresh candidates at the page boundary that the JS layer can't recover.
  const recallSql = `
    SELECT
      m.id, m.type, m.summary, m.content, m.provenance,
      m.use_policy_can_use_as_instruction, m.use_policy_can_use_as_evidence,
      m.use_policy_requires_user_confirmation, m.use_policy_do_not_inject_automatically,
      m.scope_project_id, m.scope_visibility, m.lifecycle, m.review_status,
      m.content_hash, m.idempotency_key, m.confidence, m.runtime,
      m.task_id, m.flow_id, m.model, m.provider,
      m.created_at, m.updated_at, m.stale_after,
      bm25(memories_fts) AS bm25_score
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.scope_visibility = ?
      AND m.lifecycle = 'active'
      AND m.use_policy_do_not_inject_automatically = 0
      AND (m.stale_after IS NULL OR datetime(m.stale_after) > datetime('now'))
      AND (? IS NULL OR m.scope_project_id = ?)
      AND (? IS NULL OR datetime(m.created_at) >= datetime('now', ?))
    ORDER BY
      abs(bm25(memories_fts))
        * (1.0 / (1.0 + (max(0.0, julianday('now') - julianday(m.created_at)) / 30.0)))
      DESC
    LIMIT ?
  `;
  const recallStmt = db.prepare(recallSql);

  return {
    recall(req) {
      const ftsQuery = buildFtsQuery(req.query);
      const maxItems = req.limits?.maxItems ?? 25;
      const recencyDays = req.limits?.recencyDays ?? null;
      const recencyModifier = recencyDays !== null ? `-${recencyDays} days` : null;

      let rawRows: RecallRow[] = [];
      if (ftsQuery !== "") {
        try {
          rawRows = recallStmt.all(
            ftsQuery,
            req.scope.visibility,
            req.scope.projectId ?? null,
            req.scope.projectId ?? null,
            recencyDays,
            recencyModifier,
            maxItems,
          ) as RecallRow[];
        } catch (err) {
          // Malformed FTS query slips through quoting in edge cases (e.g.,
          // tokens that look like column filters). Treat as empty result so
          // the recall trace still records the attempt.
          console.warn(
            `[keelson] memory recall query failed (${err instanceof Error ? err.message : String(err)}); returning empty page`,
          );
        }
      }

      // SQL already returns rows in descending combined order; we only
      // recompute the score here to normalize rankingScore into [0,1].
      const scored = rawRows.map((r) => {
        const combined = Math.abs(r.bm25_score) * recencyDecay(daysSince(r.created_at));
        return { row: r, combined };
      });
      const maxCombined = scored.reduce((acc, s) => Math.max(acc, s.combined), 0);
      const memories = hydrate(scored.map((s) => s.row));
      const items: RecallItem[] = memories.map((m, idx) => {
        const combined = scored[idx]?.combined ?? 0;
        return {
          memoryId: m.id,
          type: m.type,
          summary: m.summary,
          content: m.content,
          provenance: m.provenance,
          usePolicy: m.usePolicy,
          scope: m.scope,
          sourceRefs: m.sourceRefs,
          artifacts: m.artifacts,
          createdAt: m.createdAt,
          rankingScore: maxCombined > 0 ? Math.min(1, combined / maxCombined) : 0,
        };
      });

      const traceId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.transaction(() => {
        insertRecallTrace.run(
          traceId,
          requestId,
          req.query,
          JSON.stringify(req.scope),
          items.length,
          now,
        );
        items.forEach((item, idx) => {
          insertRecallItem.run(traceId, item.memoryId, idx, 0);
        });
      })();

      return {
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId,
        items,
        trace: { traceId, returned: items.length },
      };
    },

    writeback(req) {
      const written: WritebackResponse["written"] = [];
      const blocked: WritebackResponse["blocked"] = [];
      const deduped: WritebackResponse["deduped"] = [];

      for (const draft of req.memories) {
        const verdict = evaluateDraft(draft);
        if (verdict !== null) {
          blocked.push({ reason: verdict.reason, summary: draft.summary });
          continue;
        }

        // Per-draft idempotency key — contentHash lives on the draft (M2 PR
        // #13 closed this hole) so a multi-memory writeback produces
        // distinct UNIQUE keys even when task and type match.
        const idempotencyKey = `${req.task.runtime}:${req.task.taskId ?? ""}:${draft.type}:${draft.contentHash}`;
        const existing = selectByIdempotencyKey.get(idempotencyKey) as { id: string } | null;
        if (existing) {
          deduped.push({ memoryId: existing.id, reason: "idempotent" });
          continue;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const staleAfter =
          draft.staleAfterDays !== undefined
            ? new Date(Date.now() + draft.staleAfterDays * 86_400_000).toISOString()
            : null;
        const scope = req.scope ?? { visibility: "project" as const };

        db.transaction(() => {
          insertMemory.run({
            $id: id,
            $type: draft.type,
            $summary: draft.summary,
            $content: draft.content,
            $provenance: draft.provenance,
            // Evidence-default: agent writebacks NEVER start as instruction.
            // The storage CHECK at migrations.ts:123-126 is the floor; this
            // is the service-layer floor that matches it.
            $use_policy_can_use_as_instruction: 0,
            $use_policy_can_use_as_evidence: 1,
            $use_policy_requires_user_confirmation: 0,
            $use_policy_do_not_inject_automatically: 0,
            $scope_project_id: scope.projectId ?? null,
            $scope_visibility: scope.visibility,
            $lifecycle: "active",
            $review_status: "pending",
            $content_hash: draft.contentHash,
            $idempotency_key: idempotencyKey,
            $confidence: draft.confidence ?? null,
            $runtime: req.task.runtime,
            $task_id: req.task.taskId ?? null,
            $flow_id: req.task.flowId ?? null,
            $model: req.task.model ?? null,
            $provider: req.task.provider ?? null,
            $created_at: now,
            $updated_at: now,
            $stale_after: staleAfter,
          });

          for (const sr of draft.sourceRefs) {
            // url column is unused on read; write NULL to keep read/write symmetric.
            insertSourceRef.run(id, sr.kind, sr.uri, null);
          }
          for (const ar of draft.artifacts) {
            insertArtifact.run(id, ar.kind, ar.uri);
          }

          insertAuditEvent.run(
            "writeback",
            id,
            req.task.runtime,
            JSON.stringify({
              envelopeIdempotencyKey: req.idempotencyKey,
              draftIdempotencyKey: idempotencyKey,
            }),
            now,
          );
        })();

        written.push({ memoryId: id, idempotencyKey });
      }

      return {
        schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
        written,
        blocked,
        deduped,
      };
    },

    confirm(input) {
      const row = selectMemoryById.get(input.memoryId) as MemoryRow | null;
      if (!row) return { applied: false };

      const next = computeConfirmState(input.action, row);
      const now = new Date().toISOString();

      db.transaction(() => {
        insertReviewAction.run(input.memoryId, input.action, input.actor, input.notes ?? null, now);
        updateMemoryForConfirm.run(
          next.reviewStatus,
          next.lifecycle,
          next.provenance,
          next.canUseAsInstruction ? 1 : 0,
          next.doNotInjectAutomatically ? 1 : 0,
          now,
          input.memoryId,
        );
        insertAuditEvent.run(
          "review_action",
          input.memoryId,
          input.actor,
          JSON.stringify({ action: input.action, notes: input.notes ?? null }),
          now,
        );
      })();

      return { applied: true };
    },

    getById(id) {
      const row = selectMemoryById.get(id) as MemoryRow | null;
      if (!row) return undefined;
      const [hydrated] = hydrate([row]);
      return hydrated;
    },

    listPending(query) {
      const limit = Math.min(query.limit ?? REVIEW_LIST_DEFAULT_LIMIT, REVIEW_LIST_MAX_LIMIT);
      const cursor = query.cursor !== undefined ? decodePendingCursor(query.cursor) : null;

      // Fetch limit+1 rows so we can determine whether a next page exists
      // without a second round trip. The trailing row gets dropped before
      // hydration so the SourceRef / Artifact fetches don't pay for it.
      const overFetch = limit + 1;
      const whereClauses: string[] = ["review_status = 'pending'"];
      const args: (string | number)[] = [];
      if (query.scopeVisibility !== undefined) {
        whereClauses.push("scope_visibility = ?");
        args.push(query.scopeVisibility);
      }
      if (query.projectId !== undefined) {
        whereClauses.push("scope_project_id = ?");
        args.push(query.projectId);
      }
      if (cursor) {
        // Strict ordering by (created_at DESC, id DESC) means the next page
        // starts at any row whose (created_at, id) is lexicographically less.
        whereClauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        args.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      // Explicit column list — matches the rest of the file and keeps the
      // MemoryRow cast honest if a future migration adds a column.
      const sql = `
        SELECT
          id, type, summary, content, provenance,
          use_policy_can_use_as_instruction, use_policy_can_use_as_evidence,
          use_policy_requires_user_confirmation, use_policy_do_not_inject_automatically,
          scope_project_id, scope_visibility, lifecycle, review_status,
          content_hash, idempotency_key, confidence, runtime,
          task_id, flow_id, model, provider,
          created_at, updated_at, stale_after
        FROM memories
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      args.push(overFetch);
      const rows = db.prepare(sql).all(...args) as MemoryRow[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      if (pageRows.length === 0) {
        return { items: [] };
      }

      const ids = pageRows.map((r) => r.id);
      const srGroups = groupBy(fetchSourceRefs(ids));
      const arGroups = groupBy(fetchArtifacts(ids));
      const items = pageRows.map((row) =>
        rowToReviewItem(
          row,
          (srGroups.get(row.id) ?? []).map(srRowToSourceRef),
          (arGroups.get(row.id) ?? []).map(arRowToArtifact),
        ),
      );

      if (!hasMore) {
        return { items };
      }
      // hasMore implies pageRows.length === limit ≥ 1; the cast is the
      // narrow workaround for noUncheckedIndexedAccess on the bracket lookup.
      const last = pageRows[pageRows.length - 1] as MemoryRow;
      return {
        items,
        nextCursor: encodePendingCursor({ createdAt: last.created_at, id: last.id }),
      };
    },
  };
}

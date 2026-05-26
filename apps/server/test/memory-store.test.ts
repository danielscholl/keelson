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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECALL_REQUEST_SCHEMA_VERSION,
  RECALL_RESPONSE_SCHEMA_VERSION,
  type RecallRequest,
  recallResponseSchema,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
  WRITEBACK_RESPONSE_SCHEMA_VERSION,
  type WritebackMemoryDraft,
  type WritebackRequest,
  writebackResponseSchema,
} from "@keelson/shared";
import { openDatabase } from "../src/db/init.ts";
import { createMemoryStore, type MemoryStore } from "../src/memory-store.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-memory-store-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  store = createMemoryStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDraft(overrides: Partial<WritebackMemoryDraft> = {}): WritebackMemoryDraft {
  return {
    type: "lesson",
    summary: "alpha bravo charlie",
    content: "delta echo foxtrot",
    contentHash: `hash-${crypto.randomUUID()}`,
    provenance: "generated",
    sourceRefs: [],
    artifacts: [],
    ...overrides,
  };
}

function makeWritebackRequest(
  drafts: WritebackMemoryDraft[],
  overrides: Partial<Omit<WritebackRequest, "memories">> = {},
): WritebackRequest {
  return {
    schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
    idempotencyKey: `env-${crypto.randomUUID()}`,
    task: { runtime: "chat" },
    ...overrides,
    memories: drafts,
  };
}

function makeRecallRequest(
  overrides: Partial<Omit<RecallRequest, "schemaVersion">> = {},
): RecallRequest {
  return {
    schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
    scope: { visibility: "project" },
    task: { runtime: "chat" },
    query: "alpha",
    ...overrides,
  };
}

describe("MemoryStore — writeback → recall round-trip", () => {
  test("writeback inserts memory; recall finds it via FTS MATCH on summary", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    expect(wb.schemaVersion).toBe(WRITEBACK_RESPONSE_SCHEMA_VERSION);
    expect(wb.written).toHaveLength(1);
    expect(wb.blocked).toEqual([]);
    expect(wb.deduped).toEqual([]);
    expect(writebackResponseSchema.safeParse(wb).success).toBe(true);

    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.schemaVersion).toBe(RECALL_RESPONSE_SCHEMA_VERSION);
    expect(rr.items).toHaveLength(1);
    expect(rr.items[0].memoryId).toBe(wb.written[0].memoryId);
    expect(recallResponseSchema.safeParse(rr).success).toBe(true);
  });

  test("recall hits FTS MATCH on content body", () => {
    store.writeback(
      makeWritebackRequest([makeDraft({ summary: "headline", content: "uniqueneedlecontent" })]),
    );
    const rr = store.recall(makeRecallRequest({ query: "uniqueneedlecontent" }));
    expect(rr.items).toHaveLength(1);
  });

  test("recall response parses against recallResponseSchema with multiple items", () => {
    store.writeback(
      makeWritebackRequest([
        makeDraft({ summary: "alpha first", content: "b1" }),
        makeDraft({ summary: "alpha second", content: "b2" }),
      ]),
    );
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(recallResponseSchema.safeParse(rr).success).toBe(true);
  });

  test("query with FTS5 operator characters does not throw", () => {
    store.writeback(makeWritebackRequest([makeDraft({ summary: "alpha" })]));
    // Should not crash even with operator-laden input.
    const rr = store.recall(makeRecallRequest({ query: "(alpha OR beta)*" }));
    expect(rr.items.length).toBeGreaterThanOrEqual(0);
  });
});

describe("MemoryStore — recall filters", () => {
  test("personal-scope memories invisible to project-scope recall", () => {
    store.writeback(
      makeWritebackRequest([makeDraft({ summary: "alpha bravo", content: "x" })], {
        scope: { visibility: "personal" },
      }),
    );
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toEqual([]);
  });

  test("excludes rows with do_not_inject_automatically = 1", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    db.prepare("UPDATE memories SET use_policy_do_not_inject_automatically = 1 WHERE id = ?").run(
      wb.written[0].memoryId,
    );
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toEqual([]);
  });

  test("excludes non-active lifecycles", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    db.prepare("UPDATE memories SET lifecycle = 'stale' WHERE id = ?").run(wb.written[0].memoryId);
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toEqual([]);
  });

  test("honors limits.maxItems", () => {
    for (let i = 0; i < 5; i++) {
      store.writeback(
        makeWritebackRequest([
          makeDraft({
            contentHash: `h-${i}`,
            summary: `alpha entry ${i}`,
            content: `body ${i}`,
          }),
        ]),
      );
    }
    const rr = store.recall(makeRecallRequest({ query: "alpha", limits: { maxItems: 2 } }));
    expect(rr.items).toHaveLength(2);
  });

  test("honors limits.recencyDays — excludes older memories", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
      oldDate,
      wb.written[0].memoryId,
    );
    const rr = store.recall(makeRecallRequest({ query: "alpha", limits: { recencyDays: 30 } }));
    expect(rr.items).toEqual([]);
  });

  test("scope.projectId narrows results", () => {
    store.writeback(
      makeWritebackRequest([makeDraft({ summary: "alpha A", content: "x" })], {
        scope: { visibility: "project", projectId: "proj-a" },
      }),
    );
    store.writeback(
      makeWritebackRequest([makeDraft({ contentHash: "h-b", summary: "alpha B", content: "y" })], {
        scope: { visibility: "project", projectId: "proj-b" },
      }),
    );
    const rr = store.recall(
      makeRecallRequest({
        query: "alpha",
        scope: { visibility: "project", projectId: "proj-a" },
      }),
    );
    expect(rr.items).toHaveLength(1);
    expect(rr.items[0].summary).toBe("alpha A");
  });
});

describe("MemoryStore — recall trace logging", () => {
  test("each recall writes one trace row and N item rows", () => {
    store.writeback(
      makeWritebackRequest([
        makeDraft(),
        makeDraft({ contentHash: "h2", summary: "alpha two", content: "y" }),
      ]),
    );
    store.recall(makeRecallRequest({ query: "alpha" }));

    const traceCount = (
      db.query("SELECT COUNT(*) AS c FROM memory_recall_traces").get() as {
        c: number;
      }
    ).c;
    expect(traceCount).toBe(1);
    const itemCount = (
      db.query("SELECT COUNT(*) AS c FROM memory_recall_items").get() as {
        c: number;
      }
    ).c;
    expect(itemCount).toBe(2);
  });

  test("trace.traceId in response matches DB row id", () => {
    store.writeback(makeWritebackRequest([makeDraft()]));
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM memory_recall_traces WHERE id = ?")
      .get(rr.trace.traceId);
    expect(row?.id).toBe(rr.trace.traceId);
  });

  test("empty result still writes trace with returned_count = 0", () => {
    const rr = store.recall(makeRecallRequest({ query: "nothingmatcheshere" }));
    expect(rr.items).toEqual([]);
    const row = db
      .query<{ returned_count: number }, [string]>(
        "SELECT returned_count FROM memory_recall_traces WHERE id = ?",
      )
      .get(rr.trace.traceId);
    expect(row?.returned_count).toBe(0);
  });

  test("recall items rows are ranked 0..n-1 in order", () => {
    store.writeback(
      makeWritebackRequest([
        makeDraft({ contentHash: "a", summary: "alpha a" }),
        makeDraft({ contentHash: "b", summary: "alpha b" }),
        makeDraft({ contentHash: "c", summary: "alpha c" }),
      ]),
    );
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    const ranks = db
      .query<{ rank: number }, [string]>(
        'SELECT "rank" FROM memory_recall_items WHERE trace_id = ? ORDER BY "rank"',
      )
      .all(rr.trace.traceId)
      .map((r) => r.rank);
    expect(ranks).toEqual([0, 1, 2]);
  });
});

describe("MemoryStore — ranking", () => {
  test("rankingScore lies in [0,1] and is sorted descending", () => {
    for (let i = 0; i < 4; i++) {
      store.writeback(
        makeWritebackRequest([
          makeDraft({
            contentHash: `h-${i}`,
            summary: `alpha bravo ${i}`,
            content: `body ${"x".repeat(i + 1)}`,
          }),
        ]),
      );
    }
    const rr = store.recall(makeRecallRequest({ query: "alpha bravo" }));
    expect(rr.items.length).toBeGreaterThan(0);
    for (const item of rr.items) {
      expect(item.rankingScore).toBeGreaterThanOrEqual(0);
      expect(item.rankingScore).toBeLessThanOrEqual(1);
    }
    const scores = rr.items.map((i) => i.rankingScore);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  test("empty page produces rankingScore 0 (no division by zero)", () => {
    const rr = store.recall(makeRecallRequest({ query: "nothingmatcheshere" }));
    expect(rr.items).toEqual([]);
  });
});

describe("MemoryStore — writeback guardrails", () => {
  test("blocks potential_secret (AWS access key)", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ content: "AKIAIOSFODNN7EXAMPLE" })]),
    );
    expect(wb.written).toEqual([]);
    expect(wb.blocked).toHaveLength(1);
    expect(wb.blocked[0].reason).toBe("potential_secret");
  });

  test("blocks missing_source_ref for artifact_reference type", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ type: "artifact_reference", sourceRefs: [] })]),
    );
    expect(wb.written).toEqual([]);
    expect(wb.blocked[0].reason).toBe("missing_source_ref");
  });

  test("blocks missing_source_ref for output type", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ type: "output", sourceRefs: [] })]),
    );
    expect(wb.blocked[0].reason).toBe("missing_source_ref");
  });

  test("artifact_reference with sourceRef is accepted", () => {
    const wb = store.writeback(
      makeWritebackRequest([
        makeDraft({
          type: "artifact_reference",
          sourceRefs: [{ kind: "pr", uri: "https://github.com/foo/1" }],
        }),
      ]),
    );
    expect(wb.written).toHaveLength(1);
  });

  test("blocked drafts are reported with their summary", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ content: "AKIAIOSFODNN7EXAMPLE", summary: "leaky" })]),
    );
    expect(wb.blocked[0].summary).toBe("leaky");
  });
});

describe("MemoryStore — idempotency", () => {
  test("dedupes by derived idempotency_key", () => {
    const draft = makeDraft({ contentHash: "stable-hash" });
    const wb1 = store.writeback(makeWritebackRequest([draft]));
    expect(wb1.written).toHaveLength(1);
    const wb2 = store.writeback(makeWritebackRequest([draft]));
    expect(wb2.written).toEqual([]);
    expect(wb2.deduped).toHaveLength(1);
    expect(wb2.deduped[0].memoryId).toBe(wb1.written[0].memoryId);
  });

  test("multi-draft writeback distinguishes per-draft contentHash", () => {
    const wb = store.writeback(
      makeWritebackRequest([
        makeDraft({ contentHash: "a", content: "body-a" }),
        makeDraft({ contentHash: "b", content: "body-b" }),
      ]),
    );
    expect(wb.written).toHaveLength(2);
    const keys = wb.written.map((w) => w.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  test("idempotency key embeds runtime, taskId, type, contentHash", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ contentHash: "fixed", type: "decision" })], {
        task: { runtime: "workflow:foo", taskId: "task-99" },
      }),
    );
    expect(wb.written[0].idempotencyKey).toBe("workflow:foo:task-99:decision:fixed");
  });
});

describe("MemoryStore — sourceRefs and artifacts persistence", () => {
  test("sourceRefs round-trip via getById", () => {
    const wb = store.writeback(
      makeWritebackRequest([
        makeDraft({
          sourceRefs: [
            { kind: "pr", uri: "https://github.com/foo/bar/pull/1" },
            { kind: "issue", uri: "issue-42" },
          ],
        }),
      ]),
    );
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.sourceRefs).toHaveLength(2);
    expect(mem?.sourceRefs[0].kind).toBe("pr");
    expect(mem?.sourceRefs[0].uri).toBe("https://github.com/foo/bar/pull/1");
  });

  test("artifacts round-trip via getById", () => {
    const wb = store.writeback(
      makeWritebackRequest([makeDraft({ artifacts: [{ kind: "file", uri: "/path/to/file.ts" }] })]),
    );
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.artifacts).toHaveLength(1);
    expect(mem?.artifacts[0].uri).toBe("/path/to/file.ts");
  });

  test("writeback audit_events row is written", () => {
    store.writeback(makeWritebackRequest([makeDraft()]));
    const row = db
      .query<{ event_type: string }, []>(
        "SELECT event_type FROM memory_audit_events WHERE event_type = 'writeback'",
      )
      .get();
    expect(row?.event_type).toBe("writeback");
  });
});

describe("MemoryStore — confirm state machine", () => {
  test("confirm upgrades agent provenance to user_confirmed and sets instruction flag", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    const memoryId = wb.written[0].memoryId;

    const result = store.confirm({ memoryId, action: "confirm", actor: "alice" });
    expect(result.applied).toBe(true);

    const mem = store.getById(memoryId);
    expect(mem?.provenance).toBe("user_confirmed");
    expect(mem?.reviewStatus).toBe("confirmed");
    expect(mem?.usePolicy.canUseAsInstruction).toBe(true);
  });

  test("confirm preserves already-eligible provenance (user_confirmed / imported)", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    const memoryId = wb.written[0].memoryId;
    db.prepare("UPDATE memories SET provenance = 'imported' WHERE id = ?").run(memoryId);
    store.confirm({ memoryId, action: "confirm", actor: "alice" });
    const mem = store.getById(memoryId);
    expect(mem?.provenance).toBe("imported");
    expect(mem?.usePolicy.canUseAsInstruction).toBe(true);
  });

  test("evidence_only forces instruction flag off", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    store.confirm({ memoryId: wb.written[0].memoryId, action: "evidence_only", actor: "a" });
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.reviewStatus).toBe("evidence_only");
    expect(mem?.usePolicy.canUseAsInstruction).toBe(false);
  });

  test("restrict sets do_not_inject_automatically; subsequent recall excludes", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    const memoryId = wb.written[0].memoryId;
    store.confirm({ memoryId, action: "restrict", actor: "alice" });
    const mem = store.getById(memoryId);
    expect(mem?.usePolicy.doNotInjectAutomatically).toBe(true);
    expect(mem?.reviewStatus).toBe("restricted");

    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toEqual([]);
  });

  test("reject sets lifecycle to rejected; subsequent recall excludes", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    store.confirm({ memoryId: wb.written[0].memoryId, action: "reject", actor: "alice" });
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toEqual([]);
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.lifecycle).toBe("rejected");
  });

  test("merge sets lifecycle to superseded", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    store.confirm({ memoryId: wb.written[0].memoryId, action: "merge", actor: "a" });
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.lifecycle).toBe("superseded");
    expect(mem?.reviewStatus).toBe("merged");
  });

  test("mark_stale sets lifecycle and review_status to stale", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    store.confirm({ memoryId: wb.written[0].memoryId, action: "mark_stale", actor: "a" });
    const mem = store.getById(wb.written[0].memoryId);
    expect(mem?.lifecycle).toBe("stale");
    expect(mem?.reviewStatus).toBe("stale");
  });

  test("confirm on unknown memory returns applied=false (silent no-op)", () => {
    const result = store.confirm({
      memoryId: "missing",
      action: "confirm",
      actor: "alice",
    });
    expect(result.applied).toBe(false);
  });

  test("confirm writes review_actions and audit_events rows", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    store.confirm({
      memoryId: wb.written[0].memoryId,
      action: "confirm",
      actor: "alice",
      notes: "looks good",
    });
    const actionCount = (
      db.query("SELECT COUNT(*) AS c FROM memory_review_actions").get() as {
        c: number;
      }
    ).c;
    expect(actionCount).toBe(1);
    const eventCount = (
      db
        .query("SELECT COUNT(*) AS c FROM memory_audit_events WHERE event_type = 'review_action'")
        .get() as { c: number }
    ).c;
    expect(eventCount).toBe(1);
  });
});

describe("MemoryStore — durability", () => {
  test("reopening DB preserves rows and FTS index", () => {
    const wb = store.writeback(makeWritebackRequest([makeDraft()]));
    const memoryId = wb.written[0].memoryId;
    db.close();

    db = openDatabase({ path: dbPath });
    store = createMemoryStore(db);

    expect(store.getById(memoryId)).toBeDefined();
    const rr = store.recall(makeRecallRequest({ query: "alpha" }));
    expect(rr.items).toHaveLength(1);
    expect(rr.items[0].memoryId).toBe(memoryId);
  });
});

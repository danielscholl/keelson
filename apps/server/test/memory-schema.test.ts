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
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-memory-schema-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmTemp(tmpDir);
});

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

function makeMemory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    type: "lesson",
    summary: "alpha bravo",
    content: "charlie delta echo",
    provenance: "generated",
    use_policy_can_use_as_instruction: 0,
    use_policy_can_use_as_evidence: 1,
    use_policy_requires_user_confirmation: 0,
    use_policy_do_not_inject_automatically: 0,
    scope_project_id: null,
    scope_visibility: "project",
    lifecycle: "active",
    review_status: "pending",
    content_hash: "deadbeef",
    idempotency_key: `chat:${id}:lesson:deadbeef`,
    confidence: 0.5,
    runtime: "chat",
    task_id: null,
    flow_id: null,
    model: null,
    provider: null,
    created_at: now,
    updated_at: now,
    stale_after: null,
    ...overrides,
  };
}

const INSERT_MEMORY_SQL = `
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
`;

function insertMemory(db: Database, row: MemoryRow): void {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    params[`$${k}`] = v;
  }
  db.prepare(INSERT_MEMORY_SQL).run(params);
}

describe("Memory layer schema (baseline)", () => {
  test("migrations apply cleanly and schema_version reaches 5", () => {
    const db = openDatabase({ path: dbPath });
    const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBe(5);
    db.close();
  });

  test("all memory tables exist", () => {
    const db = openDatabase({ path: dbPath });
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    for (const expected of [
      "memories",
      "memory_artifacts",
      "memory_audit_events",
      "memory_recall_items",
      "memory_recall_traces",
      "memory_review_actions",
      "memory_source_refs",
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  test("baseline omits the unused memory_relations table", () => {
    const db = openDatabase({ path: dbPath });
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).not.toContain("memory_relations");
    db.close();
  });

  test("memories_fts virtual table exists", () => {
    const db = openDatabase({ path: dbPath });
    const row = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name='memories_fts'")
      .get();
    expect(row?.name).toBe("memories_fts");
    db.close();
  });

  test("instruction-promotion CHECK rejects can_use_as_instruction=1 with provenance='generated'", () => {
    const db = openDatabase({ path: dbPath });
    expect(() => {
      insertMemory(
        db,
        makeMemory({
          use_policy_can_use_as_instruction: 1,
          provenance: "generated",
        }),
      );
    }).toThrow(/CHECK constraint/i);
    db.close();
  });

  test("instruction-promotion CHECK accepts user_confirmed and imported", () => {
    const db = openDatabase({ path: dbPath });
    expect(() => {
      insertMemory(
        db,
        makeMemory({
          id: "mem-uc",
          idempotency_key: "k-uc",
          use_policy_can_use_as_instruction: 1,
          provenance: "user_confirmed",
        }),
      );
    }).not.toThrow();
    expect(() => {
      insertMemory(
        db,
        makeMemory({
          id: "mem-im",
          idempotency_key: "k-im",
          use_policy_can_use_as_instruction: 1,
          provenance: "imported",
        }),
      );
    }).not.toThrow();
    db.close();
  });

  test("enum CHECKs reject unknown values", () => {
    const db = openDatabase({ path: dbPath });
    const badCases: Array<[string, Partial<MemoryRow>]> = [
      ["type", { type: "bogus" }],
      ["provenance", { provenance: "bogus" }],
      ["scope_visibility", { scope_visibility: "bogus" }],
      ["lifecycle", { lifecycle: "bogus" }],
      ["review_status", { review_status: "bogus" }],
    ];
    for (const [label, override] of badCases) {
      expect(() =>
        insertMemory(
          db,
          makeMemory({
            ...override,
            idempotency_key: `k-${label}`,
          }),
        ),
      ).toThrow(/CHECK constraint/i);
    }
    db.close();
  });

  test("boolean CHECKs reject non-0/1 values on use_policy_* flags", () => {
    const db = openDatabase({ path: dbPath });
    const badCases: Array<[string, Partial<MemoryRow>]> = [
      ["can_use_as_instruction", { use_policy_can_use_as_instruction: 2 }],
      ["can_use_as_evidence", { use_policy_can_use_as_evidence: 2 }],
      ["requires_user_confirmation", { use_policy_requires_user_confirmation: -1 }],
      ["do_not_inject_automatically", { use_policy_do_not_inject_automatically: 99 }],
    ];
    for (const [label, override] of badCases) {
      expect(() =>
        insertMemory(
          db,
          makeMemory({
            ...override,
            idempotency_key: `bool-${label}`,
          }),
        ),
      ).toThrow(/CHECK constraint/i);
    }
    db.close();
  });

  test("idempotency_key UNIQUE enforced", () => {
    const db = openDatabase({ path: dbPath });
    insertMemory(db, makeMemory({ id: "mem-a", idempotency_key: "same" }));
    expect(() => {
      insertMemory(db, makeMemory({ id: "mem-b", idempotency_key: "same" }));
    }).toThrow(/UNIQUE constraint/i);
    db.close();
  });

  test("FTS5 sync on insert: MATCH returns inserted row", () => {
    const db = openDatabase({ path: dbPath });
    insertMemory(
      db,
      makeMemory({
        id: "mem-x",
        idempotency_key: "k-x",
        summary: "alpha bravo",
        content: "",
      }),
    );
    const row = db
      .query<{ id: string }, [string]>(
        "SELECT m.id FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?",
      )
      .get("bravo");
    expect(row?.id).toBe("mem-x");
    db.close();
  });

  test("FTS5 sync on update: new term matches, old term doesn't", () => {
    const db = openDatabase({ path: dbPath });
    insertMemory(
      db,
      makeMemory({
        id: "mem-x",
        idempotency_key: "k-x",
        summary: "alpha bravo",
        content: "uniqueold",
      }),
    );
    db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(
      "uniquenew gamma",
      new Date().toISOString(),
      "mem-x",
    );

    const newHit = db
      .query<{ id: string }, [string]>(
        "SELECT m.id FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?",
      )
      .get("uniquenew");
    expect(newHit?.id).toBe("mem-x");

    const oldHit = db
      .query<{ id: string }, [string]>(
        "SELECT m.id FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?",
      )
      .get("uniqueold");
    expect(oldHit?.id).toBeUndefined();
    db.close();
  });

  test("FTS5 sync on delete: row removed from index", () => {
    const db = openDatabase({ path: dbPath });
    insertMemory(
      db,
      makeMemory({
        id: "mem-x",
        idempotency_key: "k-x",
        summary: "uniquetoken",
      }),
    );
    db.prepare("DELETE FROM memories WHERE id = ?").run("mem-x");

    const hit = db
      .query<{ id: string }, [string]>(
        "SELECT m.id FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?",
      )
      .get("uniquetoken");
    expect(hit?.id).toBeUndefined();
    db.close();
  });

  test("re-opening DB after migration is idempotent and preserves v1 data", () => {
    let db = openDatabase({ path: dbPath });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO conversations (id, providerId, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
    ).run("conv-1", "stub", now, now);
    insertMemory(db, makeMemory({ id: "mem-1", idempotency_key: "k-1" }));
    db.close();

    db = openDatabase({ path: dbPath });
    const versionRow = db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number;
    };
    expect(versionRow.v).toBe(5);

    const conv = db
      .query<{ id: string }, []>("SELECT id FROM conversations WHERE id = 'conv-1'")
      .get();
    expect(conv?.id).toBe("conv-1");

    const mem = db.query<{ id: string }, []>("SELECT id FROM memories WHERE id = 'mem-1'").get();
    expect(mem?.id).toBe("mem-1");

    db.close();
  });
});

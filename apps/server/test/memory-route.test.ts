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
  type RecallResponse,
  type ReviewActionResponse,
  type ReviewListResponse,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
  type WritebackResponse,
} from "@keelson/shared";
import { Hono } from "hono";
import { openDatabase } from "../src/db/init.ts";
import { memoryRoutes } from "../src/memory-handler.ts";
import { createMemoryStore, type MemoryStore } from "../src/memory-store.ts";

const ORIGIN = "http://127.0.0.1:5173";

let tmpDir: string;
let db: Database;
let store: MemoryStore;
let app: Hono;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-memory-route-"));
  db = openDatabase({ path: join(tmpDir, "test.db") });
  store = createMemoryStore(db);
  app = new Hono();
  memoryRoutes(app, { memoryStore: store });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function getJson(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://test${path}`, {
    headers: { origin: ORIGIN, ...headers },
  });
}

// Seed helper — uses the store directly so the route test isn't coupled to
// writeback semantics under test in another describe block.
function seedMemory(
  opts: { summary?: string; content?: string; contentHash?: string } = {},
): string {
  const wb = store.writeback({
    schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
    idempotencyKey: `env-${crypto.randomUUID()}`,
    task: { runtime: "chat" },
    memories: [
      {
        type: "lesson",
        summary: opts.summary ?? "alpha bravo",
        content: opts.content ?? "delta echo",
        contentHash: opts.contentHash ?? `hash-${crypto.randomUUID()}`,
        provenance: "generated",
        sourceRefs: [],
        artifacts: [],
      },
    ],
  });
  return wb.written[0].memoryId;
}

describe("POST /api/memory/recall", () => {
  test("returns recall response for a matching query", async () => {
    seedMemory({ summary: "alpha bravo" });
    const res = await app.fetch(
      postJson("/api/memory/recall", {
        schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
        scope: { visibility: "project" },
        task: { runtime: "chat" },
        query: "alpha",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].summary).toBe("alpha bravo");
  });

  test("rejects malformed JSON with 400", async () => {
    const req = new Request("http://test/api/memory/recall", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{ not json",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid json body");
  });

  test("rejects schema mismatch with 400", async () => {
    const res = await app.fetch(postJson("/api/memory/recall", { wrong: "shape" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/memory/writeback", () => {
  test("writes the draft and echoes the memoryId", async () => {
    const res = await app.fetch(
      postJson("/api/memory/writeback", {
        schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
        idempotencyKey: "env-1",
        task: { runtime: "chat" },
        memories: [
          {
            type: "lesson",
            summary: "summary",
            content: "content",
            contentHash: "h1",
            provenance: "generated",
            sourceRefs: [],
            artifacts: [],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WritebackResponse;
    expect(body.written).toHaveLength(1);
    expect(body.blocked).toEqual([]);
  });

  test("blocked secret returns 200 with the verdict in body.blocked", async () => {
    // AWS access key pattern — the guardrail rejects without writing.
    const res = await app.fetch(
      postJson("/api/memory/writeback", {
        schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
        idempotencyKey: "env-secret",
        task: { runtime: "chat" },
        memories: [
          {
            type: "lesson",
            summary: "leaky",
            content: "AKIAIOSFODNN7EXAMPLE",
            contentHash: "h-secret",
            provenance: "generated",
            sourceRefs: [],
            artifacts: [],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WritebackResponse;
    expect(body.written).toEqual([]);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0].reason).toBe("potential_secret");
  });
});

describe("POST /api/memory/review", () => {
  test("applies confirm and flips review_status", async () => {
    const memoryId = seedMemory();
    const res = await app.fetch(
      postJson("/api/memory/review", {
        memoryId,
        action: "confirm",
        actor: "alice",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as ReviewActionResponse).toEqual({ applied: true });

    const stored = store.getById(memoryId);
    expect(stored?.reviewStatus).toBe("confirmed");
    expect(stored?.provenance).toBe("user_confirmed");
  });

  test("unknown memoryId is a silent no-op with applied=false", async () => {
    const res = await app.fetch(
      postJson("/api/memory/review", {
        memoryId: "missing",
        action: "confirm",
        actor: "alice",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as ReviewActionResponse).toEqual({ applied: false });
  });
});

describe("GET /api/memory/review", () => {
  test("returns pending memories newest-first", async () => {
    const first = seedMemory({ summary: "first" });
    // Small delay so created_at sort is observable. Backdate the first row
    // explicitly to avoid relying on monotonic clock granularity.
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      first,
    );
    const second = seedMemory({ summary: "second", contentHash: "h2" });

    const res = await app.fetch(getJson("/api/memory/review"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewListResponse;
    expect(body.items.map((i) => i.memoryId)).toEqual([second, first]);
  });

  test("excludes already-confirmed rows", async () => {
    const memoryId = seedMemory();
    store.confirm({ memoryId, action: "confirm", actor: "alice" });
    const res = await app.fetch(getJson("/api/memory/review"));
    const body = (await res.json()) as ReviewListResponse;
    expect(body.items).toEqual([]);
  });

  test("redacts storage-internal fields (no idempotencyKey / contentHash)", async () => {
    seedMemory();
    const res = await app.fetch(getJson("/api/memory/review"));
    const body = (await res.json()) as ReviewListResponse;
    const item = body.items[0] as Record<string, unknown>;
    expect(item.idempotencyKey).toBeUndefined();
    expect(item.contentHash).toBeUndefined();
    expect(item.memoryId).toBeDefined();
  });

  test("limit + cursor paginate deterministically", async () => {
    const ids = [
      seedMemory({ contentHash: "a" }),
      seedMemory({ contentHash: "b" }),
      seedMemory({ contentHash: "c" }),
    ];

    const firstRes = await app.fetch(getJson("/api/memory/review?limit=2"));
    const firstBody = (await firstRes.json()) as ReviewListResponse;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeDefined();

    const secondRes = await app.fetch(
      getJson(`/api/memory/review?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
    );
    const secondBody = (await secondRes.json()) as ReviewListResponse;
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeUndefined();

    const seen = [...firstBody.items, ...secondBody.items].map((i) => i.memoryId);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  test("invalid cursor returns 400", async () => {
    const res = await app.fetch(getJson("/api/memory/review?cursor=not-base64-json"));
    expect(res.status).toBe(400);
  });

  test("rejects non-positive limit with 400", async () => {
    const res = await app.fetch(getJson("/api/memory/review?limit=0"));
    expect(res.status).toBe(400);
  });

  test("scope filter narrows results", async () => {
    seedMemory({ contentHash: "p" });
    // Mark the second row as personal so the project-scope filter excludes it.
    const personalId = seedMemory({ contentHash: "x" });
    db.prepare("UPDATE memories SET scope_visibility = 'personal' WHERE id = ?").run(personalId);

    const projectRes = await app.fetch(getJson("/api/memory/review?scopeVisibility=project"));
    const projectBody = (await projectRes.json()) as ReviewListResponse;
    expect(projectBody.items).toHaveLength(1);
    expect(projectBody.items.every((i) => i.scope.visibility === "project")).toBe(true);
  });
});

describe("origin gating", () => {
  test("disallowed origin returns 403", async () => {
    const req = new Request("http://test/api/memory/recall", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({
        schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
        scope: { visibility: "project" },
        task: { runtime: "chat" },
        query: "alpha",
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });

  test("missing origin is allowed (curl / scripts on loopback)", async () => {
    const req = new Request("http://test/api/memory/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
        scope: { visibility: "project" },
        task: { runtime: "chat" },
        query: "alpha",
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
  });
});

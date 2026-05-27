// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  memoryListQuerySchema,
  recallRequestSchema,
  reviewActionRequestSchema,
  reviewListQuerySchema,
  writebackRequestSchema,
} from "@keelson/shared";
import type { Context, Hono } from "hono";
import { InvalidCursorError, type MemoryStore } from "./memory-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface MemoryRoutesDeps {
  memoryStore: MemoryStore;
}

// Generic envelope for unexpected store failures. bun:sqlite errors carry
// schema column names and the absolute DB path; echoing them in the response
// would disclose storage internals to any caller that triggered a constraint
// or lock. Log the detail, surface a stable string.
function internalErrorResponse(c: Context, scope: string, err: unknown) {
  console.warn(`[memory] ${scope} failed: ${err instanceof Error ? err.message : String(err)}`);
  return c.json({ error: "internal error" }, 500);
}

export function memoryRoutes(app: Hono, deps: MemoryRoutesDeps): void {
  const { memoryStore } = deps;

  // Cross-origin guard mirrors credentialsRoutes: missing Origin = curl /
  // scripts on the loopback (allow), present-but-non-loopback = the CSRF
  // shape we reject. Memory writeback is irreversible enough that the same
  // posture used for credentials is warranted here.
  app.use("/api/memory/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

  app.post("/api/memory/recall", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = recallRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(memoryStore.recall(parsed.data));
    } catch (err) {
      return internalErrorResponse(c, "recall", err);
    }
  });

  // A writeback whose every draft is blocked or deduped still returns 200 —
  // the per-item verdict lives in the response body. HTTP status only fires
  // on transport / schema / unexpected-store failures.
  app.post("/api/memory/writeback", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = writebackRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(memoryStore.writeback(parsed.data));
    } catch (err) {
      return internalErrorResponse(c, "writeback", err);
    }
  });

  app.post("/api/memory/review", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = reviewActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(memoryStore.confirm(parsed.data));
    } catch (err) {
      return internalErrorResponse(c, "review", err);
    }
  });

  // Coerce `limit` once so Zod yields a single error shape for every invalid limit (0, -1, 1.5, abc).
  // `cursor` is opaque; the store throws InvalidCursorError, which we surface as 400.
  app.get("/api/memory/review", async (c) => {
    const limitRaw = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const scopeVisibility = c.req.query("scopeVisibility");
    const projectId = c.req.query("projectId");

    const queryShape: Record<string, unknown> = {};
    // Pass non-numeric strings straight through so Zod's coerced rejection
    // (rather than NaN-via-Number) drives the error message.
    if (limitRaw !== undefined) queryShape.limit = Number(limitRaw);
    if (cursor !== undefined) queryShape.cursor = cursor;
    if (scopeVisibility !== undefined) queryShape.scopeVisibility = scopeVisibility;
    if (projectId !== undefined) queryShape.projectId = projectId;

    const parsed = reviewListQuerySchema.safeParse(queryShape);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(memoryStore.listPending(parsed.data));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        // Surfaced as 400 so a client can distinguish "your cursor is bad"
        // from a real server fault. The log line gives operators a signal
        // when a client is sending corrupted or forged cursors at volume.
        console.warn(`[memory] invalid review cursor rejected: ${err.message}`);
        return c.json({ error: err.message }, 400);
      }
      return internalErrorResponse(c, "review.list", err);
    }
  });

  // Browsable view across review statuses + lifecycles; /api/memory/review stays pinned to pending.
  app.get("/api/memory/list", async (c) => {
    const limitRaw = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const scopeVisibility = c.req.query("scopeVisibility");
    const projectId = c.req.query("projectId");
    const reviewStatus = c.req.query("reviewStatus");
    const lifecycle = c.req.query("lifecycle");

    const queryShape: Record<string, unknown> = {};
    if (limitRaw !== undefined) queryShape.limit = Number(limitRaw);
    if (cursor !== undefined) queryShape.cursor = cursor;
    if (scopeVisibility !== undefined) queryShape.scopeVisibility = scopeVisibility;
    if (projectId !== undefined) queryShape.projectId = projectId;
    if (reviewStatus !== undefined) queryShape.reviewStatus = reviewStatus;
    if (lifecycle !== undefined) queryShape.lifecycle = lifecycle;

    const parsed = memoryListQuerySchema.safeParse(queryShape);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(memoryStore.listMemories(parsed.data));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        console.warn(`[memory] invalid list cursor rejected: ${err.message}`);
        return c.json({ error: err.message }, 400);
      }
      return internalErrorResponse(c, "memory.list", err);
    }
  });
}

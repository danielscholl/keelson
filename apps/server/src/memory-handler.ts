// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  recallRequestSchema,
  reviewActionRequestSchema,
  reviewListQuerySchema,
  writebackRequestSchema,
} from "@keelson/shared";
import type { Hono } from "hono";
import { isAllowedOrigin } from "./chat-handler.ts";
import { InvalidCursorError, type MemoryStore } from "./memory-store.ts";

export interface MemoryRoutesDeps {
  memoryStore: MemoryStore;
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
    const response = memoryStore.recall(parsed.data);
    return c.json(response);
  });

  // A writeback whose every draft is blocked or deduped still returns 200 —
  // the per-item verdict lives in the response body. HTTP status only fires
  // on transport / schema failures.
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
    const response = memoryStore.writeback(parsed.data);
    return c.json(response);
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
    const response = memoryStore.confirm(parsed.data);
    return c.json(response);
  });

  // GET pending-list for M7. Numeric `limit` arrives as a string on the URL
  // — coerce before schema parse so the validator sees the typed shape it
  // expects. `cursor` opacity is opaque-by-base64; bad cursors throw
  // InvalidCursorError from the store, surfaced here as a 400.
  app.get("/api/memory/review", (c) => {
    const limitRaw = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const scopeVisibility = c.req.query("scopeVisibility");
    const projectId = c.req.query("projectId");

    const queryShape: Record<string, unknown> = {};
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isFinite(limit)) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      queryShape.limit = limit;
    }
    if (cursor !== undefined) queryShape.cursor = cursor;
    if (scopeVisibility !== undefined) queryShape.scopeVisibility = scopeVisibility;
    if (projectId !== undefined) queryShape.projectId = projectId;

    const parsed = reviewListQuerySchema.safeParse(queryShape);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const response = memoryStore.listPending(parsed.data);
      return c.json(response);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  listRibsResponseSchema,
  type RibAction,
  type RibActionResult,
  type RibAuthStatus,
  type RibSummary,
  ribActionSchema,
  ribAuthStatusSchema,
} from "@keelson/shared";
import type { Hono } from "hono";
import type { RibManifest } from "./ribs.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface RibsRoutesDeps {
  manifests: readonly RibManifest[];
  probes: Map<string, () => Promise<RibAuthStatus>>;
  actionHandlers: Map<string, (action: RibAction) => Promise<RibActionResult>>;
}

// GET /api/ribs + POST /api/ribs/:id/action. The SPA discovers active ribs and
// their view descriptors here without an App.tsx edit. The action route is the
// inbound half of the rib back-channel — loopback-trusted (guarded by the
// /api/* CORS gate); the capability-token envelope is a later milestone.
export function ribsRoutes(app: Hono, deps: RibsRoutesDeps): void {
  const { manifests, probes, actionHandlers } = deps;

  app.get("/api/ribs", async (c) => {
    const ribs: RibSummary[] = await Promise.all(
      manifests.map(async (m): Promise<RibSummary> => {
        const probe = probes.get(m.id);
        let auth: RibAuthStatus | undefined;
        if (probe) {
          try {
            // A throwing probe OR a malformed result degrades just this rib to
            // unauthenticated — one broken rib can't blank the whole panel via
            // the response parse below.
            const result = ribAuthStatusSchema.safeParse(await probe());
            auth = result.success
              ? result.data
              : { authenticated: false, statusMessage: "invalid auth status" };
          } catch (err) {
            auth = {
              authenticated: false,
              statusMessage: err instanceof Error ? err.message : String(err),
            };
          }
        }
        return {
          id: m.id,
          displayName: m.displayName,
          registered: [...m.registered],
          views: [...m.views],
          actions: [...m.actions],
          hasOnAction: m.hasOnAction,
          ...(auth ? { auth } : {}),
        };
      }),
    );
    return c.json(listRibsResponseSchema.parse({ ribs }));
  });

  app.post("/api/ribs/:id/action", async (c) => {
    // Cross-origin guard mirrors the other mutating routes: a missing Origin
    // (curl / loopback scripts) is allowed; a present-but-foreign Origin is the
    // CSRF shape we reject before dispatching a state-changing action.
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const id = c.req.param("id");
    const handler = actionHandlers.get(id);
    if (!handler) {
      const known = manifests.some((m) => m.id === id);
      return c.json({ error: known ? "rib does not handle actions" : "rib not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = ribActionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid action" }, 400);
    }
    try {
      return c.json(await handler(parsed.data));
    } catch (err) {
      const result: RibActionResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return c.json(result, 500);
    }
  });
}

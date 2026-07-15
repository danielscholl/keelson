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
  ribActionResponseSchema,
  ribActionSchema,
  ribAuthStatusSchema,
  ribClientEffectSchema,
  ribIdFromKey,
} from "@keelson/shared";
import { type CrossRibGrants, serializeCrossRibGrants } from "@keelson/shared/config";
import type { Hono } from "hono";
import { type DynamicRegionStore, mergeSurfaceRegions } from "./dynamic-region-store.ts";
import type { RibManifest } from "./ribs.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface RibsRoutesDeps {
  manifests: readonly RibManifest[];
  probes: Map<string, () => Promise<RibAuthStatus>>;
  actionHandlers: Map<string, (action: RibAction) => Promise<RibActionResult>>;
  // Runtime-registered regions merged onto each rib's static surfaces. Optional
  // so test rigs without one serve the boot manifest verbatim.
  dynamicRegionStore?: Pick<DynamicRegionStore, "regionsFor">;
  // The boot-resolved grants this server enforces. Optional so a test rig that
  // omits it serves a response with the field absent (= "not reported"), which
  // is what an older server looks like to a client.
  crossRibGrants?: CrossRibGrants;
}

// GET /api/ribs + POST /api/ribs/:id/action. The SPA discovers active ribs and
// their view descriptors here without an App.tsx edit. The action route is the
// inbound half of the rib back-channel — loopback-trusted (guarded by the
// /api/* CORS gate); there is no capability-token enforcement yet.
export function ribsRoutes(app: Hono, deps: RibsRoutesDeps): void {
  const { manifests, probes, actionHandlers, dynamicRegionStore, crossRibGrants } = deps;

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
          // Merge runtime regions onto each static surface (no-op when none): a
          // newly-authored panel appears here without a server restart.
          surfaces: m.surfaces.map((s) =>
            dynamicRegionStore
              ? mergeSurfaceRegions(s, dynamicRegionStore.regionsFor(m.id, s.id))
              : s,
          ),
          hasOnAction: m.hasOnAction,
          acceptsIngest: m.acceptsIngest,
          ...(auth ? { auth } : {}),
        };
      }),
    );
    return c.json(
      listRibsResponseSchema.parse({
        ribs,
        ...(crossRibGrants ? { crossRibGrants: serializeCrossRibGrants(crossRibGrants) } : {}),
      }),
    );
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
      // Validate the rib's result against the wire schema before returning — a
      // JS/third-party rib can return a malformed value despite the TS
      // contract, which would otherwise 200 and break the SPA's response parse.
      const result = ribActionResponseSchema.safeParse(await handler(parsed.data));
      if (!result.success) {
        return c.json({ ok: false, error: "rib returned a malformed action result" }, 500);
      }
      // A success may carry an `open-canvas` client effect whose `key` the SPA
      // renders as a snapshot board (and dispatches that board's actions to the
      // rib it names). Mirror the activation-time namespace gate: a rib may only
      // open its OWN board, so reject a key resolving to another rib before the
      // effect leaves onAction.
      if (result.data.ok) {
        const effect = ribClientEffectSchema.safeParse(result.data.data);
        if (
          effect.success &&
          effect.data.effect === "open-canvas" &&
          ribIdFromKey(effect.data.key) !== id
        ) {
          return c.json({ ok: false, error: "open-canvas key is outside the rib namespace" }, 500);
        }
      }
      return c.json(result.data);
    } catch (err) {
      const result: RibActionResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return c.json(result, 500);
    }
  });
}

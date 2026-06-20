// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Approval round-trip routes. A policy `ask` opens a pending approval in the
// ApprovalRegistry; clients watch the open set over the snapshot WS
// (POLICY_APPROVALS_SNAPSHOT_KEY) and resolve one here. Mirrors the workflow
// resume route, generalized off any single run.

import { approvalDecisionSchema } from "@keelson/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { ApprovalRegistry } from "./approval-registry.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface ApprovalsRoutesDeps {
  registry: ApprovalRegistry;
}

const resolveBodySchema = z.object({ decision: approvalDecisionSchema }).strict();

export function approvalsRoutes(app: Hono, deps: ApprovalsRoutesDeps): void {
  const { registry } = deps;

  // CSRF guard on the mutating route, mirroring gatewaysRoutes/credentialsRoutes:
  // a present Origin must be loopback; a missing Origin is a non-browser caller
  // (curl / CLI on loopback). The GET below is a read of redacted views and is
  // intentionally left unguarded, matching the gateways list route.
  app.use("/api/approvals/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

  app.get("/api/approvals", (c) => c.json({ approvals: registry.list() }));

  app.post("/api/approvals/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = resolveBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "body must be { decision: 'accept' | 'reject' }" }, 400);
    }
    // 404 when the id is unknown — already resolved, timed out, or never existed;
    // distinguishes a stale resolve from a live one (mirrors the resume route).
    const ok = registry.resolve(c.req.param("id"), parsed.data.decision);
    if (!ok) {
      return c.json({ error: "unknown or already-resolved approval" }, 404);
    }
    return c.json({ ok: true });
  });
}

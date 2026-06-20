// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "@keelson/shared";
import { Hono } from "hono";
import { type ApprovalRegistry, createApprovalRegistry } from "../src/approval-registry.ts";
import { approvalsRoutes } from "../src/approvals-handler.ts";

function makeRig(): { app: Hono; registry: ApprovalRegistry } {
  const registry = createApprovalRegistry({ timeoutMs: 0 });
  const app = new Hono();
  approvalsRoutes(app, { registry });
  return { app, registry };
}

const openApproval = (registry: ApprovalRegistry): Promise<ApprovalDecision> =>
  registry.request({ surface: "chat", policyId: "builtin:ask_on_shell", reason: "confirm shell" });

function post(app: Hono, id: string, body: unknown, origin?: string): Promise<Response> {
  return app.fetch(
    new Request(`http://test/api/approvals/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("GET /api/approvals", () => {
  test("empty when nothing is pending", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/approvals"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [] });
  });

  test("lists open approvals as redacted views", async () => {
    const { app, registry } = makeRig();
    void openApproval(registry);
    const res = await app.fetch(new Request("http://test/api/approvals"));
    const body = (await res.json()) as { approvals: Array<Record<string, unknown>> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      surface: "chat",
      policyId: "builtin:ask_on_shell",
      reason: "confirm shell",
    });
    expect(body.approvals[0]).not.toHaveProperty("args");
  });
});

describe("POST /api/approvals/:id", () => {
  test("accept resolves the pending request and clears it", async () => {
    const { app, registry } = makeRig();
    const pending = openApproval(registry);
    const id = registry.list()[0]!.id;
    const res = await post(app, id, { decision: "accept" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await pending).toBe("accept");
    expect(registry.list()).toEqual([]);
  });

  test("reject resolves the request with reject", async () => {
    const { app, registry } = makeRig();
    const pending = openApproval(registry);
    const id = registry.list()[0]!.id;
    expect((await post(app, id, { decision: "reject" })).status).toBe(200);
    expect(await pending).toBe("reject");
  });

  test("404 for an unknown or already-resolved id", async () => {
    const { app } = makeRig();
    expect((await post(app, "missing", { decision: "accept" })).status).toBe(404);
  });

  test("400 on a missing/invalid decision", async () => {
    const { app, registry } = makeRig();
    void openApproval(registry);
    const id = registry.list()[0]!.id;
    expect((await post(app, id, { decision: "maybe" })).status).toBe(400);
    expect((await post(app, id, {})).status).toBe(400);
  });

  test("400 on a non-JSON body", async () => {
    const { app, registry } = makeRig();
    void openApproval(registry);
    const id = registry.list()[0]!.id;
    expect((await post(app, id, "{ not json")).status).toBe(400);
  });
});

describe("cross-origin guard", () => {
  test("POST from a disallowed origin is rejected before resolving", async () => {
    const { app, registry } = makeRig();
    void openApproval(registry);
    const id = registry.list()[0]!.id;
    const res = await post(app, id, { decision: "accept" }, "http://evil.example");
    expect(res.status).toBe(403);
    // The approval stays open — a cross-origin POST never resolved it.
    expect(registry.list()).toHaveLength(1);
  });
});

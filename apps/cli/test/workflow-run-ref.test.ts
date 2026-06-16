// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";

import { resolveRunRef } from "../src/http/workflow-client.ts";

// Two runs share the 8-char prefix `aaaaaaaa` (what `--watch` prints), plus a
// uniquely-prefixed run, so one fixture exercises every branch.
const RUN_A1 = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_A2 = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-3333-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_IDS = [RUN_A1, RUN_A2, RUN_B];

const handler = (req: Request): Response => {
  const { pathname } = new URL(req.url);
  // Exact lookup: GET /api/workflows/runs/:runId — 200 only for a full id.
  const detail = pathname.match(/^\/api\/workflows\/runs\/(.+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1] ?? "");
    return RUN_IDS.includes(id)
      ? Response.json({ run: { runId: id } })
      : new Response("not found", { status: 404 });
  }
  // Feed: GET /api/workflows/runs — backs the prefix scan.
  if (pathname === "/api/workflows/runs") {
    return Response.json({ runs: RUN_IDS.map((runId) => ({ runId })) });
  }
  return new Response("not found", { status: 404 });
};

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
const baseUrl = `http://${server.hostname}:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("resolveRunRef", () => {
  test("returns a full id unchanged (exact match)", async () => {
    expect(await resolveRunRef(baseUrl, RUN_A1)).toEqual({ runId: RUN_A1 });
  });

  test("resolves a unique prefix to its full id", async () => {
    // `bb` matches only the third run; the watch header's 8-char form resolves too.
    expect(await resolveRunRef(baseUrl, "bb")).toEqual({ runId: RUN_B });
    expect(await resolveRunRef(baseUrl, "bbbbbbbb")).toEqual({ runId: RUN_B });
  });

  test("resolves an 8-char prefix that is unique past the shared head", async () => {
    expect(await resolveRunRef(baseUrl, "aaaaaaaa-1")).toEqual({ runId: RUN_A1 });
  });

  test("rejects an ambiguous prefix instead of guessing", async () => {
    const result = await resolveRunRef(baseUrl, "aaaaaaaa");
    expect(result).toMatchObject({ ambiguous: true });
    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toContain("ambiguous");
  });

  test("reports a prefix that matches nothing as not found", async () => {
    expect(await resolveRunRef(baseUrl, "deadbeef")).toEqual({
      error: "run 'deadbeef' not found",
      ambiguous: false,
    });
  });
});

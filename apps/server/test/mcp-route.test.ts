// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../src/index.ts";

const MCP_TOKEN = "test-mcp-token";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "route-test", version: "0" },
  },
});
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let tokenless: ServerHandle;
let gated: ServerHandle;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = join(mkdtempSync(join(tmpdir(), "keelson-mcp-route-")), "keelson");
  for (const k of ["KEELSON_HOME", "KEELSON_WORKSPACE", "KEELSON_DISABLE_SCHEDULER"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.KEELSON_HOME = home;
  process.env.KEELSON_WORKSPACE = home;
  process.env.KEELSON_DISABLE_SCHEDULER = "1";

  tokenless = await startServer({ port: 0 });

  // Boot a second server with the token gate on. resolveMcpSettings reads the
  // env at boot, so set it only across this construction, then restore it
  // (don't clobber a value another suite may rely on).
  const requireTokenBefore = process.env.KEELSON_MCP_REQUIRE_TOKEN;
  process.env.KEELSON_MCP_REQUIRE_TOKEN = "1";
  gated = await startServer({ port: 0, mcpToken: MCP_TOKEN });
  if (requireTokenBefore === undefined) delete process.env.KEELSON_MCP_REQUIRE_TOKEN;
  else process.env.KEELSON_MCP_REQUIRE_TOKEN = requireTokenBefore;
});

afterAll(async () => {
  await tokenless.shutdown();
  await gated.shutdown();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/mcp (tokenless, default)", () => {
  test("a tokenless server reports no enforced MCP token on its handle", () => {
    expect(tokenless.mcpToken).toBeUndefined();
  });

  test("GET (the optional SSE probe) is rejected with 405, not a dead stream", async () => {
    const res = await fetch(new URL("/api/mcp", tokenless.url), {
      method: "GET",
      headers: MCP_HEADERS,
    });
    expect(res.status).toBe(405);
  });

  test("initialize round-trips and identifies the keelson server", async () => {
    const res = await fetch(new URL("/api/mcp", tokenless.url), {
      method: "POST",
      headers: MCP_HEADERS,
      body: initializeBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("keelson");
  });
});

describe("POST /api/mcp (token-gated)", () => {
  test("the enforced token is reported on the handle (matches what's persisted)", () => {
    expect(gated.mcpToken).toBe(MCP_TOKEN);
  });

  test("rejects a missing token", async () => {
    const res = await fetch(new URL("/api/mcp", gated.url), {
      method: "POST",
      headers: MCP_HEADERS,
      body: initializeBody,
    });
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token", async () => {
    const res = await fetch(new URL("/api/mcp", gated.url), {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer nope" },
      body: initializeBody,
    });
    expect(res.status).toBe(401);
  });

  test("accepts the right token", async () => {
    const res = await fetch(new URL("/api/mcp", gated.url), {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${MCP_TOKEN}` },
      body: initializeBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("keelson");
  });

  test("accepts a lowercase 'bearer' scheme (RFC 6750 is case-insensitive)", async () => {
    const res = await fetch(new URL("/api/mcp", gated.url), {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `bearer ${MCP_TOKEN}` },
      body: initializeBody,
    });
    expect(res.status).toBe(200);
  });
});

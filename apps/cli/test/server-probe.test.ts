// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";

import { DEFAULT_PROBE_TIMEOUT_MS, probeServer, type ServerInfo } from "../src/server-probe.ts";

const TEST_SCHEMA_VERSION = "2.7";

const handler = (req: Request): Response => {
  const url = new URL(req.url);
  if (url.pathname === "/api/health") {
    return Response.json({
      ok: true,
      name: "keelson",
      phase: 2,
      schema_version: TEST_SCHEMA_VERSION,
    });
  }
  return new Response("not found", { status: 404 });
};

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
const liveBaseUrl = `http://${server.hostname}:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("probeServer", () => {
  test("returns parsed ServerInfo when the server responds to /api/health", async () => {
    const info = await probeServer({ baseUrl: liveBaseUrl });
    expect(info).not.toBeNull();
    const okInfo = info as ServerInfo;
    expect(okInfo.baseUrl).toBe(liveBaseUrl);
    expect(okInfo.name).toBe("keelson");
    expect(okInfo.phase).toBe(2);
    expect(okInfo.schemaVersion).toBe(TEST_SCHEMA_VERSION);
  });

  test("returns null within the timeout when nothing is listening on the port", async () => {
    // Bind+release a port to get one nothing else is using right now.
    const sniffer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const closedPort = sniffer.port;
    sniffer.stop(true);
    const start = performance.now();
    const info = await probeServer({
      baseUrl: `http://127.0.0.1:${closedPort}`,
      timeoutMs: 250,
    });
    const elapsed = performance.now() - start;
    expect(info).toBeNull();
    // Generous bound: timeout is 250ms; allow OS/network variance.
    expect(elapsed).toBeLessThan(2000);
  });

  test("returns null when /api/health responds with a non-200 status", async () => {
    const errServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("teapot", { status: 418 }),
    });
    try {
      const info = await probeServer({ baseUrl: `http://127.0.0.1:${errServer.port}` });
      expect(info).toBeNull();
    } finally {
      errServer.stop(true);
    }
  });

  test("defaults the timeout to 250ms", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(250);
  });

  test("normalizes trailing slashes in baseUrl", async () => {
    const info = await probeServer({ baseUrl: `${liveBaseUrl}/` });
    expect(info).not.toBeNull();
    expect((info as ServerInfo).baseUrl).toBe(liveBaseUrl);
  });
});

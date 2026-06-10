// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../src/index.ts";

const TOKEN = "test-shutdown-token";

let handle: ServerHandle;
let home: string;
let shutdownRequests = 0;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = join(mkdtempSync(join(tmpdir(), "keelson-shutdown-route-")), "keelson");
  for (const k of ["KEELSON_HOME", "KEELSON_WORKSPACE", "KEELSON_DISABLE_SCHEDULER"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.KEELSON_HOME = home;
  process.env.KEELSON_WORKSPACE = home;
  process.env.KEELSON_DISABLE_SCHEDULER = "1";
  handle = await startServer({
    port: 0,
    shutdown: {
      token: TOKEN,
      onShutdown: () => {
        shutdownRequests += 1;
      },
    },
  });
});

afterAll(async () => {
  await handle.shutdown();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/server/shutdown", () => {
  test("rejects a missing token", async () => {
    const res = await fetch(new URL("/api/server/shutdown", handle.url), { method: "POST" });
    expect(res.status).toBe(401);
    expect(shutdownRequests).toBe(0);
  });

  test("rejects a wrong token", async () => {
    const res = await fetch(new URL("/api/server/shutdown", handle.url), {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
    expect(shutdownRequests).toBe(0);
  });

  test("accepts the right token and invokes onShutdown after responding", async () => {
    const res = await fetch(new URL("/api/server/shutdown", handle.url), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // onShutdown fires on a short timer so the response flushes first.
    await Bun.sleep(150);
    expect(shutdownRequests).toBe(1);
  });

  test("is absent when no shutdown config is provided", async () => {
    const bare = await startServer({ port: 0 });
    try {
      const res = await fetch(new URL("/api/server/shutdown", bare.url), { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      await bare.shutdown();
    }
  });
});

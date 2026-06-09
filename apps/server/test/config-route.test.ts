// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { type ServerHandle, startServer } from "../src/index.ts";

let handle: ServerHandle;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Hermetic: a throwaway home + workspace (so no real ribs, workflows, or
  // project state are discovered) and no scheduler (so no rib cadence workflow
  // fires just by running this /api/config unit test). KEELSON_DB is already
  // :memory: via test-setup.
  home = join(mkdtempSync(join(tmpdir(), "keelson-config-route-")), "keelson");
  for (const k of ["KEELSON_HOME", "KEELSON_WORKSPACE", "KEELSON_DISABLE_SCHEDULER"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.KEELSON_HOME = home;
  process.env.KEELSON_WORKSPACE = home;
  process.env.KEELSON_DISABLE_SCHEDULER = "1";
  // Ephemeral port so the test never collides with a dev server on 7878.
  handle = await startServer({ port: 0 });
});

afterAll(async () => {
  await handle.shutdown();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/config", () => {
  test("echoes shared version constants", async () => {
    const res = await fetch(new URL("/api/config", handle.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      wireProtocolVersion: string;
    };
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.wireProtocolVersion).toBe(WIRE_PROTOCOL_VERSION);
  });
});

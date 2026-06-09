// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { type ServerHandle, startServer } from "../src/index.ts";

let handle: ServerHandle;

beforeAll(async () => {
  // Ephemeral port so the test never collides with a dev server on 7878.
  handle = await startServer({ port: 0 });
});

afterAll(async () => {
  await handle.shutdown();
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

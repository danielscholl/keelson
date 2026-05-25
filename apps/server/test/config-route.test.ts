// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { app } from "../src/index.ts";

describe("GET /api/config", () => {
  test("echoes shared version constants", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1/api/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      wireProtocolVersion: string;
    };
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.wireProtocolVersion).toBe(WIRE_PROTOCOL_VERSION);
  });
});

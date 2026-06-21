// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, mock, test } from "bun:test";
import { SCHEMA_VERSION } from "@keelson/shared";
import { detectSchemaSkew, schemaSkewError } from "../src/schema-gate.ts";
import type { ServerInfo } from "../src/server-probe.ts";

const info = (schemaVersion: string): ServerInfo => ({
  baseUrl: "http://127.0.0.1:7878",
  name: "keelson",
  schemaVersion,
});

describe("detectSchemaSkew", () => {
  test("returns null when the known version matches this build", async () => {
    const probeServer = mock(async () => info("should-not-be-called"));
    expect(await detectSchemaSkew("http://x", SCHEMA_VERSION, { probeServer })).toBeNull();
    // A known matching version short-circuits — no second round-trip.
    expect(probeServer).not.toHaveBeenCalled();
  });

  test("returns the server version when the known version differs", async () => {
    const probeServer = mock(async () => info("unused"));
    expect(await detectSchemaSkew("http://x", "0.1", { probeServer })).toBe("0.1");
    expect(probeServer).not.toHaveBeenCalled();
  });

  test("probes the base when no version is known, reporting skew", async () => {
    const probeServer = mock(async () => info("9.9"));
    expect(await detectSchemaSkew("http://x", undefined, { probeServer })).toBe("9.9");
    expect(probeServer).toHaveBeenCalledTimes(1);
  });

  test("probes and returns null when the probed version matches", async () => {
    const probeServer = mock(async () => info(SCHEMA_VERSION));
    expect(await detectSchemaSkew("http://x", undefined, { probeServer })).toBeNull();
  });

  test("returns null when the server is unreachable (down-path owns it)", async () => {
    const probeServer = mock(async () => null);
    expect(await detectSchemaSkew("http://x", undefined, { probeServer })).toBeNull();
  });
});

describe("schemaSkewError", () => {
  test("names both versions and points at the remedy", () => {
    const msg = schemaSkewError("9.9");
    expect(msg).toContain("9.9");
    expect(msg).toContain(SCHEMA_VERSION);
    expect(msg).toContain("keelson update");
  });
});

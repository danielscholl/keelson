// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { RibSummary } from "@keelson/shared";
import { runRibsCheck } from "../src/checks/ribs.ts";
import type { ServerInfo } from "../src/server-probe.ts";

const info: ServerInfo = {
  baseUrl: "http://127.0.0.1:7878",
  name: "keelson",
  schemaVersion: "2.7",
};

function rib(partial: Partial<RibSummary>): RibSummary {
  return {
    id: "rib",
    displayName: "Rib",
    registered: [],
    views: [],
    surfaces: [],
    hasOnAction: false,
    ...partial,
  };
}

describe("ribs check", () => {
  test("server down → skip (server check owns the down warning)", async () => {
    const result = await runRibsCheck({ probeServer: async () => null });
    expect(result.category).toBe("ribs");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("skip");
    expect(result.checks[0]?.detail).toContain("server not running");
  });

  test("no ribs installed → skip", async () => {
    const result = await runRibsCheck({ probeServer: async () => info, listRibs: async () => [] });
    expect(result.checks[0]?.status).toBe("skip");
    expect(result.checks[0]?.detail).toContain("no ribs installed");
  });

  test("authenticated → ok; not-ready → warn; no probe → skip", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      listRibs: async () => [
        rib({
          id: "chamber",
          displayName: "Chamber",
          auth: { authenticated: true, statusMessage: "rooms & lenses wired" },
        }),
        rib({
          id: "osdu",
          displayName: "OSDU",
          auth: { authenticated: false, statusMessage: "cluster not authed" },
        }),
        rib({ id: "weather", displayName: "Weather" }),
      ],
    });
    const chamber = result.checks.find((c) => c.name === "Chamber");
    expect(chamber?.status).toBe("ok");
    expect(chamber?.detail).toBe("rooms & lenses wired");
    const osdu = result.checks.find((c) => c.name === "OSDU");
    expect(osdu?.status).toBe("warn");
    expect(osdu?.detail).toContain("cluster not authed");
    const weather = result.checks.find((c) => c.name === "Weather");
    expect(weather?.status).toBe("skip");
    expect(weather?.detail).toContain("no readiness probe");
  });

  test("listRibs throws → warn", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      listRibs: async () => {
        throw new Error("GET /api/ribs failed: 500");
      },
    });
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.detail).toContain("500");
  });
});

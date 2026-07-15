// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrossRibGrantsWire, RibSummary } from "@keelson/shared";
import type { KeelsonConfig } from "@keelson/shared/config";
import { runRibsCheck } from "../src/checks/ribs.ts";
import type { CheckResult } from "../src/checks/types.ts";
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

// The two ribs the cross-rib grant tests key off: chamber (the caller) and osdu
// (the target that actually registers the granted tools).
const chamber = rib({ id: "chamber", displayName: "Chamber", registered: ["chamber_room_say"] });
const osdu = rib({
  id: "osdu",
  displayName: "OSDU",
  registered: ["osdu_security", "osdu_quality"],
});

// `server` is what the running server reports it resolved at boot; `config` is
// what this machine's config.json says now. The check's whole job is comparing
// them, so every test states both.
async function grantFor(
  opts: { server?: CrossRibGrantsWire; config?: KeelsonConfig; ribs?: RibSummary[] } = {},
): Promise<CheckResult | undefined> {
  const result = await runRibsCheck({
    probeServer: async () => info,
    fetchRibs: async () => ({
      ribs: opts.ribs ?? [chamber, osdu],
      crossRibGrants: opts.server ?? {},
    }),
    readConfig: () => ({ ok: true, config: opts.config ?? {} }),
  });
  return result.checks.find((c) => c.name.startsWith("grant ") || c.name === "cross-rib grants");
}

describe("ribs check", () => {
  test("server down → skip (server check owns the down warning)", async () => {
    const result = await runRibsCheck({ probeServer: async () => null });
    expect(result.category).toBe("ribs");
    expect(result.checks[0]?.status).toBe("skip");
    expect(result.checks[0]?.detail).toContain("server not running");
  });

  test("no ribs installed → skip", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [], crossRibGrants: {} }),
      readConfig: () => ({ ok: true, config: {} }),
    });
    expect(result.checks[0]?.status).toBe("skip");
    expect(result.checks[0]?.detail).toContain("no ribs installed");
  });

  test("authenticated → ok; not-ready → warn; no probe → skip", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      readConfig: () => ({ ok: true, config: {} }),
      fetchRibs: async () => ({
        crossRibGrants: {},
        ribs: [
          rib({
            id: "chamber",
            displayName: "Chamber",
            auth: { authenticated: true, statusMessage: "gh CLI authenticated" },
          }),
          rib({
            id: "osdu",
            displayName: "OSDU",
            auth: { authenticated: false, statusMessage: "run `azd auth login`" },
          }),
          rib({ id: "plain", displayName: "Plain" }),
        ],
      }),
    });
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get("Chamber")?.status).toBe("ok");
    expect(byName.get("Chamber")?.detail).toBe("gh CLI authenticated");
    expect(byName.get("OSDU")?.status).toBe("warn");
    expect(byName.get("OSDU")?.detail).toContain("azd auth login");
    expect(byName.get("Plain")?.status).toBe("skip");
    expect(byName.get("Plain")?.detail).toContain("no readiness probe");
  });

  test("fetchRibs throws → warn", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => {
        throw new Error("GET /api/ribs failed: 500");
      },
      readConfig: () => ({ ok: true, config: {} }),
    });
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.detail).toContain("500");
  });
});

describe("cross-rib grants check", () => {
  test("no grants anywhere → skip, not a spurious warn", async () => {
    const check = await grantFor();
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("no cross-rib grants configured");
  });

  test("server down → skip, and says grants need a live server to observe", async () => {
    const result = await runRibsCheck({
      probeServer: async () => null,
      readConfig: () => ({
        ok: true,
        config: { crossRibGrants: { chamber: { osdu: ["osdu_security"] } } },
      }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("skip");
    expect(result.checks[0]?.detail).toContain("server not running");
    expect(result.checks[0]?.detail).toContain("only observable");
  });

  // An older server has no crossRibGrants field at all. Absent must not read as
  // "the server holds no grants", which would warn "restart" against every entry.
  test("server that does not report its grants → skip, not a false restart warning", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu] }),
      readConfig: () => ({
        ok: true,
        config: { crossRibGrants: { chamber: { osdu: ["osdu_security"] } } },
      }),
    });
    const check = result.checks.find((c) => c.name === "cross-rib grants");
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("does not report");
  });

  test("server and config.json agree → ok, reporting the grant in force", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security", "osdu_quality"] } },
      config: { crossRibGrants: { chamber: { osdu: ["osdu_security", "osdu_quality"] } } },
    });
    expect(check?.name).toBe("grant chamber -> osdu");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("osdu_security, osdu_quality");
    expect(check?.detail).toContain("in force");
    expect(check?.detail).toContain("config.json");
  });

  // Scenario A: the operator edited config.json and did not restart. The server
  // froze an empty map at boot, so the grant it "added" is denied on every call.
  test("config.json grants what the server does not hold → warn restart, never ok", async () => {
    const check = await grantFor({
      server: {},
      config: { crossRibGrants: { chamber: { osdu: ["osdu_security"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("does not hold this grant");
    expect(check?.detail).toContain("denied");
    expect(check?.hint).toContain("restart");
  });

  // The same drift, one tool wide: the pair exists at boot but config.json has
  // since grown a tool the running server never resolved.
  test("config.json adds a tool to a live grant → warn restart", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security"] } },
      config: { crossRibGrants: { chamber: { osdu: ["osdu_security", "osdu_quality"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("'osdu_quality'");
    expect(check?.detail).toContain("does not hold");
    expect(check?.hint).toContain("restart");
  });

  // Scenario B: the server holds a grant config.json does not name. It IS in force
  // — doctor must see it — but config.json will not reproduce it on a restart.
  // Doctor cannot see which source produced it, so it reports only that.
  test("server holds a grant config.json does not name → warn, conditioned on the environment", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security"] } },
      config: {},
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("in force");
    expect(check?.detail).toContain("config.json does not name 'osdu_security'");
    expect(check?.detail).toContain("only if the server's environment supplies it again");
    expect(check?.detail).not.toContain("KEELSON_CROSS_RIB_GRANTS");
    expect(check?.hint).toContain("config.json (crossRibGrants.chamber.osdu)");
  });

  // The identical inputs, reached the other way: config.json held the grant at boot
  // and the operator deleted it to revoke, without restarting. Doctor cannot tell
  // this apart from an environment-sourced grant, so one message serves both, and
  // it must promise neither operator an outcome that depends on the next server's
  // environment: `keelson start` re-inherits the shell, so a restart revokes
  // nothing when the environment still supplies the grant.
  test("a grant deleted from config.json since boot → no promise that a restart revokes it", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security"] } },
      config: { crossRibGrants: {} },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).not.toContain("KEELSON_CROSS_RIB_GRANTS");
    expect(check?.detail).not.toContain("came from");
    expect(check?.detail).toContain("only if the server's environment supplies it again");
    expect(check?.hint).not.toContain("to drop it");
  });

  test("unknown caller rib → warn (inert), naming the active ribs", async () => {
    const check = await grantFor({
      server: { chambr: { osdu: ["osdu_security"] } },
      config: { crossRibGrants: { chambr: { osdu: ["osdu_security"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("caller rib 'chambr' is not active");
    expect(check?.detail).toContain("inert");
    expect(check?.hint).toContain("'chamber'");
    expect(check?.hint).toContain("crossRibGrants.chambr.osdu");
  });

  test("unknown target rib → warn (inert)", async () => {
    const check = await grantFor({
      server: { chamber: { osu: ["osdu_security"] } },
      config: { crossRibGrants: { chamber: { osu: ["osdu_security"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("target rib 'osu' is not active");
    expect(check?.hint).toContain("crossRibGrants.chamber.osu");
  });

  // The renamed/typo'd tool: it parses, stores, and then silently matches
  // nothing. The one case that motivated the check.
  test("tool the target does not register → warn naming the exact tool", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security", "osdu_qualty"] } },
      config: { crossRibGrants: { chamber: { osdu: ["osdu_security", "osdu_qualty"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("'osdu_qualty'");
    expect(check?.detail).toContain("does not register");
    expect(check?.detail).not.toContain("'osdu_security'");
    expect(check?.hint).toContain("'osdu_security', 'osdu_quality'");
    expect(check?.hint).toContain("config.json");
  });

  // The bad tool name is in the server's map and not in config.json. Sending the
  // operator to config.json to fix a string that is not there is the wrong file,
  // and naming the source it did come from is a claim doctor cannot make.
  test("a bad tool name config.json does not hold → hint names neither config.json nor a source", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_security", "osdu_qualty"] } },
      config: { crossRibGrants: { chamber: { osdu: ["osdu_security"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("'osdu_qualty'");
    expect(check?.hint).not.toContain("KEELSON_CROSS_RIB_GRANTS");
    expect(check?.hint).not.toContain("crossRibGrants.chamber.osdu");
    expect(check?.hint).toContain("beyond config.json");
  });

  // The operator already fixed the tool name in config.json and has not restarted.
  // The server's stale name is still inert, but the fix sitting unapplied is the
  // actionable half, and the remedy is the restart — not an edit doctor cannot place.
  test("config.json holds the fix the server has not applied → reports both, and the restart", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["osdu_qualty"] } },
      config: { crossRibGrants: { chamber: { osdu: ["osdu_quality"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("does not register 'osdu_qualty'");
    expect(check?.detail).toContain("config.json grants 'osdu_quality'");
    expect(check?.detail).toContain("the server does not hold");
    expect(check?.hint).toContain("restart the server");
    expect(check?.hint).not.toContain("KEELSON_CROSS_RIB_GRANTS");
  });

  test("wildcard against a real rib → ok", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["*"] } },
      config: { crossRibGrants: { chamber: { osdu: ["*"] } } },
    });
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("every tool 'osdu' owns");
  });

  // "*" reaches every tool the target owns, so a stale name sitting beside it is
  // subsumed, not inert — warning here would fail `doctor --strict` on a config
  // that works.
  test("wildcard subsumes a name the target no longer registers → ok", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["*", "osdu_legacy_name"] } },
      config: { crossRibGrants: { chamber: { osdu: ["*", "osdu_legacy_name"] } } },
    });
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("every tool 'osdu' owns");
  });

  // The wildcard covers both directions of the server/config comparison too: a
  // config "*" holds whatever the server names, and vice versa.
  test("wildcard on both sides with differing names → ok, no drift", async () => {
    const check = await grantFor({
      server: { chamber: { osdu: ["*", "osdu_security"] } },
      config: { crossRibGrants: { chamber: { osdu: ["*"] } } },
    });
    expect(check?.status).toBe("ok");
  });

  test("wildcard against an unknown rib → warn", async () => {
    const check = await grantFor({
      server: { chamber: { weather: ["*"] } },
      config: { crossRibGrants: { chamber: { weather: ["*"] } } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("target rib 'weather' is not active");
  });

  test("wildcard against a rib that registers nothing → warn (inert)", async () => {
    const check = await grantFor({
      server: { chamber: { weather: ["*"] } },
      config: { crossRibGrants: { chamber: { weather: ["*"] } } },
      ribs: [chamber, rib({ id: "weather", displayName: "Weather", registered: [] })],
    });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("registers no tools");
  });

  // A self-grant is load-bearing on the ctx.callTool path (which, unlike the
  // agent-turn projection, has no caller === target bypass), so it is validated
  // like any other grant rather than reported inert.
  test("self-grant is validated, not flagged inert", async () => {
    const check = await grantFor({
      server: { osdu: { osdu: ["osdu_security"] } },
      config: { crossRibGrants: { osdu: { osdu: ["osdu_security"] } } },
    });
    expect(check?.status).toBe("ok");
    expect(check?.name).toBe("grant osdu -> osdu");
  });

  test("each caller/target pair reports its own check", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({
        ribs: [chamber, osdu],
        crossRibGrants: { chamber: { osdu: ["osdu_security"] }, osdu: { chamber: ["nope"] } },
      }),
      readConfig: () => ({
        ok: true,
        config: {
          crossRibGrants: { chamber: { osdu: ["osdu_security"] }, osdu: { chamber: ["nope"] } },
        },
      }),
    });
    const grants = result.checks.filter((c) => c.name.startsWith("grant "));
    expect(grants).toHaveLength(2);
    expect(grants.find((c) => c.name === "grant chamber -> osdu")?.status).toBe("ok");
    expect(grants.find((c) => c.name === "grant osdu -> chamber")?.status).toBe("warn");
  });

  // A pair only config.json knows still gets its own check; it must not be
  // dropped just because the server's map never mentions it.
  test("a pair only config.json knows still reports", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({
        ribs: [chamber, osdu],
        crossRibGrants: { chamber: { osdu: ["osdu_security"] } },
      }),
      readConfig: () => ({
        ok: true,
        config: {
          crossRibGrants: {
            chamber: { osdu: ["osdu_security"] },
            osdu: { chamber: ["chamber_room_say"] },
          },
        },
      }),
    });
    const grants = result.checks.filter((c) => c.name.startsWith("grant "));
    expect(grants).toHaveLength(2);
    expect(grants.find((c) => c.name === "grant osdu -> chamber")?.status).toBe("warn");
    expect(grants.find((c) => c.name === "grant osdu -> chamber")?.hint).toContain("restart");
  });
});

// A config.json that exists but fails validation is degraded to {} by the tolerant
// loader, which here would read as "grants nothing" — a positive claim about a file
// the check never managed to read.
describe("cross-rib grants check (config.json rejected)", () => {
  const rejected = () =>
    ({
      ok: false,
      path: "/home/op/.keelson/config.json",
      reason: "Invalid input at crossRibGrants.chamber.osdu",
    }) as const;

  test("rejected config.json → warn, never a clean 'no grants configured' skip", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu], crossRibGrants: {} }),
      readConfig: rejected,
    });
    const check = result.checks.find((c) => c.name === "cross-rib grants");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("rejected");
    expect(check?.detail).toContain("crossRibGrants.chamber.osdu");
    expect(check?.detail).not.toContain("no cross-rib grants configured");
    expect(check?.hint).toContain("/home/op/.keelson/config.json");
  });

  // The server's own grants are still observable, so they are still validated —
  // but every claim that compares them to config.json has to go quiet.
  test("rejected config.json → the server's grants still checked, with no config claims", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({
        ribs: [chamber, osdu],
        crossRibGrants: { chamber: { osdu: ["osdu_qualty"] } },
      }),
      readConfig: rejected,
    });
    const grant = result.checks.find((c) => c.name === "grant chamber -> osdu");
    expect(grant?.status).toBe("warn");
    expect(grant?.detail).toContain("does not register 'osdu_qualty'");
    expect(grant?.detail).not.toContain("config.json");
  });

  test("rejected config.json → a resolving grant reports in force, claiming no durability", async () => {
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({
        ribs: [chamber, osdu],
        crossRibGrants: { chamber: { osdu: ["osdu_security"] } },
      }),
      readConfig: rejected,
    });
    const grant = result.checks.find((c) => c.name === "grant chamber -> osdu");
    expect(grant?.status).toBe("ok");
    expect(grant?.detail).toContain("osdu_security in force");
    expect(grant?.detail).not.toContain("via config.json");
    expect(grant?.detail).not.toContain("survive");
  });
});

// Every test above injects the config read. That default — reading the operator's
// real config.json — is the one production path left in the check, and leaving it
// unexercised is exactly the blind spot that hid the prediction bug.
describe("cross-rib grants check (production config read)", () => {
  const homes: string[] = [];
  const saved = process.env.KEELSON_CONFIG;

  afterEach(() => {
    if (saved === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = saved;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function writeRawConfig(body: string): void {
    const home = mkdtempSync(join(tmpdir(), "keelson-doctor-"));
    homes.push(home);
    const path = join(home, "config.json");
    writeFileSync(path, body);
    process.env.KEELSON_CONFIG = path;
  }

  function writeConfig(config: KeelsonConfig): void {
    writeRawConfig(JSON.stringify(config));
  }

  // The shape that drove this: a string where an array belongs fails the whole
  // file, so the tolerant loader hands the check {} and the declared grant sits
  // inert behind a green `doctor --strict`.
  test("a real config.json that fails validation → warn, not a clean skip", async () => {
    writeRawConfig('{"crossRibGrants":{"chamber":{"osdu":"osdu_security"}}}');
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu], crossRibGrants: {} }),
    });
    const check = result.checks.find((c) => c.name === "cross-rib grants");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("rejected");
  });

  // An unrelated bad key fails the whole file too, taking otherwise-valid grants
  // down with it.
  test("a real config.json failing on an unrelated key → warn, grants not read as absent", async () => {
    writeRawConfig(
      '{"providers":{"claude":"yes"},"crossRibGrants":{"chamber":{"osdu":["osdu_security"]}}}',
    );
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu], crossRibGrants: {} }),
    });
    const check = result.checks.find((c) => c.name === "cross-rib grants");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("rejected");
  });

  test("a missing config.json genuinely declares nothing → skip, not a rejection warn", async () => {
    const home = mkdtempSync(join(tmpdir(), "keelson-doctor-"));
    homes.push(home);
    process.env.KEELSON_CONFIG = join(home, "config.json");
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu], crossRibGrants: {} }),
    });
    const check = result.checks.find((c) => c.name === "cross-rib grants");
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("no cross-rib grants configured");
  });

  test("loadKeelsonConfig default reads config.json and agrees with the server → ok", async () => {
    writeConfig({ crossRibGrants: { chamber: { osdu: ["osdu_security"] } } });
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({
        ribs: [chamber, osdu],
        crossRibGrants: { chamber: { osdu: ["osdu_security"] } },
      }),
    });
    const check = result.checks.find((c) => c.name === "grant chamber -> osdu");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("osdu_security");
  });

  test("loadKeelsonConfig default sees config the server has not applied → warn restart", async () => {
    writeConfig({ crossRibGrants: { chamber: { osdu: ["osdu_security"] } } });
    const result = await runRibsCheck({
      probeServer: async () => info,
      fetchRibs: async () => ({ ribs: [chamber, osdu], crossRibGrants: {} }),
    });
    const check = result.checks.find((c) => c.name === "grant chamber -> osdu");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("restart");
  });
});

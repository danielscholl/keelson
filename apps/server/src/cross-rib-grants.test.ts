// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { KeelsonConfig } from "@keelson/shared/config";
import { isCrossRibGrantAllowed, resolveCrossRibGrants } from "./bootstrap.ts";

const CHAMBER_OSDU: KeelsonConfig = {
  crossRibGrants: { chamber: { osdu: ["osdu_security", "osdu_quality"] } },
};

describe("resolveCrossRibGrants", () => {
  // The reason this reads config at all: an env-only grant lapses the first time
  // the server starts from a shell that never exported it, and the capability it
  // enabled goes quiet with no error.
  test("grants from config alone, with no env var set", () => {
    const grants = resolveCrossRibGrants(CHAMBER_OSDU, {});
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_security")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_quality")).toBe(true);
  });

  test("still denies what no source granted", () => {
    const grants = resolveCrossRibGrants(CHAMBER_OSDU, {});
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_cluster_suspend")).toBe(false);
    expect(isCrossRibGrantAllowed(grants, "squad", "osdu", "osdu_security")).toBe(false);
    expect(
      isCrossRibGrantAllowed(resolveCrossRibGrants({}, {}), "chamber", "osdu", "osdu_security"),
    ).toBe(false);
  });

  test("unions env with config rather than either overriding the other", () => {
    const grants = resolveCrossRibGrants(CHAMBER_OSDU, {
      KEELSON_CROSS_RIB_GRANTS: "chamber:osdu:osdu_events;squad:osdu:osdu_release",
    });
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_security")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_events")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "squad", "osdu", "osdu_release")).toBe(true);
  });

  test("honors a wildcard from config", () => {
    const grants = resolveCrossRibGrants({ crossRibGrants: { chamber: { osdu: ["*"] } } }, {});
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_security")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "anything_osdu_owns")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "chamber", "squad", "squad_code")).toBe(false);
  });

  // A stray space is invisible in a hand-authored config, and an untrimmed name
  // would store fine and then never match — denying a grant the operator set.
  test("normalizes whitespace around config names", () => {
    const grants = resolveCrossRibGrants(
      { crossRibGrants: { " chamber ": { " osdu ": [" osdu_security ", "  "] } } },
      {},
    );
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_security")).toBe(true);
  });

  test("an env-only grant keeps working", () => {
    const grants = resolveCrossRibGrants({}, { KEELSON_CROSS_RIB_GRANTS: "chamber:osdu:*" });
    expect(isCrossRibGrantAllowed(grants, "chamber", "osdu", "osdu_security")).toBe(true);
  });
});

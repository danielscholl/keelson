// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  incompatibleWarning,
  type RibUpdatePass,
  renderRibUpdate,
} from "../src/commands/rib-update.ts";
import type { RibPlanEntry, RibPlanStatus } from "../src/rib-plan.ts";

function entry(status: RibPlanStatus, overrides: Partial<RibPlanEntry> = {}): RibPlanEntry {
  return {
    id: "chamber",
    pkg: "@keelson/rib-chamber",
    source: "https://github.com/acme/keelson-rib-chamber",
    installed: "0.48.0",
    target: { tag: "v0.49.0", version: "0.49.0" },
    status,
    ...overrides,
  };
}

function pass(entries: RibPlanEntry[], overrides: Partial<RibUpdatePass> = {}): RibUpdatePass {
  return {
    entries,
    moved: [],
    applied: false,
    installError: null,
    incompatible: [],
    ...overrides,
  };
}

const APPLY = { check: false, restartRequired: false };
const CHECK = { check: true, restartRequired: false };

describe("renderRibUpdate", () => {
  test("names the version change on both sides", () => {
    expect(renderRibUpdate(pass([entry("updated")]), APPLY)).toEqual(["chamber 0.48.0 → 0.49.0"]);
  });

  // Check mode prints the same status lines as an applied run, so without this
  // it reads as a change that already happened.
  test("check mode says the updates were not applied", () => {
    const lines = renderRibUpdate(pass([entry("updated")]), CHECK);
    expect(lines.join("\n")).toContain("1 rib update(s) available");
    expect(lines.join("\n")).toContain("keelson rib update");
  });

  test("says nothing is available only when every rib was actually checked", () => {
    expect(renderRibUpdate(pass([entry("current")]), CHECK).join("\n")).toContain(
      "no rib updates available",
    );
    const unreadable = renderRibUpdate(
      pass([entry("unreachable", { target: null, reason: "Repository not found." })]),
      CHECK,
    ).join("\n");
    expect(unreadable).toContain("could not be reached");
    expect(unreadable).not.toContain("no rib updates available");
  });

  test("a rib with no releases is reported but does not suppress the summary", () => {
    const lines = renderRibUpdate(pass([entry("no-releases", { target: null })]), CHECK).join("\n");
    expect(lines).toContain("no release tags yet");
    expect(lines).toContain("no rib updates available");
  });

  test("distinguishes adopting a pin from changing versions", () => {
    expect(renderRibUpdate(pass([entry("pinned", { installed: "0.49.0" })]), APPLY)[0]).toContain(
      "was tracking the default branch",
    );
  });

  test("reports a --ref pin as tracking that ref, naming the override", () => {
    const line = renderRibUpdate(
      pass([entry("tracking", { source: "https://github.com/acme/keelson-rib-chamber#main" })]),
      APPLY,
    )[0];
    expect(line).toContain("tracking main");
    expect(line).toContain("--to");
  });

  test("reports an empty home rather than printing nothing at all", () => {
    expect(renderRibUpdate(pass([]), APPLY)).toEqual(["no ribs installed"]);
  });

  test("surfaces the restart notice only when a server is up", () => {
    expect(renderRibUpdate(pass([entry("current")]), APPLY).join("\n")).not.toContain("restart");
    expect(
      renderRibUpdate(pass([entry("current")]), { check: false, restartRequired: true }).join("\n"),
    ).toContain("keelson restart");
  });
});

describe("incompatibleWarning", () => {
  // The rib installs fine and is skipped at boot with only a line in the server
  // log, so the warning has to carry the way back out.
  test("names both versions and the rollback command", () => {
    const warning = incompatibleWarning({
      id: "chamber",
      version: "2.0.0",
      range: ">=1.0.0",
      harness: "0.93.0",
    });
    expect(warning).toContain(">=1.0.0");
    expect(warning).toContain("0.93.0");
    expect(warning).toContain("keelson rib update chamber --to");
  });
});

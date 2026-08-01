// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  isOnDemandProvider,
  isProviderSdkInstalled,
  missingProviderPackages,
  ON_DEMAND_PROVIDER_PACKAGES,
  onDemandProviderIds,
  providerNotInstalledMessage,
} from "../src/sdk-availability.ts";

describe("on-demand provider packages", () => {
  test("copilot and stub ship with the harness", () => {
    expect(isOnDemandProvider("copilot")).toBe(false);
    expect(isOnDemandProvider("stub")).toBe(false);
  });

  test("claude, codex, and pi are installed on demand", () => {
    expect(onDemandProviderIds()).toEqual(["claude", "codex", "pi"]);
  });

  test("a bundled provider reports nothing missing", () => {
    expect(missingProviderPackages("copilot")).toEqual([]);
    expect(isProviderSdkInstalled("copilot")).toBe(true);
  });

  test("an unknown id is treated as bundled rather than missing", () => {
    expect(missingProviderPackages("nope")).toEqual([]);
    expect(isProviderSdkInstalled("nope")).toBe(true);
  });

  // The source checkout carries every SDK as a devDependency, so resolution here
  // proves the resolver finds real packages — not merely that it never throws.
  test("resolves the SDKs the checkout installs", () => {
    for (const id of onDemandProviderIds()) {
      expect(missingProviderPackages(id)).toEqual([]);
      expect(isProviderSdkInstalled(id)).toBe(true);
    }
  });

  test("every on-demand provider names at least one package", () => {
    for (const [id, packages] of Object.entries(ON_DEMAND_PROVIDER_PACKAGES)) {
      expect(packages.length).toBeGreaterThan(0);
      expect(providerNotInstalledMessage(id)).toContain(`keelson provider add ${id}`);
    }
  });
});

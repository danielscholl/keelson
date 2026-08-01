// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { KeelsonConfig } from "@keelson/shared/config";
import { runProvidersCheck } from "../src/checks/providers.ts";

function config(overrides: Partial<KeelsonConfig> = {}): KeelsonConfig {
  return { ...overrides } as KeelsonConfig;
}

const installed = () => true;
const notInstalled = () => false;

describe("providers doctor check", () => {
  test("an enabled provider with its SDK present passes", () => {
    const result = runProvidersCheck({
      loadConfig: () => config({ providers: { claude: true } }),
      isInstalled: installed,
      envProviders: "",
    });
    expect(result.category).toBe("providers");
    const claude = result.checks.find((c) => c.name === "claude");
    expect(claude?.status).toBe("ok");
  });

  test("an enabled provider with no SDK warns and names the fix", () => {
    const result = runProvidersCheck({
      loadConfig: () => config({ providers: { claude: true } }),
      isInstalled: notInstalled,
      envProviders: "",
    });
    const claude = result.checks.find((c) => c.name === "claude");
    expect(claude?.status).toBe("warn");
    expect(claude?.hint).toContain("keelson provider add claude");
  });

  // copilot ships with the harness, so a default install is never "no usable
  // provider" even though no on-demand SDK is present.
  test("the bundled default alone satisfies the usable-provider check", () => {
    const result = runProvidersCheck({
      loadConfig: () => config(),
      isInstalled: notInstalled,
      envProviders: "",
    });
    expect(result.checks.some((c) => c.name === "usable provider")).toBe(false);
  });

  test("warns when nothing enabled is usable and no gateway is configured", () => {
    const result = runProvidersCheck({
      loadConfig: () => config({ providers: { copilot: false, claude: true } }),
      isInstalled: notInstalled,
      envProviders: "",
    });
    const usable = result.checks.find((c) => c.name === "usable provider");
    expect(usable?.status).toBe("warn");
  });

  test("a configured gateway counts as usable", () => {
    const result = runProvidersCheck({
      loadConfig: () =>
        config({
          providers: { copilot: false },
          gateways: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai" }],
        }),
      isInstalled: notInstalled,
      envProviders: "",
    });
    expect(result.checks.some((c) => c.name === "usable provider")).toBe(false);
  });

  test("skips cleanly when only bundled providers are enabled", () => {
    const result = runProvidersCheck({
      loadConfig: () => config(),
      isInstalled: notInstalled,
      envProviders: "",
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("skip");
  });
});

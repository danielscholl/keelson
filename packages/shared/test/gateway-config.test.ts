// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gatewayConfigSchema,
  gatewayCredentialServiceId,
  loadKeelsonConfig,
  updateKeelsonConfigGateways,
} from "../src/config.ts";

describe("gatewayConfigSchema", () => {
  test("accepts a valid gateway and defaults protocol to openai", () => {
    const parsed = gatewayConfigSchema.parse({
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(parsed).toEqual({
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      protocol: "openai",
    });
  });

  test("rejects a name that collides with a built-in provider", () => {
    for (const name of ["claude", "copilot", "stub", "workflow"]) {
      expect(gatewayConfigSchema.safeParse({ name, baseUrl: "http://h/v1" }).success).toBe(false);
    }
  });

  test("rejects a non-kebab name and a non-http(s) url", () => {
    expect(gatewayConfigSchema.safeParse({ name: "Ollama", baseUrl: "http://h/v1" }).success).toBe(
      false,
    );
    expect(gatewayConfigSchema.safeParse({ name: "ok", baseUrl: "ftp://h/v1" }).success).toBe(
      false,
    );
    expect(gatewayConfigSchema.safeParse({ name: "ok", baseUrl: "not a url" }).success).toBe(false);
  });
});

describe("gatewayCredentialServiceId", () => {
  test("namespaces the keychain account under gateway-", () => {
    expect(gatewayCredentialServiceId("ollama")).toBe("gateway-ollama");
    expect(gatewayCredentialServiceId("open-router")).toBe("gateway-open-router");
  });
});

describe("updateKeelsonConfigGateways", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-gw-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  const path = () => join(home, "config.json");

  test("creates config.json with the gateway when none existed", () => {
    const next = updateKeelsonConfigGateways(
      (g) => [...g, { name: "ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai" }],
      home,
    );
    expect(next).toEqual([
      { name: "ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai" },
    ]);
    expect(loadKeelsonConfig(home).gateways).toEqual(next);
  });

  test("preserves unknown and known top-level keys", () => {
    writeFileSync(
      path(),
      JSON.stringify({ providers: { claude: true }, defaultProvider: "claude", customKey: 42 }),
    );
    updateKeelsonConfigGateways(
      (g) => [...g, { name: "g", baseUrl: "http://h/v1", protocol: "openai" }],
      home,
    );
    const raw = JSON.parse(readFileSync(path(), "utf8"));
    expect(raw.providers).toEqual({ claude: true });
    expect(raw.defaultProvider).toBe("claude");
    expect(raw.customKey).toBe(42);
    expect(raw.gateways).toHaveLength(1);
  });

  test("removing the last gateway drops the gateways key entirely", () => {
    updateKeelsonConfigGateways(
      () => [{ name: "g", baseUrl: "http://h/v1", protocol: "openai" }],
      home,
    );
    updateKeelsonConfigGateways((g) => g.filter((x) => x.name !== "g"), home);
    const raw = JSON.parse(readFileSync(path(), "utf8"));
    expect(raw.gateways).toBeUndefined();
  });

  test("refuses to overwrite a config.json that isn't valid JSON", () => {
    writeFileSync(path(), "{ not json");
    expect(() =>
      updateKeelsonConfigGateways((g) => [...g, { name: "g", baseUrl: "http://h/v1" }], home),
    ).toThrow(/refusing to overwrite/);
    // The bad file is left untouched.
    expect(readFileSync(path(), "utf8")).toBe("{ not json");
  });

  test("validates the result and rejects a malformed gateway", () => {
    expect(() =>
      updateKeelsonConfigGateways(
        () => [{ name: "BAD NAME", baseUrl: "http://h/v1" } as never],
        home,
      ),
    ).toThrow();
  });
});

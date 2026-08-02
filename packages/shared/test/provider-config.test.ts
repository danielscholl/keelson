// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKeelsonConfig,
  readKeelsonConfig,
  readModelClassOverride,
  updateKeelsonConfigProviders,
} from "../src/config.ts";

describe("updateKeelsonConfigProviders", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-prov-"));
    delete process.env.KEELSON_CONFIG;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  const path = () => join(home, "config.json");
  const read = () => JSON.parse(readFileSync(path(), "utf8")) as Record<string, unknown>;

  test("creates config.json enabling a provider that defaults off", () => {
    expect(updateKeelsonConfigProviders({ claude: true }, home)).toEqual({ claude: true });
    expect(read().providers).toEqual({ claude: true });
    expect(loadKeelsonConfig(home).providers?.claude).toBe(true);
  });

  test("preserves unrelated keys", () => {
    writeFileSync(
      path(),
      JSON.stringify({ defaultProvider: "copilot", gateways: [], custom: { keep: 1 } }),
    );
    updateKeelsonConfigProviders({ codex: true }, home);
    const raw = read();
    expect(raw.defaultProvider).toBe("copilot");
    expect(raw.custom).toEqual({ keep: 1 });
    expect(raw.providers).toEqual({ codex: true });
  });

  // config.json records deviations from the defaults, so returning a provider to
  // its default drops the key rather than pinning the current default forever.
  test("setting a provider back to its default drops the key", () => {
    updateKeelsonConfigProviders({ claude: true }, home);
    updateKeelsonConfigProviders({ claude: false }, home);
    expect(read().providers).toBeUndefined();
  });

  test("disabling a default-on provider is recorded", () => {
    updateKeelsonConfigProviders({ copilot: false }, home);
    expect(read().providers).toEqual({ copilot: false });
  });

  test("merges into an existing providers map", () => {
    updateKeelsonConfigProviders({ claude: true }, home);
    updateKeelsonConfigProviders({ codex: true }, home);
    expect(read().providers).toEqual({ claude: true, codex: true });
  });

  test("refuses to clobber a config.json that is not valid JSON", () => {
    writeFileSync(path(), "{ not json");
    expect(() => updateKeelsonConfigProviders({ claude: true }, home)).toThrow(/not valid JSON/);
  });

  test("refuses to clobber a config.json that is not an object", () => {
    writeFileSync(path(), "[1,2,3]");
    expect(() => updateKeelsonConfigProviders({ claude: true }, home)).toThrow(/not a JSON object/);
  });
});

describe("model class overrides", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-model-classes-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  test("loads built-in and gateway overrides by provider id", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        claude: { modelClasses: { deep: "claude-custom" } },
        copilot: { modelClasses: { fast: "copilot-fast", balanced: "copilot-balanced" } },
        gateways: [
          {
            name: "local",
            baseUrl: "http://localhost:11434/v1",
            modelClasses: { balanced: "qwen3" },
          },
        ],
      }),
    );

    const config = loadKeelsonConfig(home);
    expect(readModelClassOverride(config, "claude")).toEqual({ deep: "claude-custom" });
    expect(readModelClassOverride(config, "copilot")).toEqual({
      fast: "copilot-fast",
      balanced: "copilot-balanced",
    });
    expect(readModelClassOverride(config, "local")).toEqual({ balanced: "qwen3" });
    expect(readModelClassOverride(config, "codex")).toBeUndefined();
    expect(readModelClassOverride(config, "missing")).toBeUndefined();
  });

  test("rejects empty model class ids", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ claude: { modelClasses: { deep: "" } } }),
    );

    const result = readKeelsonConfig(home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("claude.modelClasses.deep");
  });

  test("rejects unknown model class keys", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ claude: { modelClasses: { fastt: "claude-custom" } } }),
    );

    const result = readKeelsonConfig(home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("fastt");
  });
});

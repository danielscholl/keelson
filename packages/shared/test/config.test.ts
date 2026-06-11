// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILT_IN_PROVIDER_IDS,
  type KeelsonConfig,
  loadKeelsonConfig,
  resolveDefaultProvider,
  resolveEnabledProviders,
} from "../src/config.ts";

const KNOWN = BUILT_IN_PROVIDER_IDS;
const silent = () => {};

describe("loadKeelsonConfig", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-config-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  function writeConfig(body: string): void {
    writeFileSync(join(home, "config.json"), body);
  }

  test("missing file returns an empty config (defaults apply)", () => {
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("reads a valid config", () => {
    writeConfig(JSON.stringify({ providers: { claude: true }, defaultProvider: "claude" }));
    expect(loadKeelsonConfig(home)).toEqual({
      providers: { claude: true },
      defaultProvider: "claude",
    });
  });

  test("invalid JSON degrades to {} without throwing", () => {
    writeConfig("{ not json");
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("shape mismatch degrades to {} without throwing", () => {
    // providers values must be booleans
    writeConfig(JSON.stringify({ providers: { claude: "yes" } }));
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("unknown top-level keys are stripped, known ones kept", () => {
    writeConfig(JSON.stringify({ defaultProvider: "copilot", future: { x: 1 } }));
    expect(loadKeelsonConfig(home)).toEqual({ defaultProvider: "copilot" });
  });

  test("KEELSON_CONFIG overrides the home path", () => {
    const other = mkdtempSync(join(tmpdir(), "keelson-config-alt-"));
    try {
      writeFileSync(join(other, "config.json"), JSON.stringify({ defaultProvider: "stub" }));
      process.env.KEELSON_CONFIG = join(other, "config.json");
      expect(loadKeelsonConfig(home)).toEqual({ defaultProvider: "stub" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("resolveEnabledProviders", () => {
  test("empty config → defaults: copilot + stub, claude off", () => {
    const enabled = resolveEnabledProviders({ config: {}, known: KNOWN, onWarn: silent });
    expect(enabled).toEqual(["stub", "copilot"]);
  });

  test("config flips claude on and copilot off", () => {
    const config: KeelsonConfig = { providers: { claude: true, copilot: false } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "stub",
      "claude",
    ]);
  });

  test("output preserves canonical (known) order, not config order", () => {
    const config: KeelsonConfig = { providers: { claude: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "stub",
      "copilot",
      "claude",
    ]);
  });

  test("KEELSON_PROVIDERS env is an exact override, ignoring config + defaults", () => {
    const config: KeelsonConfig = { providers: { claude: true, copilot: false } };
    expect(
      resolveEnabledProviders({ config, envProviders: "claude", known: KNOWN, onWarn: silent }),
    ).toEqual(["claude"]);
  });

  test("env override: dedupes, lowercases, drops unknowns", () => {
    expect(
      resolveEnabledProviders({
        config: {},
        envProviders: "STUB, copilot ,stub,nope",
        known: KNOWN,
        onWarn: silent,
      }),
    ).toEqual(["stub", "copilot"]);
  });

  test("empty/whitespace env falls through to config/defaults (not an empty list)", () => {
    expect(
      resolveEnabledProviders({ config: {}, envProviders: "   ", known: KNOWN, onWarn: silent }),
    ).toEqual(["stub", "copilot"]);
  });

  test("unknown provider in config map is ignored", () => {
    const config: KeelsonConfig = { providers: { pi: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "stub",
      "copilot",
    ]);
  });

  test("disabling stub leaves only copilot by default", () => {
    const config: KeelsonConfig = { providers: { stub: false } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual(["copilot"]);
  });
});

describe("resolveDefaultProvider", () => {
  test("honors config.defaultProvider when registered", () => {
    expect(
      resolveDefaultProvider({ defaultProvider: "claude" }, ["stub", "copilot", "claude"]),
    ).toBe("claude");
  });

  test("ignores config.defaultProvider when not registered, prefers copilot", () => {
    expect(resolveDefaultProvider({ defaultProvider: "claude" }, ["stub", "copilot"])).toBe(
      "copilot",
    );
  });

  test("prefers copilot when no config preference", () => {
    expect(resolveDefaultProvider({}, ["stub", "copilot", "claude"])).toBe("copilot");
  });

  test("falls to first real provider when copilot absent (claude-only)", () => {
    expect(resolveDefaultProvider({}, ["stub", "claude"])).toBe("claude");
  });

  test("falls to stub when nothing real is registered", () => {
    expect(resolveDefaultProvider({}, ["stub", "workflow"])).toBe("stub");
  });

  test("returns undefined when nothing is registered", () => {
    expect(resolveDefaultProvider({}, [])).toBeUndefined();
  });

  test("never returns the synthetic 'workflow' provider as the default", () => {
    expect(resolveDefaultProvider({}, ["workflow"])).toBeUndefined();
    expect(resolveDefaultProvider({ defaultProvider: "workflow" }, ["workflow"])).toBeUndefined();
  });
});

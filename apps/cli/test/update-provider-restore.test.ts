// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providersNeedingRestore } from "../src/commands/update.ts";

describe("providersNeedingRestore", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-restore-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  const writeConfig = (config: unknown) =>
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const nothingInstalled = () => false;
  const everythingInstalled = () => true;

  test("an enabled provider with a pruned SDK is flagged", () => {
    writeConfig({ providers: { claude: true } });
    expect(providersNeedingRestore(home, nothingInstalled)).toEqual(["claude"]);
  });

  test("an enabled provider whose SDK is present is left alone", () => {
    writeConfig({ providers: { claude: true } });
    expect(providersNeedingRestore(home, everythingInstalled)).toEqual([]);
  });

  test("a disabled provider is never restored", () => {
    writeConfig({ providers: { claude: false, codex: false } });
    expect(providersNeedingRestore(home, nothingInstalled)).toEqual([]);
  });

  // The default install enables copilot only, which ships with the harness —
  // an untouched home must not pull several hundred MB on every update.
  test("a default home restores nothing", () => {
    writeConfig({});
    expect(providersNeedingRestore(home, nothingInstalled)).toEqual([]);
  });

  test("no config.json at all restores nothing", () => {
    expect(providersNeedingRestore(home, nothingInstalled)).toEqual([]);
  });

  test("multiple enabled providers are all flagged", () => {
    writeConfig({ providers: { claude: true, codex: true, pi: true } });
    expect(providersNeedingRestore(home, nothingInstalled).sort()).toEqual([
      "claude",
      "codex",
      "pi",
    ]);
  });

  // pi needs two packages; losing either one means the provider cannot load.
  test("a partially-pruned multi-package provider is flagged", () => {
    writeConfig({ providers: { pi: true } });
    const onlyCodingAgent = (path: string) => path.includes("pi-coding-agent");
    expect(providersNeedingRestore(home, onlyCodingAgent)).toEqual(["pi"]);
  });

  test("a malformed config.json does not throw", () => {
    writeFileSync(join(home, "config.json"), "{ not json");
    expect(providersNeedingRestore(home, nothingInstalled)).toEqual([]);
  });
});

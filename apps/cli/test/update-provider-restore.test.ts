// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providersNeedingRestore, providersOutOfRange } from "../src/commands/update.ts";

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

describe("providersOutOfRange", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-drift-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  const setup = (providers: Record<string, boolean>, peers: Record<string, string>) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ providers }));
    const cli = join(home, "node_modules", "@keelson", "cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "package.json"), JSON.stringify({ peerDependencies: peers }));
  };
  const versions =
    (installed: Record<string, string>) =>
    (_home: string, pkg: string): string | null =>
      installed[pkg] ?? null;

  test("an enabled provider left below the CLI's range is flagged", () => {
    setup({ codex: true }, { "@openai/codex-sdk": "^0.163.0" });
    expect(providersOutOfRange(home, versions({ "@openai/codex-sdk": "0.144.6" }))).toEqual([
      "codex",
    ]);
  });

  test("an SDK inside the range is left alone", () => {
    setup({ codex: true }, { "@openai/codex-sdk": "^0.163.0" });
    expect(providersOutOfRange(home, versions({ "@openai/codex-sdk": "0.163.4" }))).toEqual([]);
  });

  test("a disabled provider is never upgraded", () => {
    setup({ codex: false }, { "@openai/codex-sdk": "^0.163.0" });
    expect(providersOutOfRange(home, versions({ "@openai/codex-sdk": "0.144.6" }))).toEqual([]);
  });

  // Bun.semver.satisfies matches every version against a malformed range.
  test("a malformed peer range flags nothing", () => {
    setup({ codex: true }, { "@openai/codex-sdk": "not a range" });
    expect(providersOutOfRange(home, versions({ "@openai/codex-sdk": "0.144.6" }))).toEqual([]);
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NPM_REGISTRY,
  effectiveRegistry,
  parseNpmrcRegistry,
} from "../src/npm-registry.ts";

describe("parseNpmrcRegistry", () => {
  test("reads a registry assignment, tolerating whitespace", () => {
    expect(parseNpmrcRegistry("registry=https://feed.example.com/npm/")).toBe(
      "https://feed.example.com/npm/",
    );
    expect(parseNpmrcRegistry("registry = https://feed.example.com/npm/")).toBe(
      "https://feed.example.com/npm/",
    );
  });

  test("ignores comments and scoped registry lines", () => {
    const content = [
      "# registry=https://commented.example.com/",
      "; registry=https://also-commented.example.com/",
      "@scope:registry=https://scoped.example.com/",
      "//npm.pkg.github.com/:_authToken=abc",
    ].join("\n");
    expect(parseNpmrcRegistry(content)).toBeNull();
  });

  test("returns null for content without a registry line", () => {
    expect(parseNpmrcRegistry("")).toBeNull();
    expect(parseNpmrcRegistry("save-exact=true\n")).toBeNull();
  });
});

describe("effectiveRegistry", () => {
  const roots: string[] = [];
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keelson-npmrc-"));
    roots.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  test("dir .npmrc wins over the user's", () => {
    const dir = tempDir();
    const home = tempDir();
    writeFileSync(join(dir, ".npmrc"), "registry=https://dir.example.com/\n");
    writeFileSync(join(home, ".npmrc"), "registry=https://home.example.com/\n");
    expect(effectiveRegistry(dir, home)).toBe("https://dir.example.com/");
  });

  test("falls back to the user's .npmrc, then the npmjs default", () => {
    const dir = tempDir();
    const home = tempDir();
    writeFileSync(join(home, ".npmrc"), "registry=https://home.example.com/\n");
    expect(effectiveRegistry(dir, home)).toBe("https://home.example.com/");

    const bare = tempDir();
    const bareHome = join(bare, "no-such-home");
    mkdirSync(bareHome);
    expect(effectiveRegistry(bare, bareHome)).toBe(DEFAULT_NPM_REGISTRY);
  });
});

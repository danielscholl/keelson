// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NPM_REGISTRY,
  displayRegistry,
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

  test("last assignment wins, matching npmrc INI semantics", () => {
    const content = "registry=https://first.example.com/\nregistry=https://second.example.com/\n";
    expect(parseNpmrcRegistry(content)).toBe("https://second.example.com/");
  });

  test("strips surrounding quotes", () => {
    expect(parseNpmrcRegistry('registry="https://quoted.example.com/"')).toBe(
      "https://quoted.example.com/",
    );
    expect(parseNpmrcRegistry("registry='https://quoted.example.com/'")).toBe(
      "https://quoted.example.com/",
    );
  });

  test("expands ${VAR}, leaves undefined literal, empties undefined ${VAR?}", () => {
    const env = { CORP_FEED: "https://corp.example.com/npm/" };
    expect(parseNpmrcRegistry("registry=${CORP_FEED}", env)).toBe("https://corp.example.com/npm/");
    expect(parseNpmrcRegistry("registry=${MISSING_FEED}", env)).toBe("${MISSING_FEED}");
    // ${VAR?} expanding to empty leaves an earlier assignment standing.
    expect(
      parseNpmrcRegistry("registry=https://kept.example.com/\nregistry=${MISSING_FEED?}", env),
    ).toBe("https://kept.example.com/");
  });
});

describe("displayRegistry", () => {
  test("strips userinfo, query, and fragment", () => {
    expect(displayRegistry("https://user:hunter2@feed.example.com/npm/?token=abc#frag")).toBe(
      "https://feed.example.com/npm/",
    );
  });

  test("leaves clean URLs and non-URL strings untouched", () => {
    expect(displayRegistry("https://registry.npmjs.org/")).toBe("https://registry.npmjs.org/");
    expect(displayRegistry("not a url")).toBe("not a url");
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

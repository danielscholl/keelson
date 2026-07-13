// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForge } from "./forge-support.ts";

// `forge caps` with no --require prints the detected forge kind and exits 0
// without touching gh/glab — the cheapest window into forge_kind().

let repo: string;

function git(args: string[]): void {
  const p = Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function detect(env: Record<string, string> = {}): string {
  return runForge(["caps"], { cwd: repo, env }).stdout.trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "keelson-forge-detect-"));
  git(["init", "-q"]);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("forge detection (from git remote host)", () => {
  const cases: Array<[string, string, string]> = [
    ["github ssh", "git@github.com:o/r.git", "github"],
    ["github https", "https://github.com/o/r.git", "github"],
    ["github enterprise vanity segment", "https://github.corp.example/o/r.git", "github"],
    ["gitlab https", "https://gitlab.com/g/s/r.git", "gitlab"],
    ["gitlab ssh", "git@gitlab.internal.net:g/r.git", "gitlab"],
    ["gitlab ssh:// scheme", "ssh://git@gitlab.example.com/g/r.git", "gitlab"],
    // Unknown host is the incumbent gh (byte-for-byte), never an error.
    ["unknown host -> github", "https://bitbucket.org/o/r.git", "github"],
  ];
  for (const [name, url, expected] of cases) {
    test(name, () => {
      git(["remote", "add", "origin", url]);
      expect(detect()).toBe(expected);
    });
  }

  test("no remote defaults to github (incumbent)", () => {
    expect(detect()).toBe("github");
  });

  test("KEELSON_FORGE=gitlab overrides a github remote", () => {
    git(["remote", "add", "origin", "https://github.com/o/r.git"]);
    expect(detect({ KEELSON_FORGE: "gitlab" })).toBe("gitlab");
  });

  test("KEELSON_FORGE=github overrides a gitlab remote", () => {
    git(["remote", "add", "origin", "https://gitlab.com/g/r.git"]);
    expect(detect({ KEELSON_FORGE: "github" })).toBe("github");
  });

  test("a non-forge path segment does not misfire (segment match, not substring)", () => {
    // 'gitlab' appears only in the path, not as a host segment.
    git(["remote", "add", "origin", "https://example.com/gitlab/r.git"]);
    expect(detect()).toBe("github");
  });
});

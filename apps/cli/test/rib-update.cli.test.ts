// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lsRemoteTags } from "../src/rib-version.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

async function runCli(args: readonly string[], home: string) {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      KEELSON_HOME: home,
      KEELSON_CONFIG: join(home, "config.json"),
      // Port 1 is privileged and never bound, so the server probe is refused.
      KEELSON_SERVER_URL: "http://127.0.0.1:1",
      KEELSON_BIN_DIR: join(home, "bin"),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keelson-ribupd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedHome(deps: Record<string, string>): void {
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify(
      {
        name: "keelson-home",
        private: true,
        dependencies: {
          "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/cli.tgz",
          ...deps,
        },
      },
      null,
      2,
    ),
  );
}

// Exercises the real `git ls-remote` subprocess without reaching the network: a
// local repo is a valid remote as far as git is concerned.
describe("lsRemoteTags against a real git remote", () => {
  test("reads a repo's tags, and an empty repo is resolved-but-empty", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    await git(["init", "--quiet"], repo);
    writeFileSync(join(repo, "f"), "x");
    await git(["add", "."], repo);
    await git(["commit", "--quiet", "-m", "c"], repo);

    const empty = await lsRemoteTags(repo);
    expect(empty).toEqual({ kind: "resolved", tags: [] });

    await git(["tag", "v0.1.0"], repo);
    await git(["tag", "v0.2.0"], repo);
    const resolved = await lsRemoteTags(repo);
    expect(resolved.kind).toBe("resolved");
    expect(resolved.kind === "resolved" && resolved.tags.sort()).toEqual(["v0.1.0", "v0.2.0"]);
  });

  // The load-bearing distinction: a remote we cannot read reports why, and is
  // never flattened into the empty-tag-list case above.
  test("reports a remote it cannot read as unreachable, with a reason", async () => {
    const missing = await lsRemoteTags(join(home, "definitely-not-a-repo"));
    expect(missing.kind).toBe("unreachable");
    expect(missing.kind === "unreachable" && missing.reason.length).toBeGreaterThan(0);
  });
});

describe("keelson rib update", () => {
  test("rejects --to without exactly one rib id", async () => {
    seedHome({ "@keelson/rib-a": "github:acme/keelson-rib-a" });
    const result = await runCli(["--json", "rib", "update", "--to", "1.0.0"], home);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error).toContain("exactly one rib id");
  });

  test("rejects a rib that is not installed rather than silently doing nothing", async () => {
    seedHome({ "@keelson/rib-a": "github:acme/keelson-rib-a" });
    const result = await runCli(["--json", "rib", "update", "nope"], home);
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).error).toContain("nope");
  });

  test("reports a home with no ribs without touching the network", async () => {
    seedHome({});
    const result = await runCli(["--json", "rib", "update", "--check"], home);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.ribs).toEqual([]);
  });

  // Reporting "no rib updates available" here would describe a search that did
  // not happen, and exit 0 would let a scripted update call it clean.
  test("a rib it cannot read fails the run and never reads as nothing-to-do", async () => {
    // Port 1 is never bound, so the clone is refused without a DNS lookup.
    seedHome({ "@keelson/rib-ghost": "https://127.0.0.1:1/acme/keelson-rib-ghost" });
    const result = await runCli(["rib", "update", "--check"], home);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("could not be reached");
    expect(result.stdout).not.toContain("no rib updates available");
  });

  // A local path is a legitimate rib source that releases do not apply to, so
  // the plan reports it instead of trying to resolve tags for it.
  test("reports a path-sourced rib as unpinnable", async () => {
    seedHome({ "@keelson/rib-local": join(home, "some-rib") });
    const result = await runCli(["--json", "rib", "update", "--check"], home);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.ribs).toEqual([
      { id: "local", status: "unpinnable", from: null, to: null, tag: null },
    ]);
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import cliPkg from "../package.json" with { type: "json" };
import {
  applyManifestVersion,
  parseMissingVersions,
  parseTagVersion,
  readWorkflowContents,
  reconcileManagedWorkflows,
  releaseAssetUrls,
  ribDependencies,
  selectReleaseNotes,
} from "../src/commands/update.ts";
import { spawnEnv } from "./spawn-env.ts";

describe("update pure helpers", () => {
  test("parseMissingVersions extracts quarantined pins from bun install output", () => {
    const stderr = [
      "bun install v1.3.13 (bf2e2cec)",
      'error: No version matching "0.80.6" found for specifier "@earendil-works/pi-tui" (but package exists)',
      "",
      'error: No version matching "^0.144.1" found for specifier "@openai/codex-sdk" (but package exists)',
      "error: @earendil-works/pi-tui@0.80.6 failed to resolve",
      "error: @openai/codex-sdk@^0.144.1 failed to resolve",
    ].join("\n");
    expect(parseMissingVersions(stderr)).toEqual([
      { pkg: "@earendil-works/pi-tui", range: "0.80.6" },
      { pkg: "@openai/codex-sdk", range: "^0.144.1" },
    ]);
  });

  test("parseMissingVersions dedupes repeats and ignores unrelated failures", () => {
    const repeated =
      'error: No version matching "1.0.0" found for specifier "left-pad" (but package exists)\n'.repeat(
        3,
      );
    expect(parseMissingVersions(repeated)).toEqual([{ pkg: "left-pad", range: "1.0.0" }]);
    expect(parseMissingVersions('error: package "ghost" not found')).toEqual([]);
    expect(parseMissingVersions("")).toEqual([]);
  });

  test("parseTagVersion strips a leading v and rejects non-semver", () => {
    expect(parseTagVersion("v0.2.0")).toBe("0.2.0");
    expect(parseTagVersion("0.2.0")).toBe("0.2.0");
    expect(parseTagVersion("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(parseTagVersion("nightly")).toBeNull();
  });

  test("releaseAssetUrls builds versioned download URLs", () => {
    const { cli, shared } = releaseAssetUrls("acme/keelson", "0.2.0");
    expect(cli).toBe("https://github.com/acme/keelson/releases/download/v0.2.0/keelson-cli.tgz");
    expect(shared).toBe(
      "https://github.com/acme/keelson/releases/download/v0.2.0/keelson-shared.tgz",
    );
  });

  test("applyManifestVersion re-pins cli+shared and preserves ribs, without mutating input", () => {
    const manifest = {
      name: "keelson-home",
      dependencies: {
        "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
        "@keelson/shared":
          "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-shared.tgz",
        "@keelson/rib-osdu": "github:danielscholl/keelson-rib-osdu",
      },
    };
    const next = applyManifestVersion(manifest, "acme/keelson", "0.2.0");
    expect(next.dependencies?.["@keelson/cli"]).toContain("/v0.2.0/keelson-cli.tgz");
    expect(next.dependencies?.["@keelson/shared"]).toContain("/v0.2.0/keelson-shared.tgz");
    expect(next.dependencies?.["@keelson/rib-osdu"]).toBe("github:danielscholl/keelson-rib-osdu");
    // input untouched (pure)
    expect(manifest.dependencies["@keelson/cli"]).toContain("/v0.1.0/keelson-cli.tgz");
  });

  test("ribDependencies returns every rib dep regardless of source form, never the harness deps", () => {
    const manifest = {
      dependencies: {
        "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
        "@keelson/shared":
          "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-shared.tgz",
        "@keelson/rib-osdu": "https://github.com/danielscholl/keelson-rib-osdu",
        "@keelson/rib-chamber": "github:danielscholl/keelson-rib-chamber",
        "@keelson/rib-acme": "acme/keelson-rib-acme",
        "@keelson/rib-local": "/tmp/some/path.tgz",
      },
    };
    expect(ribDependencies(manifest)).toEqual([
      "@keelson/rib-acme",
      "@keelson/rib-chamber",
      "@keelson/rib-local",
      "@keelson/rib-osdu",
    ]);
  });

  test("selectReleaseNotes returns the window (current, latest] oldest-first", () => {
    const releases = [
      { tag_name: "v0.3.0", body: "B3" },
      { tag_name: "v0.1.0", body: "B1" },
      { tag_name: "v0.2.0", body: "B2" },
    ];
    const notes = selectReleaseNotes(releases, "0.1.0", "0.3.0");
    expect(notes).toContain("## v0.2.0");
    expect(notes).toContain("## v0.3.0");
    expect(notes).toContain("B2");
    expect(notes).toContain("B3");
    expect(notes).not.toContain("## v0.1.0");
    expect(notes.indexOf("v0.2.0")).toBeLessThan(notes.indexOf("v0.3.0"));
    expect(selectReleaseNotes(releases, "0.3.0", "0.3.0")).toBe("");
  });
});

describe("reconcileManagedWorkflows", () => {
  test("refreshes an unmodified managed workflow", () => {
    const overlayDir = mkdtempSync(join(tmpdir(), "keelson-update-workflows-"));
    const previous = new Map([["fix-issue.yaml", "old bundle\n"]]);
    const next = new Map([["fix-issue.yaml", "new bundle\n"]]);
    writeFileSync(join(overlayDir, "fix-issue.yaml"), "old bundle\n");

    expect(reconcileManagedWorkflows(overlayDir, previous, next)).toEqual({
      refreshed: ["fix-issue.yaml"],
      conflicts: [],
    });
    expect(readFileSync(join(overlayDir, "fix-issue.yaml"), "utf8")).toBe("new bundle\n");
    rmSync(overlayDir, { recursive: true, force: true });
  });

  test("preserves and reports a customized workflow", () => {
    const overlayDir = mkdtempSync(join(tmpdir(), "keelson-update-workflows-"));
    const previous = new Map([["fix-issue.yaml", "old bundle\n"]]);
    const next = new Map([["fix-issue.yaml", "new bundle\n"]]);
    writeFileSync(join(overlayDir, "fix-issue.yaml"), "my customization\n");

    expect(reconcileManagedWorkflows(overlayDir, previous, next)).toEqual({
      refreshed: [],
      conflicts: ["fix-issue.yaml"],
    });
    expect(readFileSync(join(overlayDir, "fix-issue.yaml"), "utf8")).toBe("my customization\n");
    rmSync(overlayDir, { recursive: true, force: true });
  });

  test("does nothing when an overlay workflow is already current", () => {
    const overlayDir = mkdtempSync(join(tmpdir(), "keelson-update-workflows-"));
    const previous = new Map([["fix-issue.yaml", "old bundle\n"]]);
    const next = new Map([["fix-issue.yaml", "new bundle\n"]]);
    writeFileSync(join(overlayDir, "fix-issue.yaml"), "new bundle\n");

    expect(reconcileManagedWorkflows(overlayDir, previous, next)).toEqual({
      refreshed: [],
      conflicts: [],
    });
    rmSync(overlayDir, { recursive: true, force: true });
  });

  test("does not create an overlay for a bundle-only workflow", () => {
    const overlayDir = mkdtempSync(join(tmpdir(), "keelson-update-workflows-"));
    const next = new Map([["finish-pr.yaml", "new bundle\n"]]);

    expect(reconcileManagedWorkflows(overlayDir, new Map(), next)).toEqual({
      refreshed: [],
      conflicts: [],
    });
    expect(existsSync(join(overlayDir, "finish-pr.yaml"))).toBe(false);
    rmSync(overlayDir, { recursive: true, force: true });
  });

  test("reads only workflow YAML files and tolerates a missing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-update-workflows-"));
    writeFileSync(join(dir, "fix-issue.yaml"), "workflow\n");
    writeFileSync(join(dir, "notes.txt"), "ignore\n");

    expect(readWorkflowContents(join(dir, "missing"))).toEqual(new Map());
    expect(readWorkflowContents(dir)).toEqual(new Map([["fix-issue.yaml", "workflow\n"]]));
    rmSync(dir, { recursive: true, force: true });
  });
});

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const TEST_REPO = "acme/keelson";
const CURRENT = cliPkg.version;

async function runCli(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(env),
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("keelson update (e2e against a mock releases API)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let apiBase: string;
  let latestTag = "v999.0.0";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === `/repos/${TEST_REPO}/releases/latest`) {
          return Response.json({ tag_name: latestTag, body: "### Added\n- a shiny thing" });
        }
        if (pathname === `/repos/${TEST_REPO}/releases`) {
          return Response.json([{ tag_name: latestTag, body: "### Added\n- a shiny thing" }]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    apiBase = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
  });

  function installedHome(): string {
    const home = join(mkdtempSync(join(tmpdir(), "keelson-update-")), "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "package.json"),
      `${JSON.stringify(
        {
          name: "keelson-home",
          private: true,
          dependencies: {
            "@keelson/cli":
              "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
          },
        },
        null,
        2,
      )}\n`,
    );
    return home;
  }

  const env = (home: string) => ({
    KEELSON_HOME: home,
    KEELSON_UPDATE_API: apiBase,
    KEELSON_UPDATE_REPO: TEST_REPO,
  });

  test("a source checkout / non-installed home exits 1 NOT_INSTALLED", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "keelson-update-bare-")), "home");
    mkdirSync(home, { recursive: true }); // no package.json
    const { stdout, exitCode } = await runCli(["--json", "update"], env(home));
    expect(exitCode).toBe(1);
    const out = JSON.parse(stdout.trim());
    expect(out.ok).toBe(false);
    expect(out.code).toBe("NOT_INSTALLED");
    rmSync(home, { recursive: true, force: true });
  });

  test("--check reports an available update without applying", async () => {
    latestTag = "v999.0.0";
    const home = installedHome();
    const { stdout, exitCode } = await runCli(["--json", "update", "--check"], env(home));
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.data.updateAvailable).toBe(true);
    expect(out.data.updated).toBe(false);
    expect(out.data.latest).toBe("999.0.0");
    expect(out.data.notes).toContain("999.0.0");
    rmSync(home, { recursive: true, force: true });
  });

  test("non-check update refreshes unchanged overlays and preserves customized ones", async () => {
    latestTag = "v999.0.1";
    const root = mkdtempSync(join(tmpdir(), "keelson-update-apply-"));
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const bundleDir = join(home, "node_modules", "@keelson", "cli", "assets", "workflows");
    const overlayDir = join(home, "workflows");

    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(overlayDir, { recursive: true });
      writeFileSync(
        join(home, "package.json"),
        `${JSON.stringify(
          {
            name: "keelson-home",
            private: true,
            dependencies: {
              "@keelson/cli":
                "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(bundleDir, "fix-issue.yaml"), "old shared workflow\n");
      writeFileSync(join(bundleDir, "customize.yaml"), "old customizable workflow\n");
      writeFileSync(join(overlayDir, "fix-issue.yaml"), "old shared workflow\n");
      writeFileSync(join(overlayDir, "customize.yaml"), "my customization\n");

      const fakeBunHelper = join(fakeBin, "fake-bun.ts");
      writeFileSync(
        fakeBunHelper,
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          "",
          "const args = process.argv.slice(2);",
          'if (args[0] === "install") {',
          "  const managed = process.env.KEELSON_TEST_BUNDLE_DIR;",
          "  if (!managed) process.exit(41);",
          "  mkdirSync(managed, { recursive: true });",
          '  writeFileSync(join(managed, "fix-issue.yaml"), process.env.KEELSON_TEST_NEXT_FIX ?? "");',
          '  writeFileSync(join(managed, "customize.yaml"), process.env.KEELSON_TEST_NEXT_CUSTOM ?? "");',
          "  process.exit(0);",
          "}",
          "",
          "const realBun = process.env.KEELSON_REAL_BUN;",
          "if (!realBun) process.exit(42);",
          "const proc = Bun.spawn([realBun, ...args], {",
          '  stdin: "inherit",',
          '  stdout: "inherit",',
          '  stderr: "inherit",',
          "});",
          "process.exit(await proc.exited);",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(fakeBin, "bun"),
        '#!/usr/bin/env sh\nexec "$KEELSON_REAL_BUN" "$KEELSON_FAKE_BUN_HELPER" "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(fakeBin, "bun.cmd"),
        '@echo off\r\n"%KEELSON_REAL_BUN%" "%KEELSON_FAKE_BUN_HELPER%" %*\r\n',
      );

      const { stdout, exitCode } = await runCli(["--json", "update"], {
        ...env(home),
        KEELSON_REAL_BUN: process.execPath,
        KEELSON_FAKE_BUN_HELPER: fakeBunHelper,
        KEELSON_TEST_BUNDLE_DIR: bundleDir,
        KEELSON_TEST_NEXT_FIX: "new shared workflow\n",
        KEELSON_TEST_NEXT_CUSTOM: "new customizable workflow\n",
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expect(exitCode).toBe(0);
      const out = JSON.parse(stdout.trim());
      expect(out.ok).toBe(true);
      expect(out.data.updated).toBe(true);
      expect(out.data.refreshedWorkflows).toEqual(["fix-issue.yaml"]);
      expect(out.data.workflowConflicts).toEqual(["customize.yaml"]);
      expect(readFileSync(join(overlayDir, "fix-issue.yaml"), "utf8")).toBe(
        "new shared workflow\n",
      );
      expect(readFileSync(join(overlayDir, "customize.yaml"), "utf8")).toBe("my customization\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function failingBunHarness(root: string, stderrText: string): Record<string, string> {
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const helper = join(fakeBin, "fail-bun.ts");
    writeFileSync(
      helper,
      [
        "const args = process.argv.slice(2);",
        'if (args[0] === "install") {',
        '  process.stderr.write(process.env.KEELSON_TEST_INSTALL_STDERR ?? "");',
        "  process.exit(1);",
        "}",
        "const realBun = process.env.KEELSON_REAL_BUN;",
        "if (!realBun) process.exit(42);",
        "const proc = Bun.spawn([realBun, ...args], {",
        '  stdin: "inherit",',
        '  stdout: "inherit",',
        '  stderr: "inherit",',
        "});",
        "process.exit(await proc.exited);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fakeBin, "bun"),
      '#!/usr/bin/env sh\nexec "$KEELSON_REAL_BUN" "$KEELSON_FAKE_BUN_HELPER" "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "bun.cmd"),
      '@echo off\r\n"%KEELSON_REAL_BUN%" "%KEELSON_FAKE_BUN_HELPER%" %*\r\n',
    );
    return {
      KEELSON_REAL_BUN: process.execPath,
      KEELSON_FAKE_BUN_HELPER: helper,
      KEELSON_TEST_INSTALL_STDERR: stderrText,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    };
  }

  test("quarantined-version install failure exits REGISTRY_STALE naming the sanitized registry", async () => {
    latestTag = "v999.0.2";
    const root = mkdtempSync(join(tmpdir(), "keelson-update-stale-"));
    const home = join(root, "home");
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "package.json"),
        `${JSON.stringify({
          name: "keelson-home",
          private: true,
          dependencies: {
            "@keelson/cli":
              "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
          },
        })}\n`,
      );
      writeFileSync(join(home, ".npmrc"), "registry=https://user:hunter2@feed.example.com/npm/\n");
      const { stdout, exitCode } = await runCli(["--json", "update"], {
        ...env(home),
        ...failingBunHarness(
          root,
          'error: No version matching "9.9.9" found for specifier "left-pad" (but package exists)\nerror: left-pad@9.9.9 failed to resolve\n',
        ),
      });
      expect(exitCode).toBe(1);
      const out = JSON.parse(stdout.trim());
      expect(out.ok).toBe(false);
      expect(out.code).toBe("REGISTRY_STALE");
      expect(out.error).toContain("left-pad@9.9.9");
      expect(out.error).toContain("https://feed.example.com/npm/");
      expect(out.error).not.toContain("hunter2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unrelated install failure stays INSTALL_FAILED", async () => {
    latestTag = "v999.0.3";
    const root = mkdtempSync(join(tmpdir(), "keelson-update-instfail-"));
    const home = join(root, "home");
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "package.json"),
        `${JSON.stringify({
          name: "keelson-home",
          private: true,
          dependencies: {
            "@keelson/cli":
              "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
          },
        })}\n`,
      );
      const { stdout, exitCode } = await runCli(["--json", "update"], {
        ...env(home),
        ...failingBunHarness(root, "error: tarball download failed\n"),
      });
      expect(exitCode).toBe(1);
      const out = JSON.parse(stdout.trim());
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INSTALL_FAILED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("already on the latest release exits 0, updated:false", async () => {
    latestTag = `v${CURRENT}`;
    const home = installedHome();
    const { stdout, exitCode } = await runCli(["--json", "update"], env(home));
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.data.upToDate).toBe(true);
    expect(out.data.updated).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

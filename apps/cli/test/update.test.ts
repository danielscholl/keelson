// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPkg from "../package.json" with { type: "json" };
import {
  applyManifestVersion,
  githubSourcedRibs,
  parseTagVersion,
  releaseAssetUrls,
  selectReleaseNotes,
} from "../src/commands/update.ts";

describe("update pure helpers", () => {
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

  test("githubSourcedRibs selects only git-sourced rib deps", () => {
    const manifest = {
      dependencies: {
        "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
        "@keelson/rib-osdu": "github:danielscholl/keelson-rib-osdu",
        "@keelson/rib-chamber": "git+https://example.com/chamber.git",
        "@keelson/rib-local": "/tmp/some/path.tgz",
      },
    };
    expect(githubSourcedRibs(manifest)).toEqual(["@keelson/rib-chamber", "@keelson/rib-osdu"]);
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
    env: { ...process.env, ...env },
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

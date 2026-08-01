// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRibPins, isProblem, planRibUpdates, type RibPlanEntry } from "../src/rib-plan.ts";
import type { ResolveTags, TagResolution } from "../src/rib-version.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// A home carrying installed rib versions, so the plan can tell "already at that
// version, just unpinned" from a real move.
function makeHome(installed: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "keelson-ribplan-"));
  homes.push(home);
  for (const [pkg, version] of Object.entries(installed)) {
    const dir = join(home, "node_modules", pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  }
  return home;
}

function manifest(deps: Record<string, string>): string {
  return JSON.stringify({ name: "keelson-home", private: true, dependencies: deps }, null, 2);
}

function resolver(byUrl: Record<string, TagResolution>): ResolveTags {
  return async (url) => byUrl[url] ?? { kind: "resolved", tags: [] };
}

const CHAMBER = "https://github.com/acme/keelson-rib-chamber";

function byId(entries: RibPlanEntry[]): Map<string, RibPlanEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

describe("planRibUpdates", () => {
  test("moves a floating rib to the newest release", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.47.3" }),
      manifestText: manifest({ "@keelson/rib-chamber": CHAMBER }),
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.47.3", "v0.49.0"] } }),
    });
    expect(entries[0]).toMatchObject({
      id: "chamber",
      status: "updated",
      installed: "0.47.3",
      target: { tag: "v0.49.0", version: "0.49.0" },
    });
  });

  // The version does not change, but the manifest gains the explicit pin that
  // stops any later `bun update` from moving the rib off it.
  test("pins a floating rib that is already at the newest release", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.49.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": CHAMBER }),
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.49.0"] } }),
    });
    expect(entries[0]?.status).toBe("pinned");
  });

  test("leaves an already-pinned newest rib alone", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.49.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": `${CHAMBER}#v0.49.0` }),
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.49.0"] } }),
    });
    expect(entries[0]?.status).toBe("current");
  });

  test("respects a branch pin as an operator opt-out", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.48.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": `${CHAMBER}#main` }),
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.49.0"] } }),
    });
    expect(entries[0]?.status).toBe("tracking");
  });

  // Opting into a prerelease and then running a plain update selects the newest
  // stable tag, which is older. Presenting that as an update would silently
  // roll the rib back.
  test("an implicit update never moves a rib backwards", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.50.0-rc.1" }),
      manifestText: manifest({ "@keelson/rib-chamber": `${CHAMBER}#v0.50.0-rc.1` }),
      allowPrerelease: false,
      resolveTags: resolver({
        [CHAMBER]: { kind: "resolved", tags: ["v0.49.0", "v0.50.0-rc.1"] },
      }),
    });
    expect(entries[0]?.status).toBe("current");
  });

  test("--to still reaches an older release, since that is the rollback surface", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.49.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": `${CHAMBER}#v0.49.0` }),
      to: "0.47.3",
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.47.3", "v0.49.0"] } }),
    });
    expect(entries[0]).toMatchObject({ status: "updated", target: { version: "0.47.3" } });
  });

  test("--to overrides a branch pin and reaches an older release", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.49.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": `${CHAMBER}#main` }),
      to: "0.47.3",
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.47.3", "v0.49.0"] } }),
    });
    expect(entries[0]).toMatchObject({ status: "updated", target: { version: "0.47.3" } });
  });

  test("reports a --to version the repo does not carry instead of moving anywhere", async () => {
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.49.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": CHAMBER }),
      to: "9.9.9",
      allowPrerelease: false,
      resolveTags: resolver({ [CHAMBER]: { kind: "resolved", tags: ["v0.49.0"] } }),
    });
    expect(entries[0]?.status).toBe("not-found");
    expect(entries[0]?.target).toBeNull();
    expect(isProblem(entries[0] as RibPlanEntry)).toBe(true);
  });

  // The distinction this whole resolver is built around: a repo we could not
  // read is not a repo with nothing new.
  test("separates an unreachable repo from one with no releases", async () => {
    const other = "https://github.com/acme/keelson-rib-other";
    const entries = await planRibUpdates({
      home: makeHome(),
      manifestText: manifest({
        "@keelson/rib-chamber": CHAMBER,
        "@keelson/rib-other": other,
      }),
      allowPrerelease: false,
      resolveTags: resolver({
        [CHAMBER]: { kind: "unreachable", reason: "Repository not found." },
        [other]: { kind: "resolved", tags: ["nightly"] },
      }),
    });
    const plans = byId(entries);
    expect(plans.get("chamber")).toMatchObject({
      status: "unreachable",
      reason: "Repository not found.",
    });
    expect(plans.get("other")?.status).toBe("no-releases");

    // Unreachable fails the run; a rib that has simply never cut a release must
    // not, or every update against it would fail forever.
    expect(isProblem(plans.get("chamber") as RibPlanEntry)).toBe(true);
    expect(isProblem(plans.get("other") as RibPlanEntry)).toBe(false);
  });

  test("marks non-git sources unpinnable rather than guessing at releases", async () => {
    const entries = await planRibUpdates({
      home: makeHome(),
      manifestText: manifest({
        "@keelson/rib-local": "/tmp/keelson-rib-local",
        "@keelson/rib-npm": "@keelson/rib-npm",
      }),
      allowPrerelease: false,
      resolveTags: resolver({}),
    });
    expect(entries.map((e) => e.status)).toEqual(["unpinnable", "unpinnable"]);
  });

  test("skips prereleases unless --pre is passed", async () => {
    const tags = { [CHAMBER]: { kind: "resolved" as const, tags: ["v0.49.0", "v0.50.0-rc.1"] } };
    const base = {
      home: makeHome({ "@keelson/rib-chamber": "0.48.0" }),
      manifestText: manifest({ "@keelson/rib-chamber": CHAMBER }),
      resolveTags: resolver(tags),
    };
    expect((await planRibUpdates({ ...base, allowPrerelease: false }))[0]?.target?.version).toBe(
      "0.49.0",
    );
    expect((await planRibUpdates({ ...base, allowPrerelease: true }))[0]?.target?.version).toBe(
      "0.50.0-rc.1",
    );
  });

  test("`only` narrows the plan to the named ribs", async () => {
    const other = "https://github.com/acme/keelson-rib-other";
    const entries = await planRibUpdates({
      home: makeHome(),
      manifestText: manifest({ "@keelson/rib-chamber": CHAMBER, "@keelson/rib-other": other }),
      only: ["chamber"],
      allowPrerelease: false,
      resolveTags: resolver({
        [CHAMBER]: { kind: "resolved", tags: ["v0.49.0"] },
        [other]: { kind: "resolved", tags: ["v1.0.0"] },
      }),
    });
    expect(entries.map((e) => e.id)).toEqual(["chamber"]);
  });

  test("ignores the harness's own release-asset pins", async () => {
    const entries = await planRibUpdates({
      home: makeHome(),
      manifestText: manifest({
        "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
        "@keelson/shared":
          "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-shared.tgz",
      }),
      allowPrerelease: false,
      resolveTags: resolver({}),
    });
    expect(entries).toEqual([]);
  });
});

describe("applyRibPins", () => {
  test("rewrites only the ribs that move, in the operator's own source form", async () => {
    const text = manifest({
      "@keelson/cli": "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
      "@keelson/rib-chamber": "github:acme/keelson-rib-chamber",
      "@keelson/rib-pinned": "https://github.com/acme/keelson-rib-pinned#v2.0.0",
    });
    const entries = await planRibUpdates({
      home: makeHome({ "@keelson/rib-chamber": "0.48.0", "@keelson/rib-pinned": "2.0.0" }),
      manifestText: text,
      allowPrerelease: false,
      resolveTags: resolver({
        "https://github.com/acme/keelson-rib-chamber": { kind: "resolved", tags: ["v0.49.0"] },
        "https://github.com/acme/keelson-rib-pinned": { kind: "resolved", tags: ["v2.0.0"] },
      }),
    });
    const deps = JSON.parse(applyRibPins(text, entries)).dependencies;
    expect(deps["@keelson/rib-chamber"]).toBe("github:acme/keelson-rib-chamber#v0.49.0");
    expect(deps["@keelson/rib-pinned"]).toBe("https://github.com/acme/keelson-rib-pinned#v2.0.0");
    expect(deps["@keelson/cli"]).toBe(
      "https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz",
    );
  });

  test("replaces an existing pin rather than appending a second fragment", () => {
    const text = manifest({ "@keelson/rib-x": "github:acme/keelson-rib-x#v1.0.0" });
    const entry: RibPlanEntry = {
      id: "x",
      pkg: "@keelson/rib-x",
      source: "github:acme/keelson-rib-x#v1.0.0",
      installed: "1.0.0",
      target: { tag: "v1.1.0", version: "1.1.0" },
      status: "updated",
    };
    expect(JSON.parse(applyRibPins(text, [entry])).dependencies["@keelson/rib-x"]).toBe(
      "github:acme/keelson-rib-x#v1.1.0",
    );
  });

  test("is a no-op when nothing moves", () => {
    const text = manifest({ "@keelson/rib-x": "github:acme/keelson-rib-x" });
    expect(JSON.parse(applyRibPins(text, [])).dependencies["@keelson/rib-x"]).toBe(
      "github:acme/keelson-rib-x",
    );
  });
});

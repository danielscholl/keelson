// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHarnessCompat,
  findRelease,
  installedHarnessVersion,
  installedRibVersion,
  isReleaseTag,
  isValidRange,
  newestRelease,
  parseLsRemote,
  parseRibSource,
  pinnedSpec,
  releaseTags,
  ribHarnessRange,
} from "../src/rib-version.ts";

describe("parseRibSource", () => {
  test("reads owner/repo out of every source form bun accepts", () => {
    const forms = [
      "https://github.com/danielscholl/keelson-rib-chamber",
      "https://github.com/danielscholl/keelson-rib-chamber.git",
      "https://github.com/danielscholl/keelson-rib-chamber/",
      "github:danielscholl/keelson-rib-chamber",
      "git@github.com:danielscholl/keelson-rib-chamber.git",
      "git+https://github.com/danielscholl/keelson-rib-chamber.git",
      "git+ssh://git@github.com/danielscholl/keelson-rib-chamber.git",
      "danielscholl/keelson-rib-chamber",
    ];
    for (const form of forms) {
      expect(parseRibSource(form)?.url).toBe("https://github.com/danielscholl/keelson-rib-chamber");
    }
  });

  test("keeps the operator's source form as the base so a pin only adds a fragment", () => {
    expect(pinnedSpec(parseRibSource("github:acme/keelson-rib-x") as never, "v1.2.3")).toBe(
      "github:acme/keelson-rib-x#v1.2.3",
    );
    expect(
      pinnedSpec(parseRibSource("https://github.com/acme/keelson-rib-x") as never, "v1.2.3"),
    ).toBe("https://github.com/acme/keelson-rib-x#v1.2.3");
  });

  test("splits an existing ref without folding it into the base", () => {
    const parsed = parseRibSource("github:acme/keelson-rib-x#v0.4.0");
    expect(parsed?.base).toBe("github:acme/keelson-rib-x");
    expect(parsed?.ref).toBe("v0.4.0");
    expect(pinnedSpec(parsed as never, "v0.5.0")).toBe("github:acme/keelson-rib-x#v0.5.0");
  });

  test("is host-agnostic, so a rib hosted anywhere but GitHub still resolves", () => {
    expect(parseRibSource("https://gitlab.com/acme/keelson-rib-x")?.url).toBe(
      "https://gitlab.com/acme/keelson-rib-x",
    );
    expect(parseRibSource("git@gitlab.example.com:acme/keelson-rib-x.git")?.url).toBe(
      "https://gitlab.example.com/acme/keelson-rib-x",
    );
  });

  test("rejects sources that releases do not apply to", () => {
    expect(parseRibSource("@keelson/rib-x")).toBeNull();
    expect(parseRibSource("/tmp/some/path")).toBeNull();
    expect(parseRibSource("./local-rib")).toBeNull();
  });

  // These parse as scp-style `host:path` whose path happens to have two
  // segments, so a naive reading turns a local tarball into a git remote.
  test("rejects bun's own protocol specs, not just paths", () => {
    expect(parseRibSource("file:/tmp/rib.tgz")).toBeNull();
    expect(parseRibSource("link:../keelson-rib-x")).toBeNull();
    expect(parseRibSource("npm:some/pkg")).toBeNull();
  });

  // The harness pins itself to release-asset URLs on the same host as its ribs;
  // reading one as a git remote would make `rib update` try to advance keelson.
  test("rejects a release-tarball URL, which is not a repo", () => {
    expect(
      parseRibSource("https://github.com/acme/keelson/releases/download/v0.1.0/keelson-cli.tgz"),
    ).toBeNull();
  });
});

describe("release tag selection", () => {
  const tags = ["v0.9.0", "v0.10.0", "v0.10.1", "v1.0.0-rc.1", "main-snapshot", "v1.2", "nightly"];

  test("ignores tags that are not unambiguous semver releases", () => {
    expect(releaseTags(tags, false).map((r) => r.tag)).toEqual(["v0.9.0", "v0.10.0", "v0.10.1"]);
  });

  test("orders by semver, not lexically", () => {
    expect(newestRelease(tags, false)?.version).toBe("0.10.1");
  });

  test("skips prereleases unless asked", () => {
    expect(newestRelease(tags, false)?.version).toBe("0.10.1");
    expect(newestRelease(tags, true)?.version).toBe("1.0.0-rc.1");
  });

  test("returns null when a repo carries no release tags at all", () => {
    expect(newestRelease(["main-snapshot", "nightly"], false)).toBeNull();
  });

  test("findRelease accepts either form the operator sees, and reaches prereleases", () => {
    expect(findRelease(tags, "0.10.0")?.tag).toBe("v0.10.0");
    expect(findRelease(tags, "v0.10.0")?.tag).toBe("v0.10.0");
    expect(findRelease(tags, "1.0.0-rc.1")?.tag).toBe("v1.0.0-rc.1");
    expect(findRelease(tags, "9.9.9")).toBeNull();
  });

  test("isReleaseTag separates a release pin from a branch or commit pin", () => {
    expect(isReleaseTag("v0.10.1")).toBe(true);
    expect(isReleaseTag("0.10.1")).toBe(true);
    expect(isReleaseTag("main")).toBe(false);
    expect(isReleaseTag("4555f6c")).toBe(false);
  });
});

describe("parseLsRemote", () => {
  test("takes tag names off the ref column", () => {
    const stdout = [
      "5bc3bcae2e31e1047295c7978e5b47cf9d51aab1\trefs/tags/v0.7.0",
      "bda6c178bc6752b89c430012c677e0f98949442b\trefs/tags/v0.8.0",
      "",
    ].join("\n");
    expect(parseLsRemote(stdout)).toEqual(["v0.7.0", "v0.8.0"]);
  });

  test("is empty for a repo with no tags, which is not the same as unreachable", () => {
    expect(parseLsRemote("")).toEqual([]);
  });
});

function homeWith(packages: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "keelson-ribver-"));
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(home, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }
  return home;
}

describe("installed manifest reads", () => {
  test("reports a rib's version, its declared harness range, and the harness itself", () => {
    const home = homeWith({
      "@keelson/rib-chamber": {
        version: "0.49.0",
        peerDependencies: { "@keelson/shared": ">=0.77.0" },
      },
      "@keelson/shared": { version: "0.93.0" },
    });
    try {
      expect(installedRibVersion(home, "@keelson/rib-chamber")).toBe("0.49.0");
      expect(ribHarnessRange(home, "@keelson/rib-chamber")).toBe(">=0.77.0");
      expect(installedHarnessVersion(home)).toBe("0.93.0");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns null rather than throwing for a package that is not installed", () => {
    const home = homeWith({});
    try {
      expect(installedRibVersion(home, "@keelson/rib-missing")).toBeNull();
      expect(installedHarnessVersion(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("isValidRange", () => {
  test("accepts the comparator forms a peer range actually uses", () => {
    for (const range of [
      ">=0.77.0",
      "^1.2.3",
      "~1.2",
      "1.x",
      "*",
      ">=1.0.0 <2.0.0",
      "1.0.0 - 2.0.0",
      "^1.0.0 || ^2.0.0",
    ]) {
      expect(isValidRange(range)).toBe(true);
    }
  });

  // Bun.semver.satisfies returns true for every version against each of these,
  // so without the check a malformed range is indistinguishable from `*`.
  test("rejects the malformed ranges Bun.semver silently treats as match-anything", () => {
    for (const range of ["not-a-range", "garbage", "!!!", "", "   ", ">= x"]) {
      expect(isValidRange(range)).toBe(false);
      expect(Bun.semver.satisfies("0.0.1", range)).toBe(true);
    }
  });
});

describe("checkHarnessCompat", () => {
  test("passes a rib whose declared range admits the installed harness", () => {
    const home = homeWith({
      "@keelson/rib-x": { version: "1.0.0", peerDependencies: { "@keelson/shared": ">=0.77.0" } },
      "@keelson/shared": { version: "0.93.0" },
    });
    try {
      expect(checkHarnessCompat(home, "@keelson/rib-x")?.compatible).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flags a rib that needs a harness newer than this home has", () => {
    const home = homeWith({
      "@keelson/rib-x": { version: "2.0.0", peerDependencies: { "@keelson/shared": ">=1.0.0" } },
      "@keelson/shared": { version: "0.93.0" },
    });
    try {
      expect(checkHarnessCompat(home, "@keelson/rib-x")).toEqual({
        compatible: false,
        range: ">=1.0.0",
        harness: "0.93.0",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Undecidable must not read as compatible: a missing range or an unparseable
  // one would otherwise put a passing verdict behind a check that never ran.
  test("returns null when there is nothing to decide against", () => {
    const noRange = homeWith({
      "@keelson/rib-x": { version: "1.0.0" },
      "@keelson/shared": { version: "0.93.0" },
    });
    const noHarness = homeWith({
      "@keelson/rib-x": { version: "1.0.0", peerDependencies: { "@keelson/shared": ">=0.1.0" } },
    });
    const badRange = homeWith({
      "@keelson/rib-x": {
        version: "1.0.0",
        peerDependencies: { "@keelson/shared": "not-a-range" },
      },
      "@keelson/shared": { version: "0.93.0" },
    });
    try {
      expect(checkHarnessCompat(noRange, "@keelson/rib-x")).toBeNull();
      expect(checkHarnessCompat(noHarness, "@keelson/rib-x")).toBeNull();
      expect(checkHarnessCompat(badRange, "@keelson/rib-x")).toBeNull();
    } finally {
      for (const home of [noRange, noHarness, badRange]) {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keelsonPaths, resolveKeelsonHome, resolveRibsRoot, ribDataDir } from "../src/paths.ts";

const ENV_KEYS = ["KEELSON_HOME", "KEELSON_DB", "KEELSON_WORKFLOWS_DIR"] as const;

describe("resolveKeelsonHome", () => {
  let saved: Record<string, string | undefined>;
  let tmp: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "keelson-paths-"));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("honors KEELSON_HOME above everything else", () => {
    process.env.KEELSON_HOME = join(tmp, "explicit");
    expect(resolveKeelsonHome(tmp)).toBe(join(tmp, "explicit"));
  });

  it("walks up to an existing .keelson/ (the monorepo dev layout)", () => {
    const repo = join(tmp, "repo");
    const nested = join(repo, "apps", "server", "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".keelson"), { recursive: true });
    expect(resolveKeelsonHome(nested)).toBe(join(repo, ".keelson"));
  });

  it("falls back to ~/.keelson when no project .keelson/ exists", () => {
    // An isolated cwd with no .keelson/ ancestor resolves to the user home.
    const isolated = join(tmp, "no-project");
    mkdirSync(isolated, { recursive: true });
    expect(resolveKeelsonHome(isolated)).toBe(join(homedir(), ".keelson"));
  });
});

describe("keelsonPaths", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("derives db + workflows under the home by default", () => {
    const home = "/srv/keelson-home";
    const p = keelsonPaths(home);
    expect(p.home).toBe(home);
    expect(p.dbPath).toBe(join(home, "keelson.db"));
    expect(p.workflowsDir).toBe(join(home, "workflows"));
  });

  it("honors KEELSON_DB and KEELSON_WORKFLOWS_DIR overrides", () => {
    process.env.KEELSON_DB = "/data/custom.db";
    process.env.KEELSON_WORKFLOWS_DIR = "/data/flows";
    const p = keelsonPaths("/srv/keelson-home");
    expect(p.dbPath).toBe("/data/custom.db");
    expect(p.workflowsDir).toBe("/data/flows");
  });
});

describe("resolveRibsRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "keelson-ribs-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the home's node_modules/@keelson when it exists", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, "node_modules", "@keelson"), { recursive: true });
    expect(resolveRibsRoot(home)).toBe(join(home, "node_modules", "@keelson"));
  });

  it("falls back to the parent's node_modules/@keelson when the home has none", () => {
    const home = join(tmp, "empty-home");
    mkdirSync(home, { recursive: true });
    expect(resolveRibsRoot(home)).toBe(join(tmp, "node_modules", "@keelson"));
  });
});

describe("ribDataDir", () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.KEELSON_HOME;
    delete process.env.KEELSON_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.KEELSON_HOME;
    else process.env.KEELSON_HOME = savedHome;
  });

  it("names a rib's data dir `rib-<id>` under the given home", () => {
    expect(ribDataDir("chamber", "/srv/keelson-home")).toBe(
      join("/srv/keelson-home", "rib-chamber"),
    );
  });

  it("defaults the home to resolveKeelsonHome (KEELSON_HOME honored)", () => {
    // resolve() so the expected home is drive-qualified on Windows, matching
    // resolveKeelsonHome()'s own resolve() of KEELSON_HOME.
    const home = resolve(join("/explicit", "home"));
    process.env.KEELSON_HOME = home;
    expect(ribDataDir("chamber")).toBe(join(home, "rib-chamber"));
  });
});

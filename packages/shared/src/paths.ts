// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOME_DIR_NAME = ".keelson";

// The managed keelson home: the directory holding keelson.db, workflows/, and
// (when installed) the node_modules/@keelson rib tree. Precedence:
//   KEELSON_HOME env → an existing .keelson/ found walking up from cwd → the
//   per-user default (see defaultUserHome)
// The walk-up branch preserves the monorepo dev layout (home === <repo>/.keelson)
// and lets keelson data live beside an embedding project's source.
export function resolveKeelsonHome(cwd: string = process.cwd()): string {
  const fromEnv = process.env.KEELSON_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  const local = findProjectHome(cwd);
  if (local) return local;
  return defaultUserHome();
}

export interface DefaultUserHomeDeps {
  platform?: NodeJS.Platform;
  localAppData?: string | undefined;
  userHome?: string;
  exists?: (path: string) => boolean;
}

// Windows keeps the install tree out of the roaming profile: %USERPROFILE%
// roams in AD environments, and this directory holds node_modules, a live
// SQLite database, and a pid file — none of which may follow a user between
// machines. A pre-existing %USERPROFILE%\.keelson still wins so an upgrade
// never strands an existing install's data.
export function defaultUserHome(deps: DefaultUserHomeDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const userHome = deps.userHome ?? homedir();
  const legacy = join(userHome, HOME_DIR_NAME);
  if (platform !== "win32") return legacy;
  const exists = deps.exists ?? existsSync;
  if (exists(legacy)) return legacy;
  // Key presence, not `!== undefined`: a caller passing `localAppData: undefined`
  // means "there is none", which must not fall through to the ambient env.
  const localAppData = (
    "localAppData" in deps ? deps.localAppData : process.env.LOCALAPPDATA
  )?.trim();
  return localAppData ? join(localAppData, "keelson") : legacy;
}

function findProjectHome(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, HOME_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Workflows a registered project contributes to the catalog. Scope layering
// (project shadows global) keys off ProjectsStore root paths — not the cwd
// walk-up above, which substitutes the whole home rather than adding a layer.
export function projectWorkflowsDir(rootPath: string): string {
  return join(rootPath, HOME_DIR_NAME, "workflows");
}

export interface KeelsonPaths {
  readonly home: string;
  readonly dbPath: string;
  readonly workflowsDir: string;
  readonly ribsRoot: string;
  readonly artifactsDir: string;
}

export function keelsonPaths(home: string = resolveKeelsonHome()): KeelsonPaths {
  return {
    home,
    dbPath: process.env.KEELSON_DB?.trim() || join(home, "keelson.db"),
    workflowsDir: process.env.KEELSON_WORKFLOWS_DIR?.trim() || join(home, "workflows"),
    ribsRoot: resolveRibsRoot(home),
    artifactsDir: join(home, "artifacts"),
  };
}

// Where discovered ribs live. Installed: <home>/node_modules/@keelson (created
// by the home's `bun install`, so this branch always wins once the CLI/shared
// are installed). Dev: the home is <repo>/.keelson with no node_modules of its
// own, so fall back to the parent (the repo root) where the workspace symlinks
// and any dev-linked ribs live. Deterministic — not cwd-dependent.
export function resolveRibsRoot(home: string = resolveKeelsonHome()): string {
  const homeRibs = join(home, "node_modules", "@keelson");
  if (existsSync(homeRibs)) return homeRibs;
  return join(dirname(home), "node_modules", "@keelson");
}

// A rib's private data tree under the keelson home (the same root as keelson.db),
// named `rib-<id>` to mirror the `@keelson/rib-<id>` package — the prefix keeps it
// clear of the home's own entries (workflows/, commands/, keelson.db). Backs
// RibContext.getDataDir. Path only; the caller creates the directory when it writes.
export function ribDataDir(ribId: string, home: string = resolveKeelsonHome()): string {
  return join(home, `rib-${ribId}`);
}

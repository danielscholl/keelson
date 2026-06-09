// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOME_DIR_NAME = ".keelson";

// The managed keelson home: the directory holding keelson.db, workflows/, and
// (when installed) the node_modules/@keelson rib tree. Precedence:
//   KEELSON_HOME env → an existing .keelson/ found walking up from cwd → ~/.keelson
// The walk-up branch preserves the monorepo dev layout (home === <repo>/.keelson)
// and lets keelson data live beside an embedding project's source.
export function resolveKeelsonHome(cwd: string = process.cwd()): string {
  const fromEnv = process.env.KEELSON_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  const local = findProjectHome(cwd);
  if (local) return local;
  return join(homedir(), HOME_DIR_NAME);
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

export interface KeelsonPaths {
  readonly home: string;
  readonly dbPath: string;
  readonly workflowsDir: string;
  readonly ribsRoot: string;
}

export function keelsonPaths(home: string = resolveKeelsonHome()): KeelsonPaths {
  return {
    home,
    dbPath: process.env.KEELSON_DB?.trim() || join(home, "keelson.db"),
    workflowsDir: process.env.KEELSON_WORKFLOWS_DIR?.trim() || join(home, "workflows"),
    ribsRoot: resolveRibsRoot(home),
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

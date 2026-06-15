// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { keelsonPaths, resolveKeelsonHome } from "@keelson/shared/paths";
import { bundledWorkflowsDir, type DiscoveryRoot } from "@keelson/workflows";

export { resolveKeelsonHome };

// Default workflow discovery root — `workflows/` under the keelson home. The
// server resolves the identical path (apps/server/src/index.ts).
export function defaultWorkflowsDir(): string {
  return keelsonPaths().workflowsDir;
}

// Ordered workflow discovery roots for the in-process surfaces (list / run /
// validate): the bundled "code artifacts", the user-global home, and the
// project-local home, in precedence order — later overrides earlier, matching
// `discoverWorkflows`. Deduped so the common case where the resolved home IS
// ~/.keelson collapses to one entry; a missing dir is skipped downstream.
export function workflowDiscoveryRoots(): DiscoveryRoot[] {
  const roots: DiscoveryRoot[] = [];
  const seen = new Set<string>();
  const add = (dir: string, source: DiscoveryRoot["source"]): void => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ dir: resolved, source });
  };
  // Lowest precedence: the shipped starters in the package's assets dir, so
  // they surface in a dev checkout (and a populated home) without a re-seed.
  add(bundledWorkflowsDir(), "bundled");
  // The user-global home (~/.keelson, or $KEELSON_HOME) — independent of the
  // project walk-up, so personal workflows surface even inside a checkout.
  const userHome = process.env.KEELSON_HOME?.trim()
    ? resolve(process.env.KEELSON_HOME.trim())
    : join(homedir(), ".keelson");
  add(join(userHome, "workflows"), "global");
  // Highest precedence: the resolved project home (the .keelson found walking
  // up from cwd; honors KEELSON_WORKFLOWS_DIR). Equals userHome outside a
  // checkout — deduped above.
  add(defaultWorkflowsDir(), "project");
  return roots;
}

// Default SQLite path — `keelson.db` under the keelson home. Mirrors the
// server's resolution and honors the KEELSON_DB override.
export function defaultDbPath(): string {
  return keelsonPaths().dbPath;
}

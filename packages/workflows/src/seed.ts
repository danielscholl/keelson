// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Where the installed @keelson/cli tarball ships the starter workflows: a
// `workflows/` dir staged next to `dist/` by scripts/build-release.ts. In the
// release bundle import.meta resolves to <pkg>/dist, so `../workflows` lands
// on it; running from repo source the dir doesn't exist and seeding no-ops
// (the dev home is <repo>/.keelson, which already carries the YAMLs).
const BUNDLED_WORKFLOWS_DIR = join(import.meta.dir, "..", "workflows");

// The single definition of "a workflow file" — shared so discovery, the seed
// guard, and the release-staging filter (scripts/build-release.ts) cannot drift
// on what counts as a starter.
export function isWorkflowYaml(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

// First-run seeding of the starter workflows into the home's workflows dir.
// Seeds only when the target holds no YAML yet: a populated dir is user-owned,
// so deleted or edited starters are never resurrected by a later boot/update.
// Returns the seeded filenames (empty when seeding was skipped).
//
// Each file is copied to a per-process temp name, then renamed into place.
// Rename is atomic on the same filesystem, so a concurrent reader (discovery)
// never observes a half-written file, and a failed or interrupted copy leaves
// no `.yaml` behind — the "target holds YAML" guard above keeps a partial seed
// from locking out a later retry of the full set.
export function seedStarterWorkflows(
  targetDir: string,
  sourceDir: string = BUNDLED_WORKFLOWS_DIR,
): string[] {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (source === target || !existsSync(source)) return [];
  const starters = readdirSync(source).filter(isWorkflowYaml).sort();
  if (starters.length === 0) return [];
  if (existsSync(target) && readdirSync(target).some(isWorkflowYaml)) return [];
  mkdirSync(target, { recursive: true });

  // Stage every starter under a temp name (dot-prefixed, `.seedtmp` suffix so
  // it never matches isWorkflowYaml). The pid keeps two concurrent seeders off
  // each other's temp files; the final rename then overwrites atomically with
  // byte-identical content. If any copy throws, drop the temps and rethrow so
  // the target stays empty and the next run reseeds the whole set.
  const staged: Array<{ tmp: string; final: string }> = [];
  try {
    for (const name of starters) {
      const tmp = join(target, `.${name}.${process.pid}.seedtmp`);
      copyFileSync(join(source, name), tmp);
      staged.push({ tmp, final: join(target, name) });
    }
  } catch (err) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw err;
  }
  for (const { tmp, final } of staged) renameSync(tmp, final);
  return starters;
}

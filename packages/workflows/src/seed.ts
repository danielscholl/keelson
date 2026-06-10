// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Where the installed @keelson/cli tarball ships the starter workflows: a
// `workflows/` dir staged next to `dist/` by scripts/build-release.ts. In the
// release bundle import.meta resolves to <pkg>/dist, so `../workflows` lands
// on it; running from repo source the dir doesn't exist and seeding no-ops
// (the dev home is <repo>/.keelson, which already carries the YAMLs).
const BUNDLED_WORKFLOWS_DIR = join(import.meta.dir, "..", "workflows");

function isYaml(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

// First-run seeding of the starter workflows into the home's workflows dir.
// Seeds only when the target holds no YAML yet: a populated dir is user-owned,
// so deleted or edited starters are never resurrected by a later boot/update.
// Returns the seeded filenames (empty when seeding was skipped).
export function seedStarterWorkflows(
  targetDir: string,
  sourceDir: string = BUNDLED_WORKFLOWS_DIR,
): string[] {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (source === target || !existsSync(source)) return [];
  const starters = readdirSync(source).filter(isYaml).sort();
  if (starters.length === 0) return [];
  if (existsSync(target) && readdirSync(target).some(isYaml)) return [];
  mkdirSync(target, { recursive: true });
  for (const name of starters) {
    copyFileSync(join(source, name), join(target, name));
  }
  return starters;
}

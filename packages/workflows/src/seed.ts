// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { COMMAND_EXTENSION, SCRIPT_EXT_RUNTIME } from "./handlers/discovery.ts";

// Root the bundled starter assets live under, as sibling dirs `workflows/`,
// `commands/`, and `scripts/`. In repo source this resolves to
// `packages/workflows/assets`; in the release bundle import.meta resolves to
// <pkg>/dist, so `../assets` lands on <pkg>/assets where scripts/build-release.ts
// stages them. Present in both layouts, so seeding is live in dev too — it fills
// a fresh <repo>/.keelson home the same way it fills an installed one.
const BUNDLED_ROOT = join(import.meta.dir, "..", "assets");

// The single definition of "a workflow file" — shared so discovery and the seed
// guard cannot drift on what counts as a starter.
export function isWorkflowYaml(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}
// Command/script relevance comes straight from discovery's extension tables, so
// a starter discovery can resolve is one the seeder will copy, and vice versa.
function isCommandFile(name: string): boolean {
  return extname(name) === COMMAND_EXTENSION;
}
function isScriptFile(name: string): boolean {
  return extname(name) in SCRIPT_EXT_RUNTIME;
}

// Atomic, skip-if-populated copy of one flat asset dir. Seeds only when the
// target holds no matching file yet: a populated dir is user-owned, so deleted
// or edited starters are never resurrected by a later boot/update.
//
// Each file is copied to a per-process temp name, then renamed into place.
// Rename is atomic on the same filesystem, so a concurrent reader (discovery)
// never observes a half-written file, and a failed or interrupted copy leaves no
// matching file behind — the skip-if-populated guard then keeps a partial seed
// from locking out a later retry of the full set.
function seedDir(
  sourceDir: string,
  targetDir: string,
  isRelevant: (name: string) => boolean,
): string[] {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (source === target || !existsSync(source)) return [];
  const items = readdirSync(source).filter(isRelevant).sort();
  if (items.length === 0) return [];
  if (existsSync(target) && readdirSync(target).some(isRelevant)) return [];
  mkdirSync(target, { recursive: true });

  // Stage every file under a temp name (dot-prefixed, `.seedtmp` suffix so it
  // never matches a relevance predicate). The pid keeps two concurrent seeders
  // off each other's temp files; the final rename overwrites atomically with
  // byte-identical content. If any copy OR rename throws, drop the remaining
  // temps and rethrow — a rename can fail too (Windows when the dest is held
  // open, or the dir vanishing), so cleanup has to cover both phases.
  const staged: Array<{ tmp: string; final: string }> = [];
  try {
    for (const name of items) {
      const tmp = join(target, `.${name}.${process.pid}.seedtmp`);
      copyFileSync(join(source, name), tmp);
      staged.push({ tmp, final: join(target, name) });
    }
    for (const { tmp, final } of staged) renameSync(tmp, final);
  } catch (err) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw err;
  }
  return items;
}

export interface SeededAssets {
  workflows: string[];
  commands: string[];
  scripts: string[];
}

// First-run seeding of the bundled starter kit into the home: the starter
// workflows plus the command/script files they reference (e.g. smoke-test pulls
// in e2e-echo-command.md and echo-args.js). Each kind seeds independently and
// only when its target holds no matching file yet. workflowsDir is passed in so
// it honors KEELSON_WORKFLOWS_DIR; commands/scripts live directly under the home
// where discovery looks for them. Returns the seeded filenames per kind.
export function seedStarterAssets(
  home: string,
  workflowsDir: string = join(home, "workflows"),
  bundleRoot: string = BUNDLED_ROOT,
): SeededAssets {
  return {
    workflows: seedDir(join(bundleRoot, "workflows"), workflowsDir, isWorkflowYaml),
    commands: seedDir(join(bundleRoot, "commands"), join(home, "commands"), isCommandFile),
    scripts: seedDir(join(bundleRoot, "scripts"), join(home, "scripts"), isScriptFile),
  };
}

// Focused entry: seed only the starter workflows into a specific dir. Retained
// for callers and tests that target the workflows dir directly.
export function seedStarterWorkflows(
  targetDir: string,
  sourceDir: string = join(BUNDLED_ROOT, "workflows"),
): string[] {
  return seedDir(sourceDir, targetDir, isWorkflowYaml);
}

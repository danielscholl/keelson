// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_PROJECT_NAME } from "@keelson/shared";

import type { ProjectsStore } from "./projects-store.ts";

interface MigrateOptions {
  db: Database;
  projectsStore: ProjectsStore;
  workspaceRoot: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Move `src` to `dst`, falling back to copy+remove when rename can't cross a
// filesystem boundary (EXDEV). Returns false and leaves `src` in place when
// neither path works — one un-relocatable entry must not abort server boot.
function safeMove(src: string, dst: string): boolean {
  try {
    renameSync(src, dst);
    return true;
  } catch {
    try {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      return true;
    } catch (err) {
      console.warn(
        `[keelson] workspace migration: could not move ${src} → ${dst}: ${errMessage(err)}; left in place`,
      );
      return false;
    }
  }
}

// Remove a directory only when it is empty; otherwise leave it for the operator
// to inspect rather than silently deleting whatever survived a collision.
function removeIfEmpty(dir: string): void {
  if (!isDir(dir)) return;
  if (readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.warn(`[keelson] workspace migration: ${dir} not empty; left in place`);
  }
}

// A git worktree's administrative files store absolute paths in both directions
// (the repo's `.git/worktrees/<id>/gitdir` and the worktree's own `.git` file).
// A move leaves those stale, so repair them from the source repo.
function repairWorktree(repoRoot: string, worktreePath: string): void {
  try {
    const res = Bun.spawnSync({
      cmd: ["git", "-C", repoRoot, "worktree", "repair", worktreePath],
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    if (res.exitCode !== 0) {
      console.warn(
        `[keelson] workspace migration: git worktree repair failed for ${worktreePath}: ${res.stderr.toString().trim()}`,
      );
    }
  } catch (err) {
    console.warn(
      `[keelson] workspace migration: git worktree repair errored for ${worktreePath}: ${errMessage(err)}`,
    );
  }
}

// One-time flatten of the legacy `<workspace>/projects/` layout into the flat
// workspace root: `projects/<name>` → `<workspace>/<name>`, the placeholder
// `projects/_default` collapses into the workspace root itself (its contents
// move up), and workspace-scoped `projects/_worktrees/<proj>/<branch>`
// worktrees move to the repo-local `<project.rootPath>/.worktrees/<branch>`.
// Idempotent — gated on `projects/` existing, which the final cleanup removes
// once everything migrated cleanly, so a second boot no-ops. Anything that
// can't move without clobbering an existing path is left in place.
export function migrateLegacyProjectsLayout(opts: MigrateOptions): void {
  const { db, projectsStore, workspaceRoot } = opts;
  const legacyRoot = join(workspaceRoot, "projects");
  if (!isDir(legacyRoot)) return;

  const legacyDefault = join(legacyRoot, "_default");
  const legacyWorktrees = join(legacyRoot, "_worktrees");
  const updateRootPath = db.prepare("UPDATE keelson_projects SET root_path = ? WHERE id = ?");
  const updateRunPath = db.prepare(
    "UPDATE workflow_runs SET worktree_path = ? WHERE worktree_path = ?",
  );
  const updateLeasePath = db.prepare(
    "UPDATE workspace_leases SET worktree_path = ? WHERE worktree_path = ?",
  );
  const rewritePaths = (newPath: string, oldPath: string): void => {
    updateRunPath.run(newPath, oldPath);
    updateLeasePath.run(newPath, oldPath);
  };

  // A project dir move carries its repo-local `.worktrees/` along; the moved
  // worktrees' git metadata and the run/lease rows that reference them still
  // hold the pre-move absolute path. Repair all against the new project root.
  const repairMovedWorktrees = (oldRoot: string, newRoot: string): void => {
    const wtDir = join(newRoot, ".worktrees");
    if (!isDir(wtDir)) return;
    for (const leaf of readdirSync(wtDir)) {
      const newPath = join(wtDir, leaf);
      if (!isDir(newPath)) continue;
      repairWorktree(newRoot, newPath);
      rewritePaths(newPath, join(oldRoot, ".worktrees", leaf));
    }
  };

  for (const project of projectsStore.list()) {
    const old = project.rootPath;
    if (project.name === DEFAULT_PROJECT_NAME && old === legacyDefault) {
      // The default project's rootPath becomes the workspace root; move any
      // files it accumulated (a run's cwd was `_default`) up rather than
      // dropping them with the directory.
      let worktreesMoved = false;
      if (isDir(legacyDefault)) {
        for (const entry of readdirSync(legacyDefault)) {
          const src = join(legacyDefault, entry);
          const dst = join(workspaceRoot, entry);
          if (existsSync(dst)) {
            console.warn(
              `[keelson] workspace migration: ${dst} already exists; left ${src} in place`,
            );
            continue;
          }
          if (safeMove(src, dst) && entry === ".worktrees") worktreesMoved = true;
        }
      }
      updateRootPath.run(workspaceRoot, project.id);
      if (worktreesMoved) repairMovedWorktrees(legacyDefault, workspaceRoot);
      continue;
    }
    // Named project living directly under projects/<name>.
    if (dirname(old) === legacyRoot) {
      const dest = join(workspaceRoot, basename(old));
      if (existsSync(old) && existsSync(dest)) {
        console.warn(`[keelson] workspace migration: ${dest} already exists; left ${old} in place`);
        continue;
      }
      if (existsSync(old) && !safeMove(old, dest)) continue;
      updateRootPath.run(dest, project.id);
      // Repair any repo-local worktrees that rode along inside the moved dir.
      repairMovedWorktrees(old, dest);
    }
  }

  // Resolve each `_worktrees/<proj>/` bucket against the project's (now moved)
  // rootPath — a project registered from a path outside `projects/` keeps its
  // own rootPath, so its worktrees belong under that path, not `<workspace>/<proj>`.
  const rootPathByName = new Map(projectsStore.list().map((p) => [p.name, p.rootPath]));
  if (isDir(legacyWorktrees)) {
    for (const proj of readdirSync(legacyWorktrees)) {
      const projDir = join(legacyWorktrees, proj);
      if (!isDir(projDir)) continue;
      const repoRoot = rootPathByName.get(proj);
      if (repoRoot === undefined) {
        // No matching project (deleted, or a basename-derived bucket): we can't
        // know the repo, so leave the worktrees in place for `worktree prune`.
        console.warn(
          `[keelson] workspace migration: no project named '${proj}'; left ${projDir} in place`,
        );
        continue;
      }
      const destParent = join(repoRoot, ".worktrees");
      for (const leaf of readdirSync(projDir)) {
        const oldPath = join(projDir, leaf);
        const newPath = join(destParent, leaf);
        if (!isDir(oldPath)) continue;
        if (existsSync(newPath)) {
          console.warn(
            `[keelson] workspace migration: ${newPath} already exists; left ${oldPath} in place`,
          );
          continue;
        }
        mkdirSync(destParent, { recursive: true });
        if (!safeMove(oldPath, newPath)) continue;
        repairWorktree(repoRoot, newPath);
        rewritePaths(newPath, oldPath);
      }
      removeIfEmpty(projDir);
    }
  }

  removeIfEmpty(legacyDefault);
  removeIfEmpty(legacyWorktrees);
  removeIfEmpty(legacyRoot);
}

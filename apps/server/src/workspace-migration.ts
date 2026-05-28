// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

// One-time flatten of the legacy `<workspace>/projects/` layout into the flat
// workspace root: `projects/<name>` → `<workspace>/<name>`, the placeholder
// `projects/_default` collapses into the workspace root itself, and
// workspace-scoped `projects/_worktrees/<proj>/<branch>` worktrees move to the
// repo-local `<workspace>/<proj>/.worktrees/<branch>`. Idempotent — gated on
// `projects/` existing, which the final cleanup removes, so a second boot
// no-ops.
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

  for (const project of projectsStore.list()) {
    const old = project.rootPath;
    if (project.name === DEFAULT_PROJECT_NAME && old === legacyDefault) {
      updateRootPath.run(workspaceRoot, project.id);
      continue;
    }
    // Named project living directly under projects/<name>.
    if (dirname(old) === legacyRoot) {
      const dest = join(workspaceRoot, basename(old));
      if (existsSync(old) && !existsSync(dest)) {
        renameSync(old, dest);
      } else if (existsSync(old) && existsSync(dest)) {
        console.warn(`[keelson] workspace migration: ${dest} already exists; left ${old} in place`);
        continue;
      }
      updateRootPath.run(dest, project.id);
    }
  }

  // Workspace-scoped worktrees → repo-local under the (now moved) project dir.
  if (isDir(legacyWorktrees)) {
    for (const proj of readdirSync(legacyWorktrees)) {
      const projDir = join(legacyWorktrees, proj);
      if (!isDir(projDir)) continue;
      const destParent = join(workspaceRoot, proj, ".worktrees");
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
        renameSync(oldPath, newPath);
        updateRunPath.run(newPath, oldPath);
      }
    }
  }

  rmSync(legacyDefault, { recursive: true, force: true });
  rmSync(legacyWorktrees, { recursive: true, force: true });
  // Remove projects/ only when empty — anything left is unexpected and kept
  // for the operator to inspect rather than silently deleted.
  if (isDir(legacyRoot) && readdirSync(legacyRoot).length === 0) {
    rmSync(legacyRoot, { recursive: true, force: true });
  } else if (isDir(legacyRoot)) {
    console.warn(`[keelson] workspace migration: ${legacyRoot} not empty; left in place`);
  }
}

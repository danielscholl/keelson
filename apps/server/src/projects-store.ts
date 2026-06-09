// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import { isAbsolute, relative, sep } from "node:path";
import type { Project } from "@keelson/shared";

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface UpdateProjectPatch {
  name: string;
}

export interface ProjectsStore {
  list(): Project[];
  get(id: string): Project | undefined;
  getByName(name: string): Project | undefined;
  findByPathPrefix(absPath: string): Project | undefined;
  create(input: CreateProjectInput): Project;
  update(id: string, patch: UpdateProjectPatch): Project | undefined;
  delete(id: string): boolean;
}

export class DuplicateProjectNameError extends Error {
  constructor(public readonly name: string) {
    super(`project name '${name}' already exists`);
    this.name = "DuplicateProjectNameError";
  }
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
  };
}

interface SqliteWriteError {
  code?: string;
}

function isUniqueConstraintError(err: unknown): err is SqliteWriteError {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "SQLITE_CONSTRAINT_UNIQUE";
}

function trimSlash(p: string): string {
  if (p === "/") return p;
  return p.replace(/[/\\]+$/, "");
}

// True when `child` is `parent` itself or nested within it. Uses path.relative
// so it stays separator- and platform-correct (Windows `\` as well as POSIX `/`)
// rather than a raw `${parent}/` prefix test, which never matches a Windows path.
// A sibling whose name shares a prefix (`/a/bc` vs parent `/a/b`) is excluded —
// relative() yields a `..`-leading path there.
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function createProjectsStore(db: Database): ProjectsStore {
  const insertStmt = db.prepare(
    "INSERT INTO keelson_projects(id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
  );
  const listStmt = db.prepare(
    "SELECT id, name, root_path, created_at FROM keelson_projects ORDER BY name ASC",
  );
  const getStmt = db.prepare(
    "SELECT id, name, root_path, created_at FROM keelson_projects WHERE id = ?",
  );
  const getByNameStmt = db.prepare(
    "SELECT id, name, root_path, created_at FROM keelson_projects WHERE name = ?",
  );
  const deleteStmt = db.prepare("DELETE FROM keelson_projects WHERE id = ?");
  const updateNameStmt = db.prepare("UPDATE keelson_projects SET name = ? WHERE id = ?");

  return {
    list() {
      const rows = listStmt.all() as ProjectRow[];
      return rows.map(rowToProject);
    },
    get(id) {
      const row = getStmt.get(id) as ProjectRow | null;
      return row ? rowToProject(row) : undefined;
    },
    getByName(name) {
      const row = getByNameStmt.get(name) as ProjectRow | null;
      return row ? rowToProject(row) : undefined;
    },
    findByPathPrefix(absPath) {
      const rows = listStmt.all() as ProjectRow[];
      let best: Project | undefined;
      let bestLen = -1;
      for (const row of rows) {
        const project = rowToProject(row);
        if (!isPathInside(project.rootPath, absPath)) continue;
        const len = trimSlash(project.rootPath).length;
        if (len > bestLen) {
          best = project;
          bestLen = len;
        }
      }
      return best;
    },
    create(input) {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      try {
        insertStmt.run(id, input.name, input.rootPath, createdAt);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new DuplicateProjectNameError(input.name);
        }
        throw err;
      }
      return {
        id,
        name: input.name,
        rootPath: input.rootPath,
        createdAt,
      };
    },
    update(id, patch) {
      const existing = getStmt.get(id) as ProjectRow | null;
      if (!existing) return undefined;
      if (patch.name !== existing.name) {
        try {
          updateNameStmt.run(patch.name, id);
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            throw new DuplicateProjectNameError(patch.name);
          }
          throw err;
        }
      }
      const refreshed = getStmt.get(id) as ProjectRow | null;
      return refreshed ? rowToProject(refreshed) : undefined;
    },
    delete(id) {
      return deleteStmt.run(id).changes > 0;
    },
  };
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import type { Project } from "@keelson/shared";

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface ProjectsStore {
  list(): Project[];
  get(id: string): Project | undefined;
  getByName(name: string): Project | undefined;
  create(input: CreateProjectInput): Project;
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
      return { id, name: input.name, rootPath: input.rootPath, createdAt };
    },
    delete(id) {
      return deleteStmt.run(id).changes > 0;
    },
  };
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// One always-on markdown document per project — the local user's accumulated
// context about a repo. Lives only in this Keelson instance's SQLite store,
// never in the project repo. Distinct from the governed `memories` ledger.

import type { Database } from "bun:sqlite";

export interface ProjectNotebook {
  projectId: string;
  content: string;
  updatedAt: string;
}

export interface ProjectNotebookStore {
  get(projectId: string): ProjectNotebook | undefined;
  upsert(projectId: string, content: string): ProjectNotebook;
}

interface NotebookRow {
  project_id: string;
  content: string;
  updated_at: string;
}

function rowToNotebook(row: NotebookRow): ProjectNotebook {
  return { projectId: row.project_id, content: row.content, updatedAt: row.updated_at };
}

export function createProjectNotebookStore(db: Database): ProjectNotebookStore {
  const getStmt = db.prepare(
    "SELECT project_id, content, updated_at FROM project_notebooks WHERE project_id = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO project_notebooks (project_id, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  );

  return {
    get(projectId) {
      const row = getStmt.get(projectId) as NotebookRow | null;
      return row ? rowToNotebook(row) : undefined;
    },
    upsert(projectId, content) {
      const updatedAt = new Date().toISOString();
      upsertStmt.run(projectId, content, updatedAt);
      return { projectId, content, updatedAt };
    },
  };
}

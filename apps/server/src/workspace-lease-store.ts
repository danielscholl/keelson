// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";

export interface WorkspaceLeaseRecord {
  id: string;
  projectId: string | null;
  purpose: string;
  owner: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  status: "pending" | "active";
}

export interface WorkspaceLeaseStore {
  list(): WorkspaceLeaseRecord[];
  get(id: string): WorkspaceLeaseRecord | undefined;
  insert(record: WorkspaceLeaseRecord): void;
  markActive(id: string): void;
  updateBranch(id: string, branch: string): void;
  delete(id: string): boolean;
}

interface WorkspaceLeaseRow {
  id: string;
  project_id: string | null;
  purpose: string;
  owner: string;
  branch: string;
  worktree_path: string;
  created_at: string;
  status: string;
}

function rowToRecord(row: WorkspaceLeaseRow): WorkspaceLeaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    purpose: row.purpose,
    owner: row.owner,
    branch: row.branch,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    status: row.status === "pending" ? "pending" : "active",
  };
}

export function createWorkspaceLeaseStore(db: Database): WorkspaceLeaseStore {
  const listStmt = db.prepare(
    `SELECT id, project_id, purpose, owner, branch, worktree_path, created_at, status
     FROM workspace_leases
     ORDER BY created_at DESC, id ASC`,
  );
  const getStmt = db.prepare(
    `SELECT id, project_id, purpose, owner, branch, worktree_path, created_at, status
     FROM workspace_leases
     WHERE id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO workspace_leases(
       id, project_id, purpose, owner, branch, worktree_path, created_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markActiveStmt = db.prepare("UPDATE workspace_leases SET status = 'active' WHERE id = ?");
  const updateBranchStmt = db.prepare("UPDATE workspace_leases SET branch = ? WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM workspace_leases WHERE id = ?");

  return {
    list() {
      const rows = listStmt.all() as WorkspaceLeaseRow[];
      return rows.map(rowToRecord);
    },
    get(id) {
      const row = getStmt.get(id) as WorkspaceLeaseRow | null;
      return row ? rowToRecord(row) : undefined;
    },
    insert(record) {
      insertStmt.run(
        record.id,
        record.projectId,
        record.purpose,
        record.owner,
        record.branch,
        record.worktreePath,
        record.createdAt,
        record.status,
      );
    },
    markActive(id) {
      markActiveStmt.run(id);
    },
    updateBranch(id, branch) {
      updateBranchStmt.run(branch, id);
    },
    delete(id) {
      return deleteStmt.run(id).changes > 0;
    },
  };
}

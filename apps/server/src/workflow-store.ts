// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import {
  type ContentBlock,
  type NodeOutputRow,
  TERMINAL_RUN_STATUSES,
  type WorkflowNodeStatus,
  type WorkflowRunDetail,
  type WorkflowRunOrigin,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from "@keelson/shared";

export interface CreateRunInput {
  runId: string;
  workflowName: string;
  inputs: Record<string, string>;
  startedAt: string;
  // Every run is linked to a chat conversation at create-time. Nullable on
  // the row to tolerate FK SET NULL after the user deletes the conversation,
  // but the create path always sets it.
  conversationId: string;
  // Projects: when the caller targeted a named project. Nullable because the
  // CLI's in-process headless path may pass `workingDir` directly without a
  // project handle. Resolves to the project's root_path at run start.
  projectId?: string | null;
  // The cwd the executor will spawn against. Always set on new runs.
  workingDir: string;
  // Populated by the executor only when isolation is on (slice 3); null until then.
  worktreePath?: string | null;
  // How the run was triggered. Omitted → 'manual' (the operator paths). The
  // heartbeat / panel-refresh pass 'scheduled' so producer runs stay out of the
  // default feed and get retention-pruned.
  origin?: WorkflowRunOrigin;
  // The rib that owns this run's workflow, resolved from the catalog at start.
  ribId?: string | null;
}

// Filter for the general runs feed (GET /api/workflows/runs) and bulk delete.
// All fields optional; an omitted field doesn't constrain. `statuses` empty or
// omitted matches every status.
export interface RunQueryFilter {
  workflowName?: string;
  origin?: WorkflowRunOrigin;
  ribId?: string;
  statuses?: readonly WorkflowRunStatus[];
  limit?: number;
}

export interface UpsertNodeOutputInput {
  runId: string;
  nodeId: string;
  status: WorkflowNodeStatus;
  outputText: string | null;
  contentParts: ContentBlock[] | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: WorkflowRunStatus;
  completedAt: string | null;
  error: string | null;
}

export interface WorkflowStore {
  createRun(input: CreateRunInput): void;
  updateRunStatus(input: UpdateRunStatusInput): void;
  upsertNodeOutput(input: UpsertNodeOutputInput): void;
  // Removes a node's persisted snapshot row. Used by the interactive-loop
  // resume path so the row stops reporting `awaiting` while the loop
  // continues iterating — the row is recreated by the executor when the
  // node reaches a terminal status (succeeded/failed/skipped) via
  // upsertNodeOutput. Returns true if a row existed.
  deleteNodeOutput(runId: string, nodeId: string): boolean;
  // Patches worktree_path after-the-fact (worktree creation is lazy, so the
  // path isn't known at createRun time when isolation is on).
  setRunWorktreePath(runId: string, worktreePath: string | null): void;
  getRun(runId: string): WorkflowRunDetail | undefined;
  listRuns(workflowName?: string): WorkflowRunSummary[];
  // General filtered feed backing GET /api/workflows/runs and bulk delete.
  // Single SQL pass (vs. one listRuns per catalog entry), filterable by
  // workflow / origin / rib / status, newest first.
  queryRuns(filter: RunQueryFilter): WorkflowRunSummary[];
  // Retention support: terminal `scheduled` runs for a workflow beyond the
  // newest `keep`, paired with their linked conversation so the caller can
  // cascade-delete both. Never returns a non-terminal run (a live producer is
  // left alone). The newest `keep` rows of any status are protected.
  scheduledRunsToPrune(
    workflowName: string,
    keep: number,
  ): Array<{ runId: string; conversationId: string | null }>;
  // Drives the Workflows-nav badge: caller polls for `paused` rows so other
  // tabs can show a pending-input count without subscribing to every run's WS.
  listRunsByStatus(status: WorkflowRunStatus): WorkflowRunSummary[];
  // Distinct non-null worktree_path values across all runs. Used by `keelson
  // worktree prune` so worktrees from deleted projects (FK NULLed but path
  // still persisted) remain reachable for cleanup.
  listWorktreePaths(): string[];
  // Hard-delete a terminal run. FK CASCADE on workflow_node_outputs handles
  // the per-node rows. The route layer is responsible for the linked
  // conversation (FK is SET NULL, not CASCADE).
  deleteRun(runId: string): boolean;
  // Used by the chat-side cascade: when a conversation is deleted, the
  // handler looks up the linked run (1:1 via the UNIQUE index) so it can
  // purge it instead of leaving an orphan in the Workflows list.
  getRunIdByConversationId(conversationId: string): string | null;
}

interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  inputs_json: string;
  error: string | null;
  conversation_id: string | null;
  project_id: string | null;
  working_dir: string | null;
  worktree_path: string | null;
  origin: string;
  rib_id: string | null;
}

interface NodeRow {
  node_id: string;
  status: string;
  output_text: string | null;
  content_parts_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

function rowToRunSummary(row: RunRow): WorkflowRunSummary {
  return {
    runId: row.id,
    workflowName: row.workflow_name,
    status: row.status as WorkflowRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    workingDir: row.working_dir,
    worktreePath: row.worktree_path,
    origin: row.origin === "scheduled" ? "scheduled" : "manual",
    ribId: row.rib_id,
  };
}

// Hydrate the JSON-serialized content_parts column. Degrades to null on parse
// failure rather than throwing — keeps the run-detail endpoint serving even if
// a write path elsewhere stored malformed JSON.
function parseContentParts(raw: string | null): ContentBlock[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as ContentBlock[];
  } catch (err) {
    console.warn(
      `[keelson] failed to parse workflow_node_outputs.content_parts_json: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function rowToNodeOutput(row: NodeRow): NodeOutputRow {
  return {
    nodeId: row.node_id,
    status: row.status as WorkflowNodeStatus,
    outputText: row.output_text,
    contentParts: parseContentParts(row.content_parts_json),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export function createWorkflowStore(db: Database): WorkflowStore {
  // Boot-time reconcile: any rows still in 'running' or 'paused' belong to a
  // prior process that crashed or was killed before the shutdown drain could
  // mark them terminal. Without this sweep they'd be stuck indefinitely
  // (graceful shutdown only catches the current process; /api/db/reset
  // is opt-in). `paused` is in-memory only — a server restart loses the
  // AwaitApproval promise, so we mark those failed too with a clear
  // breadcrumb. Same sweep also lifts the related `workflow_node_outputs`
  // rows out of 'awaiting' so the snapshot stays internally consistent.
  db.exec(
    `UPDATE workflow_runs
       SET status = 'failed',
           error = COALESCE(error, 'server exited before run completed'),
           completed_at = COALESCE(completed_at, datetime('now'))
     WHERE status IN ('running', 'paused');`,
  );
  db.exec(
    `UPDATE workflow_node_outputs
       SET status = 'failed',
           error = COALESCE(error, 'server exited before run completed'),
           completed_at = COALESCE(completed_at, datetime('now'))
     WHERE status = 'awaiting';`,
  );

  const insertRun = db.prepare(
    "INSERT INTO workflow_runs(id, workflow_name, status, started_at, completed_at, inputs_json, error, conversation_id, project_id, working_dir, worktree_path, origin, rib_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateRun = db.prepare(
    "UPDATE workflow_runs SET status = ?, completed_at = ?, error = ? WHERE id = ?",
  );
  const updateWorktreePath = db.prepare("UPDATE workflow_runs SET worktree_path = ? WHERE id = ?");
  const selectRun = db.prepare("SELECT * FROM workflow_runs WHERE id = ?");
  const listRunsAll = db.prepare(
    "SELECT * FROM workflow_runs ORDER BY started_at DESC, rowid DESC",
  );
  const listRunsByName = db.prepare(
    "SELECT * FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC, rowid DESC",
  );
  const listRunsByStatusStmt = db.prepare(
    "SELECT * FROM workflow_runs WHERE status = ? ORDER BY started_at DESC, rowid DESC",
  );
  const upsertNode = db.prepare(
    `INSERT INTO workflow_node_outputs(run_id, node_id, status, output_text, content_parts_json, started_at, completed_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, node_id) DO UPDATE SET
       status = excluded.status,
       output_text = excluded.output_text,
       content_parts_json = excluded.content_parts_json,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       error = excluded.error`,
  );
  // rowid tiebreak preserves DAG insertion order when two nodes share a
  // completed_at millisecond — the executor runs siblings in parallel and
  // commits via the per-layer write buffer, so timestamp ties are common.
  const selectNodes = db.prepare(
    "SELECT node_id, status, output_text, content_parts_json, started_at, completed_at, error FROM workflow_node_outputs WHERE run_id = ? ORDER BY rowid ASC",
  );
  const deleteRunStmt = db.prepare("DELETE FROM workflow_runs WHERE id = ?");
  const deleteNodeStmt = db.prepare(
    "DELETE FROM workflow_node_outputs WHERE run_id = ? AND node_id = ?",
  );
  const selectRunIdByConv = db.prepare("SELECT id FROM workflow_runs WHERE conversation_id = ?");

  return {
    createRun(input) {
      insertRun.run(
        input.runId,
        input.workflowName,
        "running",
        input.startedAt,
        null,
        JSON.stringify(input.inputs),
        null,
        input.conversationId,
        input.projectId ?? null,
        input.workingDir,
        input.worktreePath ?? null,
        input.origin ?? "manual",
        input.ribId ?? null,
      );
    },
    updateRunStatus(input) {
      updateRun.run(input.status, input.completedAt, input.error, input.runId);
    },
    setRunWorktreePath(runId, worktreePath) {
      updateWorktreePath.run(worktreePath, runId);
    },
    upsertNodeOutput(input) {
      upsertNode.run(
        input.runId,
        input.nodeId,
        input.status,
        input.outputText,
        input.contentParts !== null ? JSON.stringify(input.contentParts) : null,
        input.startedAt,
        input.completedAt,
        input.error,
      );
    },
    getRun(runId) {
      const row = selectRun.get(runId) as RunRow | null;
      if (!row) return undefined;
      const nodes = (selectNodes.all(runId) as NodeRow[]).map(rowToNodeOutput);
      let inputs: Record<string, string>;
      try {
        const parsed = JSON.parse(row.inputs_json);
        inputs =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, string>)
            : {};
      } catch {
        inputs = {};
      }
      return {
        ...rowToRunSummary(row),
        inputs,
        nodes,
      };
    },
    listRuns(workflowName) {
      const rows = (
        workflowName !== undefined ? listRunsByName.all(workflowName) : listRunsAll.all()
      ) as RunRow[];
      return rows.map(rowToRunSummary);
    },
    listRunsByStatus(status) {
      const rows = listRunsByStatusStmt.all(status) as RunRow[];
      return rows.map(rowToRunSummary);
    },
    queryRuns(filter) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.workflowName !== undefined) {
        clauses.push("workflow_name = ?");
        params.push(filter.workflowName);
      }
      if (filter.origin !== undefined) {
        clauses.push("origin = ?");
        params.push(filter.origin);
      }
      if (filter.ribId !== undefined) {
        clauses.push("rib_id = ?");
        params.push(filter.ribId);
      }
      if (filter.statuses !== undefined && filter.statuses.length > 0) {
        clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
        params.push(...filter.statuses);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      let sql = `SELECT * FROM workflow_runs ${where} ORDER BY started_at DESC, rowid DESC`;
      // Bind the limit (don't interpolate) — keeps this fully parameterized and
      // collapses the prepared-statement cache to one entry regardless of value.
      if (filter.limit !== undefined && filter.limit >= 0) {
        sql += " LIMIT ?";
        params.push(Math.floor(filter.limit));
      }
      const rows = db.query(sql).all(...params) as RunRow[];
      return rows.map(rowToRunSummary);
    },
    scheduledRunsToPrune(workflowName, keep) {
      const rows = db
        .query(
          `SELECT id, conversation_id, status FROM workflow_runs
             WHERE workflow_name = ? AND origin = 'scheduled'
             ORDER BY started_at DESC, rowid DESC`,
        )
        .all(workflowName) as { id: string; conversation_id: string | null; status: string }[];
      const out: Array<{ runId: string; conversationId: string | null }> = [];
      const protectedCount = Math.max(0, Math.floor(keep));
      for (const r of rows.slice(protectedCount)) {
        if (TERMINAL_RUN_STATUSES.includes(r.status as WorkflowRunStatus)) {
          out.push({ runId: r.id, conversationId: r.conversation_id });
        }
      }
      return out;
    },
    listWorktreePaths() {
      const rows = db
        .query("SELECT DISTINCT worktree_path FROM workflow_runs WHERE worktree_path IS NOT NULL")
        .all() as { worktree_path: string }[];
      return rows.map((r) => r.worktree_path);
    },
    deleteRun(runId) {
      return deleteRunStmt.run(runId).changes > 0;
    },
    deleteNodeOutput(runId, nodeId) {
      return deleteNodeStmt.run(runId, nodeId).changes > 0;
    },
    getRunIdByConversationId(conversationId) {
      const row = selectRunIdByConv.get(conversationId) as { id: string } | null;
      return row?.id ?? null;
    },
  };
}

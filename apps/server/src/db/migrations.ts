// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "baseline schema: conversations, messages, workflow runs, projects, memory layer",
    up: (db) => {
      db.exec(`
        CREATE TABLE keelson_projects (
          id         TEXT PRIMARY KEY NOT NULL,
          name       TEXT NOT NULL UNIQUE,
          root_path  TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX ix_keelson_projects_name ON keelson_projects(name);

        CREATE TABLE conversations (
          id                TEXT PRIMARY KEY NOT NULL,
          providerId        TEXT NOT NULL,
          model             TEXT,
          providerSessionId TEXT,
          name              TEXT,
          seedSystemPrompt  TEXT,
          createdAt         TEXT NOT NULL,
          updatedAt         TEXT NOT NULL,
          project_id        TEXT REFERENCES keelson_projects(id) ON DELETE SET NULL
        );
        CREATE INDEX ix_conversations_project ON conversations(project_id);

        CREATE TABLE messages (
          id              TEXT PRIMARY KEY NOT NULL,
          conversationId  TEXT NOT NULL,
          role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content         TEXT NOT NULL,
          content_parts   TEXT,
          truncated       INTEGER DEFAULT 0,
          createdAt       TEXT NOT NULL,
          FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_messages_conv_created
          ON messages (conversationId, createdAt);

        CREATE TABLE workflow_runs (
          id              TEXT PRIMARY KEY,
          workflow_name   TEXT NOT NULL,
          status          TEXT NOT NULL,
          started_at      TEXT NOT NULL,
          completed_at    TEXT,
          inputs_json     TEXT NOT NULL DEFAULT '{}',
          error           TEXT,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          project_id      TEXT REFERENCES keelson_projects(id) ON DELETE SET NULL,
          working_dir     TEXT,
          worktree_path   TEXT
        );
        CREATE INDEX ix_workflow_runs_name_started
          ON workflow_runs(workflow_name, started_at DESC);
        CREATE UNIQUE INDEX ix_workflow_runs_conversation
          ON workflow_runs(conversation_id)
          WHERE conversation_id IS NOT NULL;
        CREATE INDEX ix_workflow_runs_status_started
          ON workflow_runs(status, started_at DESC);
        CREATE INDEX ix_workflow_runs_project_started
          ON workflow_runs(project_id, started_at DESC);

        CREATE TABLE workflow_node_outputs (
          run_id             TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          node_id            TEXT NOT NULL,
          status             TEXT NOT NULL,
          output_text        TEXT,
          content_parts_json TEXT,
          started_at         TEXT,
          completed_at       TEXT,
          error              TEXT,
          PRIMARY KEY (run_id, node_id)
        );

        CREATE TABLE memories (
          id                                     TEXT PRIMARY KEY NOT NULL,
          type                                   TEXT NOT NULL CHECK (type IN (
            'decision','output','lesson','constraint','open_question','failure','artifact_reference','work_log'
          )),
          summary                                TEXT NOT NULL,
          content                                TEXT NOT NULL,
          provenance                             TEXT NOT NULL CHECK (provenance IN (
            'observed','inferred','user_confirmed','imported','generated','superseded','disputed'
          )),
          use_policy_can_use_as_instruction      INTEGER NOT NULL DEFAULT 0
                                                 CHECK (use_policy_can_use_as_instruction IN (0, 1)),
          use_policy_can_use_as_evidence         INTEGER NOT NULL DEFAULT 1
                                                 CHECK (use_policy_can_use_as_evidence IN (0, 1)),
          use_policy_requires_user_confirmation  INTEGER NOT NULL DEFAULT 0
                                                 CHECK (use_policy_requires_user_confirmation IN (0, 1)),
          use_policy_do_not_inject_automatically INTEGER NOT NULL DEFAULT 0
                                                 CHECK (use_policy_do_not_inject_automatically IN (0, 1)),
          scope_project_id                       TEXT,
          scope_visibility                       TEXT NOT NULL DEFAULT 'project'
                                                 CHECK (scope_visibility IN ('project','personal')),
          lifecycle                              TEXT NOT NULL DEFAULT 'active'
                                                 CHECK (lifecycle IN (
                                                   'active','stale','superseded','disputed','rejected'
                                                 )),
          review_status                          TEXT NOT NULL DEFAULT 'pending'
                                                 CHECK (review_status IN (
                                                   'pending','confirmed','evidence_only','restricted','rejected','stale','merged'
                                                 )),
          content_hash                           TEXT NOT NULL,
          idempotency_key                        TEXT NOT NULL UNIQUE,
          confidence                             REAL CHECK (confidence >= 0 AND confidence <= 1),
          runtime                                TEXT NOT NULL,
          task_id                                TEXT,
          flow_id                                TEXT,
          model                                  TEXT,
          provider                               TEXT,
          created_at                             TEXT NOT NULL,
          updated_at                             TEXT NOT NULL,
          stale_after                            TEXT,
          CHECK (
            use_policy_can_use_as_instruction = 0
            OR provenance IN ('user_confirmed','imported')
          )
        );
        CREATE INDEX idx_memories_runtime_created_at
          ON memories(runtime, created_at DESC);
        CREATE INDEX idx_memories_scope_lifecycle
          ON memories(scope_visibility, lifecycle);
        CREATE INDEX idx_memories_review_status
          ON memories(review_status);

        CREATE TABLE memory_source_refs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id   TEXT NOT NULL,
          kind        TEXT NOT NULL,
          identifier  TEXT NOT NULL,
          url         TEXT,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE TABLE memory_artifacts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id   TEXT NOT NULL,
          kind        TEXT NOT NULL,
          content     TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE TABLE memory_review_actions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id   TEXT NOT NULL,
          action      TEXT NOT NULL CHECK (action IN (
            'confirm','evidence_only','restrict','reject','merge','mark_stale'
          )),
          actor       TEXT NOT NULL,
          notes       TEXT,
          created_at  TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE TABLE memory_recall_traces (
          id              TEXT PRIMARY KEY NOT NULL,
          request_id      TEXT NOT NULL,
          query           TEXT NOT NULL,
          scope_json      TEXT NOT NULL,
          returned_count  INTEGER NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX idx_memory_recall_traces_request_id
          ON memory_recall_traces(request_id);

        CREATE TABLE memory_recall_items (
          trace_id    TEXT NOT NULL,
          memory_id   TEXT NOT NULL,
          rank        INTEGER NOT NULL,
          used        INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
          PRIMARY KEY (trace_id, memory_id),
          FOREIGN KEY (trace_id)  REFERENCES memory_recall_traces(id) ON DELETE CASCADE,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE TABLE memory_audit_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type    TEXT NOT NULL,
          memory_id     TEXT,
          actor         TEXT,
          payload_json  TEXT,
          created_at    TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        );

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          summary,
          content,
          content='memories',
          content_rowid='rowid'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, summary, content)
          VALUES (new.rowid, new.summary, new.content);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, summary, content)
          VALUES('delete', old.rowid, old.summary, old.content);
        END;

        CREATE TRIGGER memories_au AFTER UPDATE OF summary, content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, summary, content)
          VALUES('delete', old.rowid, old.summary, old.content);
          INSERT INTO memories_fts(rowid, summary, content)
          VALUES (new.rowid, new.summary, new.content);
        END;
      `);
    },
  },
  {
    version: 2,
    description: "project notebooks: per-project always-on markdown context",
    up: (db) => {
      db.exec(`
        CREATE TABLE project_notebooks (
          project_id TEXT PRIMARY KEY NOT NULL REFERENCES keelson_projects(id) ON DELETE CASCADE,
          content    TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    description: "workflow run provenance: origin (manual|scheduled) + owning rib_id",
    up: (db) => {
      db.exec(`
        ALTER TABLE workflow_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual', 'scheduled'));
        ALTER TABLE workflow_runs ADD COLUMN rib_id TEXT;
        CREATE INDEX ix_workflow_runs_origin_started
          ON workflow_runs(origin, started_at DESC);
      `);
    },
  },
  {
    version: 4,
    description: "token usage: per-message and per-workflow-node usage_json",
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN usage_json TEXT;
        ALTER TABLE workflow_node_outputs ADD COLUMN usage_json TEXT;
      `);
    },
  },
  {
    version: 5,
    description: "workflow node provenance: effective provider + model per LLM node",
    up: (db) => {
      db.exec(`
        ALTER TABLE workflow_node_outputs ADD COLUMN provider TEXT;
        ALTER TABLE workflow_node_outputs ADD COLUMN model TEXT;
      `);
    },
  },
  {
    version: 6,
    description: "usage ledger: per-turn spend events across chat, workflow, and rib surfaces",
    up: (db) => {
      db.exec(`
        CREATE TABLE usage_events (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          ts                 TEXT NOT NULL,
          source             TEXT NOT NULL,
          provider           TEXT NOT NULL,
          model              TEXT NOT NULL,
          input_tokens       INTEGER NOT NULL DEFAULT 0,
          output_tokens      INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens  INTEGER,
          cache_write_tokens INTEGER,
          duration_ms        INTEGER,
          status             TEXT NOT NULL DEFAULT 'ok',
          conversation_id    TEXT,
          run_id             TEXT,
          node_id            TEXT,
          workflow_name      TEXT,
          rib_id             TEXT,
          project_id         TEXT
        );
        CREATE INDEX ix_usage_events_ts ON usage_events(ts);
        CREATE INDEX ix_usage_events_model_ts ON usage_events(model, ts);
        CREATE INDEX ix_usage_events_source_ts ON usage_events(source, ts);

        ALTER TABLE messages ADD COLUMN provider TEXT;
        ALTER TABLE messages ADD COLUMN model TEXT;
      `);
    },
  },
  {
    version: 7,
    description: "workflow run worktree base ref",
    up: (db) => {
      db.exec(`
        ALTER TABLE workflow_runs ADD COLUMN worktree_base TEXT;
      `);
    },
  },
  {
    version: 8,
    description: "workspace leases: durable isolated-checkout records",
    up: (db) => {
      db.exec(`
        CREATE TABLE workspace_leases (
          id            TEXT PRIMARY KEY NOT NULL,
          project_id    TEXT REFERENCES keelson_projects(id) ON DELETE SET NULL,
          purpose       TEXT NOT NULL,
          owner         TEXT NOT NULL,
          branch        TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending', 'active'))
        );
        CREATE INDEX ix_workspace_leases_project
          ON workspace_leases(project_id);
        CREATE UNIQUE INDEX ux_workspace_leases_path
          ON workspace_leases(worktree_path);
      `);
    },
  },
  {
    version: 9,
    description: "usage events: index the per-run budget aggregation",
    up: (db) => {
      db.exec(`
        CREATE INDEX ix_usage_events_source_run
          ON usage_events(source, run_id);
      `);
    },
  },
  {
    version: 10,
    description: "op registry: durable run handles + cursor-based event log",
    up: (db) => {
      db.exec(`
        CREATE TABLE ops (
          id           TEXT PRIMARY KEY NOT NULL,
          kind         TEXT NOT NULL,
          title        TEXT,
          owner        TEXT NOT NULL,
          project_id   TEXT REFERENCES keelson_projects(id) ON DELETE SET NULL,
          status       TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'done', 'error', 'cancelled', 'orphaned')),
          steerable    INTEGER NOT NULL DEFAULT 0 CHECK (steerable IN (0, 1)),
          result_json  TEXT,
          error        TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX ix_ops_status_created ON ops(status, created_at DESC);
        CREATE INDEX ix_ops_project ON ops(project_id);

        CREATE TABLE op_events (
          op_id      TEXT NOT NULL REFERENCES ops(id) ON DELETE CASCADE,
          seq        INTEGER NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('log', 'progress', 'done', 'error')),
          message    TEXT,
          data_json  TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (op_id, seq)
        );
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
  const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
    v: number | null;
  } | null;
  const current = row?.v ?? 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const apply = db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(m.version);
    });
    apply();
  }
}

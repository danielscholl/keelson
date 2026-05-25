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
    description: "initial schema: conversations, messages, workflow_runs",
    up: (db) => {
      db.exec(`
        CREATE TABLE conversations (
          id                TEXT PRIMARY KEY NOT NULL,
          providerId        TEXT NOT NULL,
          model             TEXT,
          providerSessionId TEXT,
          name              TEXT,
          seedSystemPrompt  TEXT,
          createdAt         TEXT NOT NULL,
          updatedAt         TEXT NOT NULL
        );

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
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
        );
        CREATE INDEX ix_workflow_runs_name_started
          ON workflow_runs(workflow_name, started_at DESC);
        CREATE UNIQUE INDEX ix_workflow_runs_conversation
          ON workflow_runs(conversation_id)
          WHERE conversation_id IS NOT NULL;

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
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
  );
  const row = db
    .query("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null } | null;
  const current = row?.v ?? 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(
        m.version,
      );
    })();
  }
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runMigrations } from "../src/db/migrations.ts";

// v9 rebuilds keelson_projects to drop the worktree_layout column. The table is
// the parent of an ON DELETE SET NULL foreign key from conversations, so the
// regression this guards is: the implicit DELETE during DROP TABLE must NOT
// null out conversations.project_id.
describe("migration v9: drop worktree_layout", () => {
  function seedV8(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE keelson_projects (
        id         TEXT PRIMARY KEY NOT NULL,
        name       TEXT NOT NULL UNIQUE,
        root_path  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        worktree_layout TEXT NOT NULL DEFAULT 'workspace-scoped'
          CHECK (worktree_layout IN ('workspace-scoped','repo-local'))
      );
      CREATE INDEX ix_keelson_projects_name ON keelson_projects(name);
      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES keelson_projects(id) ON DELETE SET NULL
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    `);
    for (let v = 1; v <= 8; v++) {
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(v);
    }
    db.prepare(
      "INSERT INTO keelson_projects(id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("p1", "proj", "/tmp/p", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO conversations(id, project_id) VALUES (?, ?)").run("c1", "p1");
    return db;
  }

  test("drops the column and preserves the conversations FK", () => {
    const db = seedV8();
    runMigrations(db);

    const cols = db.query("PRAGMA table_info(keelson_projects)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "worktree_layout")).toBe(false);

    const conv = db.query("SELECT project_id FROM conversations WHERE id = 'c1'").get() as {
      project_id: string | null;
    };
    expect(conv.project_id).toBe("p1");

    // The project row itself survives the rebuild.
    const proj = db.query("SELECT name, root_path FROM keelson_projects WHERE id = 'p1'").get() as {
      name: string;
      root_path: string;
    };
    expect(proj.name).toBe("proj");

    // Foreign-key enforcement is restored after the FK-disabled rebuild.
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);

    db.close();
  });
});

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

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("migrations", () => {
  test("a fresh database gets the whole schema and all current stamps", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const versions = (
      db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(versions).toEqual([12, 13]);

    expect(tableNames(db)).toContain("conversations");
    expect(tableNames(db)).toContain("memories");
    expect(tableNames(db)).toContain("workflow_runs");
    expect(tableNames(db)).toContain("usage_events");
    expect(tableNames(db)).toContain("ops");
    db.close();
  });

  // The baseline replaced a twelve-step ladder in place: any database that
  // ladder stamped must stay untouched, so the baseline's version can never be
  // renumbered below 12.
  test("a database the previous ladder stamped skips the baseline and applies newer migrations", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);");
    db.exec("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);");
    for (let v = 1; v <= 12; v += 1) {
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(v);
    }

    runMigrations(db);

    const columns = db.query("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("provider_override");
    expect(db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).toEqual(
      { v: 13 },
    );
    db.close();
  });

  test("a database stranded below the baseline fails with an actionable error", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);");
    for (let v = 1; v <= 9; v += 1) {
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(v);
    }

    expect(() => {
      runMigrations(db);
    }).toThrow(/schema is at v9, which predates this build's v12 baseline/);
    db.close();
  });

  test("reopening an already-migrated database applies nothing", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const before = tableNames(db);

    runMigrations(db);

    expect(tableNames(db)).toEqual(before);
    expect(db.query("SELECT count(*) AS c FROM schema_version").get() as { c: number }).toEqual({
      c: 2,
    });
    db.close();
  });
});

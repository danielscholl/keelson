// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrations.ts";

export interface InitDbOptions {
  path: string;
}

// Opens (or creates) the SQLite database, applies connection-scoped PRAGMAs,
// and runs any pending migrations. Returns the live handle. PRAGMA foreign_keys
// is per-connection — must be re-issued every open, including in tests.
export function openDatabase({ path }: InitDbOptions): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

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

// File-backed handles opened in this process. Tracked so the test harness can
// close them before deleting the temp dirs that hold them: Windows refuses to
// unlink an open SQLite file and the GC finalizer doesn't run promptly enough to
// rely on. In-memory (":memory:") handles never block a delete, so they stay
// untracked. Production opens a single handle for the process lifetime, so this
// holds at most one entry there.
const trackedHandles = new Set<Database>();

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
  if (path !== ":memory:") trackedHandles.add(db);
  return db;
}

// Close every tracked file-backed handle. The server test harness calls this in
// a file's afterEach (before deleting its temp dir) so a subsequent recursive
// delete doesn't hit a Windows EBUSY on an open SQLite file. Safe to call
// repeatedly and on already-closed handles.
//
// close() only marks the connection a zombie — the OS file handle lingers until
// the prepared statements the stores left behind finalize. On Windows that open
// handle blocks the delete, and the finalizers don't run promptly on their own,
// so force a GC here to run them synchronously once anything was closed.
export function closeTrackedDatabases(): void {
  let closedAny = false;
  for (const db of trackedHandles) {
    closedAny = true;
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  trackedHandles.clear();
  if (closedAny) Bun.gc(true);
}

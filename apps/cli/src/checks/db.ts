// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { defaultDbPath } from "../paths.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

// Mirror the highest `version` in apps/server/src/db/migrations.ts; a binding
// test in doctor.test.ts asserts the two stay in sync.
export const LATEST_MIGRATION_VERSION = 8;

interface SchemaRow {
  v: number | null;
}

export interface DbReader {
  readSchemaVersion(path: string): number | null;
}

const defaultReader: DbReader = {
  readSchemaVersion(path: string): number | null {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query("SELECT MAX(version) AS v FROM schema_version")
        .get() as SchemaRow | null;
      return row?.v ?? null;
    } finally {
      db.close();
    }
  },
};

export interface DbDeps {
  dbPath?: string;
  reader?: DbReader;
  exists?: (path: string) => boolean;
  latestVersion?: number;
}

export async function runDbCheck(deps: DbDeps = {}): Promise<CategoryResult> {
  const path = deps.dbPath ?? defaultDbPath();
  const exists = deps.exists ?? existsSync;
  const reader = deps.reader ?? defaultReader;
  const latest = deps.latestVersion ?? LATEST_MIGRATION_VERSION;

  if (!exists(path)) {
    const check: CheckResult = {
      name: "schema_version",
      status: "warn",
      detail: `db not found at ${path}`,
      hint: "run `keelson start` once to create and migrate the SQLite database",
    };
    return { category: "db", checks: [check] };
  }

  let current: number | null;
  try {
    current = reader.readSchemaVersion(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const check: CheckResult = {
      name: "schema_version",
      status: "fail",
      detail: `failed to read ${path}: ${message}`,
      hint: "the SQLite file may be corrupt or locked; stop any running server (`keelson stop`) and try again",
    };
    return { category: "db", checks: [check] };
  }

  if (current === null) {
    const check: CheckResult = {
      name: "schema_version",
      status: "warn",
      detail: "schema_version table is empty",
      hint: "run `keelson start` once to apply migrations",
    };
    return { category: "db", checks: [check] };
  }

  if (current < latest) {
    const check: CheckResult = {
      name: "schema_version",
      status: "warn",
      detail: `db at v${current}, expected v${latest}`,
      hint: "run `keelson start` to apply pending migrations",
    };
    return { category: "db", checks: [check] };
  }

  if (current > latest) {
    const check: CheckResult = {
      name: "schema_version",
      // Newer-than-CLI is a real fail: the server that wrote this row knows
      // tables the CLI's bundled migrations don't. Operator likely needs to
      // upgrade keelson.
      status: "fail",
      detail: `db at v${current}, CLI knows v${latest}`,
      hint: "upgrade keelson — the on-disk DB is newer than this binary's bundled migrations",
    };
    return { category: "db", checks: [check] };
  }

  const check: CheckResult = {
    name: "schema_version",
    status: "ok",
    detail: `v${current} (current)`,
  };
  return { category: "db", checks: [check] };
}

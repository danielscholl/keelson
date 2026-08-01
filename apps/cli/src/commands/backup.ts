// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { keelsonPaths } from "@keelson/shared/paths";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";

export interface BackupOptions {
  json: boolean;
  output?: string;
  // Matches `keelson start --db`: a server started against a per-run database
  // is not backed up by snapshotting the home's default one.
  db?: string;
}

// Local time, filename-safe, sorts chronologically.
export function backupFileName(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `keelson-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}.db`;
}

// A bare directory (existing, or any path ending in a separator) receives the
// generated name; anything else is taken as the full destination file.
export function resolveBackupTarget(output: string | undefined, home: string, now: Date): string {
  const generated = backupFileName(now);
  if (!output) return join(home, "backups", generated);
  const abs = isAbsolute(output) ? output : resolve(output);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, generated);
  return abs;
}

export async function runBackup(opts: BackupOptions): Promise<never> {
  const home = resolveKeelsonHome();
  const dbPath = opts.db ? resolve(opts.db) : keelsonPaths(home).dbPath;
  if (!existsSync(dbPath)) {
    emit({ error: `no keelson database at ${dbPath}`, code: "NOT_FOUND" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
  const target = resolveBackupTarget(opts.output, home, new Date());
  if (existsSync(target)) {
    emit({ error: `refusing to overwrite ${target}`, code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (err) {
    emit(
      {
        error: `cannot create ${dirname(target)}: ${(err as Error).message}`,
        code: "BAD_INPUTS",
      },
      { json: opts.json },
    );
    process.exit(EXIT_BAD_ARGS);
  }

  // VACUUM INTO takes a read transaction and writes a fresh, fully-checkpointed
  // file, so the copy is consistent even while the server is mid-write and it
  // needs no -wal/-shm sidecar to be restorable. Opened read-only so a backup
  // can never migrate or otherwise touch the live database.
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    emit(
      { error: `could not open ${dbPath}: ${(err as Error).message}`, code: "DB_OPEN_FAILED" },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  // Vacuum to a sibling and rename only on success. SQLite creates the
  // destination up front, so a failure partway (disk full, an interrupt) would
  // otherwise leave a truncated file sitting at the backup name — which the
  // next run then refuses to overwrite and a backup sweep reads as valid.
  const staging = `${target}.partial-${process.pid}`;
  try {
    db.exec(`VACUUM INTO ${escapeSqlString(staging)}`);
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { force: true });
    emit(
      { error: `backup failed: ${(err as Error).message}`, code: "BACKUP_FAILED" },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  } finally {
    db.close();
  }

  const bytes = statSync(target).size;
  emit({ data: { source: dbPath, backup: target, bytes } }, { json: opts.json });
  if (!opts.json) {
    process.stdout.write(`\nwrote ${target} (${formatBytes(bytes)})\n`);
  }
  process.exit(EXIT_OK);
}

// VACUUM INTO takes a string literal, not a bindable parameter.
function escapeSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

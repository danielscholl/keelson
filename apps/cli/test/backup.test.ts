// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFileName, resolveBackupTarget } from "../src/commands/backup.ts";

describe("backupFileName", () => {
  test("is filename-safe and sorts chronologically", () => {
    expect(backupFileName(new Date(2026, 7, 1, 9, 5, 3))).toBe("keelson-20260801-090503.db");
    const earlier = backupFileName(new Date(2026, 0, 2, 3, 4, 5));
    const later = backupFileName(new Date(2026, 10, 20, 23, 59, 59));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("resolveBackupTarget", () => {
  let home: string;
  const now = new Date(2026, 7, 1, 14, 30, 22);
  const generated = "keelson-20260801-143022.db";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-backup-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("defaults into the home's backups directory", () => {
    expect(resolveBackupTarget(undefined, home, now)).toBe(join(home, "backups", generated));
  });

  test("an existing directory receives the generated name", () => {
    const dir = join(home, "dest");
    mkdirSync(dir);
    expect(resolveBackupTarget(dir, home, now)).toBe(join(dir, generated));
  });

  test("an explicit file path is used verbatim", () => {
    const file = join(home, "snapshot.db");
    expect(resolveBackupTarget(file, home, now)).toBe(file);
  });

  test("a relative path resolves against the cwd, not the home", () => {
    const target = resolveBackupTarget("out.db", home, now);
    expect(target).toBe(join(process.cwd(), "out.db"));
    expect(target.startsWith(home)).toBe(false);
  });
});

describe("VACUUM INTO snapshot semantics", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keelson-vacuum-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The whole point of the command: copying keelson.db by hand while the server
  // holds a WAL can capture a torn state, and the -wal sidecar is needed to make
  // sense of it. A vacuumed copy is self-contained and consistent.
  test("captures a consistent copy of a live WAL database with no sidecar", () => {
    const src = join(dir, "live.db");
    const out = join(dir, "backup.db");
    const writer = new Database(src, { create: true });
    writer.exec("PRAGMA journal_mode = WAL;");
    writer.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT);");
    for (let i = 0; i < 250; i++) writer.run("INSERT INTO runs (name) VALUES (?)", [`run-${i}`]);
    expect(existsSync(`${src}-wal`)).toBe(true);

    const reader = new Database(src, { readonly: true });
    reader.exec(`VACUUM INTO '${out}'`);
    reader.close();

    const restored = new Database(out, { readonly: true });
    expect((restored.query("SELECT count(*) c FROM runs").get() as { c: number }).c).toBe(250);
    restored.close();
    expect(existsSync(`${out}-wal`)).toBe(false);
    writer.close();
  });

  test("refuses to overwrite an existing target", () => {
    const src = join(dir, "live.db");
    const out = join(dir, "backup.db");
    const writer = new Database(src, { create: true });
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY);");
    writer.exec(`VACUUM INTO '${out}'`);
    expect(() => writer.exec(`VACUUM INTO '${out}'`)).toThrow();
    writer.close();
  });
});

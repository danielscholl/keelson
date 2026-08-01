// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[], home: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Port 1 is privileged and never bound, so the server probe is always
    // refused and this never touches a real running server.
    env: {
      ...process.env,
      KEELSON_HOME: home,
      KEELSON_SERVER_URL: "http://127.0.0.1:1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function seedDb(path: string, rows = 25): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT);");
  for (let i = 0; i < rows; i++) db.run("INSERT INTO runs (name) VALUES (?)", [`run-${i}`]);
  db.close();
}

describe("keelson backup (spawned CLI)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-backup-cli-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("writes a restorable snapshot to the default target and reports it", async () => {
    seedDb(join(home, "keelson.db"));
    const res = await runCli(["backup", "--json"], home);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { source: string; backup: string; bytes: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.backup).toMatch(/backups[/\\]keelson-\d{8}-\d{6}\.db$/);
    expect(payload.data.bytes).toBeGreaterThan(0);

    const restored = new Database(payload.data.backup, { readonly: true });
    expect((restored.query("SELECT count(*) c FROM runs").get() as { c: number }).c).toBe(25);
    restored.close();
    // A vacuumed copy is self-contained; a sidecar would mean it is not.
    expect(existsSync(`${payload.data.backup}-wal`)).toBe(false);
  });

  test("human mode names the file it wrote", async () => {
    seedDb(join(home, "keelson.db"));
    const res = await runCli(["backup"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("wrote ");
    expect(res.stdout).toContain("backups");
  });

  test("a missing database exits 1 rather than writing an empty snapshot", async () => {
    const res = await runCli(["backup", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe("NOT_FOUND");
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  test("refuses to overwrite an existing target and leaves it untouched", async () => {
    seedDb(join(home, "keelson.db"));
    const target = join(home, "snapshot.db");
    writeFileSync(target, "not a database");
    const res = await runCli(["backup", target, "--json"], home);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout).code).toBe("BAD_INPUTS");
    expect(Bun.file(target).size).toBe("not a database".length);
  });

  test("--db snapshots the named database instead of the home default", async () => {
    seedDb(join(home, "keelson.db"), 5);
    const other = join(home, "other.db");
    seedDb(other, 40);
    const res = await runCli(["backup", "--db", other, "--json"], home);
    expect(res.exitCode).toBe(0);
    const { data } = JSON.parse(res.stdout) as { data: { source: string; backup: string } };
    expect(data.source).toBe(other);
    const restored = new Database(data.backup, { readonly: true });
    expect((restored.query("SELECT count(*) c FROM runs").get() as { c: number }).c).toBe(40);
    restored.close();
  });

  test("an unwritable output directory is rejected cleanly", async () => {
    seedDb(join(home, "keelson.db"));
    // A file where the output directory would have to be.
    writeFileSync(join(home, "blocked"), "x");
    const res = await runCli(["backup", join(home, "blocked", "out.db"), "--json"], home);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout).code).toBe("BAD_INPUTS");
  });

  // A failure must not leave a truncated file at the backup name: the next run
  // would refuse to overwrite it and a sweep would read it as a valid backup.
  test("a failed vacuum publishes nothing and leaves no staging file", async () => {
    // A source that is not a database, so the vacuum fails rather than the setup.
    writeFileSync(join(home, "keelson.db"), "definitely not sqlite");
    const target = join(home, "out.db");
    const res = await runCli(["backup", target, "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(home).some((n) => n.includes(".partial-"))).toBe(false);
  });
});

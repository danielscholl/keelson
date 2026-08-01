// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

async function runCli(args: readonly string[], home: string) {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      KEELSON_HOME: home,
      KEELSON_CONFIG: join(home, "config.json"),
      // Port 1 is privileged and never bound, so the server probe is refused.
      KEELSON_SERVER_URL: "http://127.0.0.1:1",
      KEELSON_BIN_DIR: join(home, "bin"),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// A home that looks installed: the @keelson/cli dep is what distinguishes it
// from a source checkout's .keelson.
function seedHome(home: string): void {
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify({ name: "keelson-home", dependencies: { "@keelson/cli": "file:x" } }),
  );
  mkdirSync(join(home, "node_modules"), { recursive: true });
  writeFileSync(join(home, "keelson.db"), "db");
}

describe("keelson uninstall (spawned CLI)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-uninstall-cli-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // loadKeelsonConfig degrades a malformed file to {}, which would drop every
  // configured gateway from the deletion list and then destroy the home that
  // named them — exiting 0 with those secrets still in the keychain.
  test("a malformed config aborts before anything is removed", async () => {
    seedHome(home);
    writeFileSync(join(home, "config.json"), "{ not json");
    const res = await runCli(["uninstall", "--yes", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe("BAD_CONFIG");
    // Nothing removed.
    expect(existsSync(join(home, "node_modules"))).toBe(true);
    expect(existsSync(join(home, "package.json"))).toBe(true);
    expect(existsSync(join(home, "keelson.db"))).toBe(true);
  });

  test("--keep-credentials is the explicit way past a malformed config", async () => {
    seedHome(home);
    writeFileSync(join(home, "config.json"), "{ not json");
    const res = await runCli(["uninstall", "--yes", "--keep-credentials", "--json"], home);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(home, "node_modules"))).toBe(false);
    // Operator data survives a non-purge uninstall.
    expect(existsSync(join(home, "keelson.db"))).toBe(true);
  });

  test("a source checkout is refused", async () => {
    writeFileSync(join(home, "package.json"), JSON.stringify({ name: "not-a-home" }));
    mkdirSync(join(home, "node_modules"), { recursive: true });
    const res = await runCli(["uninstall", "--yes", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe("NOT_INSTALLED");
    expect(existsSync(join(home, "package.json"))).toBe(true);
    expect(existsSync(join(home, "node_modules"))).toBe(true);
  });

  // A foreign manifest is the case the guard exists for, and --purge is the
  // most destructive way in — it must not become the way around it.
  test("a source checkout is refused even with --purge", async () => {
    writeFileSync(join(home, "package.json"), JSON.stringify({ name: "not-a-home" }));
    const res = await runCli(["uninstall", "--yes", "--purge", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe("NOT_INSTALLED");
    expect(existsSync(home)).toBe(true);
  });

  test("non-interactive without --yes refuses and removes nothing", async () => {
    seedHome(home);
    const res = await runCli(["uninstall", "--json"], home);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout).code).toBe("BAD_INPUTS");
    expect(existsSync(join(home, "node_modules"))).toBe(true);
  });

  test("--purge removes the whole home", async () => {
    seedHome(home);
    const res = await runCli(
      ["uninstall", "--yes", "--purge", "--keep-credentials", "--json"],
      home,
    );
    expect(res.exitCode).toBe(0);
    expect(existsSync(home)).toBe(false);
  });

  // KEELSON_HOME is operator-supplied and --purge deletes it recursively, so a
  // directory that merely lacks a package.json must not qualify.
  test("--purge refuses a directory with no manifest and no uninstall marker", async () => {
    writeFileSync(join(home, "keelson.db"), "db");
    const res = await runCli(["uninstall", "--yes", "--purge", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe("NOT_INSTALLED");
    expect(existsSync(home)).toBe(true);
  });

  // The first run deletes the manifest that proves the home was installed, so a
  // guard keyed only on that manifest would strand an operator who decides to
  // purge after the fact. The marker the first run leaves is what carries it.
  test("--purge finishes a home a prior run already took the program files from", async () => {
    seedHome(home);
    const first = await runCli(["uninstall", "--yes", "--keep-credentials", "--json"], home);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(home, "package.json"))).toBe(false);
    expect(JSON.parse(first.stdout).data.marker).toBe(join(home, ".keelson-uninstalled"));

    const second = await runCli(
      ["uninstall", "--yes", "--purge", "--keep-credentials", "--json"],
      home,
    );
    expect(second.exitCode).toBe(0);
    expect(existsSync(home)).toBe(false);
  });

  // Without --purge there is nothing left to remove, and proceeding would only
  // revoke keychain entries the operator never asked about.
  test("a second plain run refuses instead of touching the keychain", async () => {
    seedHome(home);
    expect(
      (await runCli(["uninstall", "--yes", "--keep-credentials", "--json"], home)).exitCode,
    ).toBe(0);

    const res = await runCli(["uninstall", "--yes", "--json"], home);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.code).toBe("NOT_INSTALLED");
    expect(payload.error).toContain("--purge");
    expect(existsSync(join(home, "keelson.db"))).toBe(true);
  });
});

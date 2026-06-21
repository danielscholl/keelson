// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearServerState,
  isLoopbackUrl,
  isPidAlive,
  readServerState,
  type ServerState,
  serverStatePath,
  writeServerState,
} from "../src/server-state.ts";

const STATE: ServerState = {
  pid: 12345,
  url: "http://127.0.0.1:7878",
  startedAt: "2026-06-09T12:00:00.000Z",
  version: "0.4.0",
  schemaVersion: "1.0",
  shutdownToken: "tok-abc",
};

describe("server-state", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-server-state-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a written state", () => {
    writeServerState(STATE, home);
    expect(readServerState(home)).toEqual(STATE);
  });

  it("write is owner-only on POSIX", () => {
    if (process.platform === "win32") return;
    writeServerState(STATE, home);
    expect(statSync(serverStatePath(home)).mode & 0o777).toBe(0o600);
  });

  it("returns null when no file exists", () => {
    expect(readServerState(home)).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    writeFileSync(serverStatePath(home), "{not json");
    expect(readServerState(home)).toBeNull();
  });

  it("returns null for a payload missing required fields", () => {
    writeFileSync(serverStatePath(home), JSON.stringify({ pid: 1 }));
    expect(readServerState(home)).toBeNull();
    writeFileSync(serverStatePath(home), JSON.stringify({ ...STATE, pid: "12" }));
    expect(readServerState(home)).toBeNull();
    writeFileSync(serverStatePath(home), JSON.stringify({ ...STATE, pid: 0 }));
    expect(readServerState(home)).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    writeFileSync(
      serverStatePath(home),
      JSON.stringify({ pid: 7, url: STATE.url, shutdownToken: "t" }),
    );
    expect(readServerState(home)).toEqual({
      pid: 7,
      url: STATE.url,
      startedAt: "",
      version: "",
      schemaVersion: "",
      shutdownToken: "t",
    });
  });

  it("clearServerState removes the file and is idempotent", () => {
    writeServerState(STATE, home);
    clearServerState(home);
    expect(readServerState(home)).toBeNull();
    clearServerState(home);
  });

  it("overwrites an existing state", () => {
    writeServerState(STATE, home);
    writeServerState({ ...STATE, pid: 99 }, home);
    expect(readServerState(home)?.pid).toBe(99);
    expect(readFileSync(serverStatePath(home), "utf8")).toContain('"pid": 99');
  });

  it("isLoopbackUrl accepts loopback hosts only", () => {
    for (const url of [
      "http://127.0.0.1:7878",
      "http://localhost:7878",
      "https://127.0.0.1",
      "http://[::1]:7878",
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
    for (const url of [
      "http://10.0.0.5:7878",
      "http://example.com/api/mcp",
      "http://169.254.169.254/",
      "ftp://127.0.0.1",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });

  it("isPidAlive is true for this process and false for a long-dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // Spawn-and-reap a child so we hold a pid known to be dead.
    const proc = Bun.spawnSync(["bun", "-e", "process.exit(0)"]);
    expect(proc.success).toBe(true);
    // The reaped child's pid may be recycled in theory, but not within a test run.
    if (typeof proc.pid === "number") {
      expect(isPidAlive(proc.pid)).toBe(false);
    }
  });
});

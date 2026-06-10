// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearServerState, readServerState, writeServerState } from "@keelson/shared/server-state";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

let home: string;
let tmp: string;
let port: number;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv({
      KEELSON_HOME: home,
      KEELSON_WORKSPACE: join(tmp, "workspace"),
      KEELSON_DB: join(home, "keelson.db"),
      KEELSON_DISABLE_SCHEDULER: "1",
      KEELSON_PROVIDERS: "stub",
      PORT: String(port),
    }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function healthUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "keelson-serve-lifecycle-"));
  home = join(tmp, "keelson");
  // An ephemeral port that was free a moment ago; the server binds it for real.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port ?? 7878;
  probe.stop(true);
});

afterAll(async () => {
  // Belt and suspenders: if a test failed mid-lifecycle, don't leak the server.
  const state = readServerState(home);
  if (state) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("keelson serve start/status/stop lifecycle", () => {
  test("status before any start reports stopped with exit 3", async () => {
    const { stdout, exitCode } = await runCli(["--json", "serve", "status"]);
    expect(exitCode).toBe(3);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("stopped");
  }, 30_000);

  test("start detaches a background server and reports its URL", async () => {
    const { stdout, exitCode } = await runCli(["--json", "serve", "start"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("running");
    expect(envelope.data.url).toBe(`http://127.0.0.1:${port}`);
    expect(typeof envelope.data.pid).toBe("number");
    expect(await healthUp()).toBe(true);
    const state = readServerState(home);
    expect(state).not.toBeNull();
    expect(state?.url).toBe(`http://127.0.0.1:${port}`);
    expect(existsSync(join(home, "logs", "server.log"))).toBe(true);
  }, 60_000);

  test("start is idempotent while the server is up", async () => {
    const { stdout, exitCode } = await runCli(["--json", "serve", "start"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.status).toBe("already running");
    expect(envelope.data.url).toBe(`http://127.0.0.1:${port}`);
  }, 30_000);

  test("status reports running with url, pid, and uptime", async () => {
    const { stdout, exitCode } = await runCli(["--json", "serve", "status"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.status).toBe("running");
    expect(envelope.data.url).toBe(`http://127.0.0.1:${port}`);
    expect(typeof envelope.data.pid).toBe("number");
    expect(typeof envelope.data.schemaVersion).toBe("string");
  }, 30_000);

  test("stop shuts the server down and clears the state file", async () => {
    const before = readServerState(home);
    expect(before).not.toBeNull();
    const { stdout, exitCode } = await runCli(["--json", "serve", "stop"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.status).toBe("stopped");
    expect(envelope.data.pid).toBe(before?.pid);
    expect(readServerState(home)).toBeNull();
    expect(await healthUp()).toBe(false);
  }, 60_000);

  test("stop is idempotent once the server is down", async () => {
    const { stdout, exitCode } = await runCli(["--json", "serve", "stop"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.status).toBe("not running");
  }, 30_000);

  test("stop refuses to signal a live pid whose recorded URL is silent", async () => {
    // A crash + pid recycling leaves server.json naming a live pid that is NOT
    // a keelson server. This test process plays the innocent pid; stop must
    // refuse rather than SIGTERM it.
    writeServerState(
      {
        pid: process.pid,
        url: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
        version: "0.0.0",
        schemaVersion: "test",
        shutdownToken: "recycled-pid-token",
      },
      home,
    );
    try {
      const { stdout, exitCode } = await runCli(["--json", "serve", "stop"]);
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("STALE_STATE");
    } finally {
      clearServerState(home);
    }
  }, 30_000);

  test("stop refuses the signal fallback when the responding server rejects the token", async () => {
    // A server that answers health at the recorded URL but rejects the token
    // is someone else's (different home). Stop must not fall through to
    // signaling the recorded pid.
    const foreign = Bun.serve({
      port,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/health") {
          return Response.json({ ok: true, name: "keelson", schema_version: "test" });
        }
        return new Response("nope", { status: 401 });
      },
    });
    writeServerState(
      {
        pid: process.pid,
        url: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
        version: "0.0.0",
        schemaVersion: "test",
        shutdownToken: "not-their-token",
      },
      home,
    );
    try {
      const { stdout, exitCode } = await runCli(["--json", "serve", "stop"]);
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("UNMANAGED");
    } finally {
      foreign.stop(true);
      clearServerState(home);
    }
  }, 30_000);
});

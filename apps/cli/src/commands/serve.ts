// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveUntilSignal } from "@keelson/server";
import { ensureSpawnPath } from "@keelson/shared/exec";
import {
  clearServerState,
  isLoopbackUrl,
  isPidAlive,
  readServerState,
  type ServerState,
  serverStatePath,
} from "@keelson/shared/server-state";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_OK } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";
import { defaultServerBaseUrl, probeServer, type ServerInfo } from "../server-probe.ts";

export interface ServeOptions {
  db?: string;
  json: boolean;
}

// Run the server in-process and block until a termination signal. serveUntilSignal
// builds the database/ribs/routes, installs the SIGINT/SIGTERM/SIGHUP →
// graceful-shutdown handlers, and never returns (it process.exits on signal).
export async function runServe(opts: ServeOptions): Promise<never> {
  try {
    return await serveUntilSignal({
      ...(opts.db ? { dbPath: opts.db } : {}),
      version: pkg.version,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failed to start server: ${msg}\n`);
    process.exit(EXIT_FAIL);
  }
}

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 250;
const STATUS_PROBE_TIMEOUT_MS = 1_000;

// Where `start` binds the server it launches: the server reads only `PORT`
// (it never consults KEELSON_SERVER_URL), so the boot poll must watch this URL.
function launchBaseUrl(): string {
  return `http://127.0.0.1:${Number(process.env.PORT ?? 7878)}`;
}

// Where the control-plane commands probe. `KEELSON_SERVER_URL` wins so
// stop/status reach the same server every data-plane command targets; absent
// it, fall back to the PORT-keyed launch URL so a `PORT`-only setup still works.
function probeBaseUrl(): string {
  return process.env.KEELSON_SERVER_URL?.trim() ? defaultServerBaseUrl() : launchBaseUrl();
}

function logPath(home: string): string {
  return join(home, "logs", "server.log");
}

function logTail(path: string, lines = 15): string | null {
  try {
    const content = readFileSync(path, "utf8").trimEnd();
    if (!content) return null;
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
}

function uptimeSince(startedAt: string): string | null {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  let seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Probe the recorded URL first (covers a server started with a custom PORT),
// then the conventional one.
async function probeKnown(
  state: ServerState | null,
  timeoutMs: number,
): Promise<ServerInfo | null> {
  if (state && isLoopbackUrl(state.url)) {
    const found = await probeServer({ baseUrl: state.url, timeoutMs });
    if (found) return found;
  }
  const fallback = probeBaseUrl();
  if (!state || state.url !== fallback) {
    return probeServer({ baseUrl: fallback, timeoutMs });
  }
  return null;
}

export async function runServeStart(opts: ServeOptions): Promise<void> {
  const home = resolveKeelsonHome();
  const state = readServerState(home);
  const running = await probeKnown(state, STATUS_PROBE_TIMEOUT_MS);
  if (running) {
    emit(
      {
        data: {
          status: "already running",
          url: running.baseUrl,
          ...(state && isPidAlive(state.pid) ? { pid: state.pid } : {}),
        },
      },
      opts,
    );
    process.exit(EXIT_OK);
  }
  if (state && isPidAlive(state.pid)) {
    emit(
      {
        error: `a process with pid ${state.pid} is alive but not responding at ${state.url} — it may still be booting (check \`keelson status\` or ${logPath(home)}); if it is not a keelson server (stale record after a crash), delete ${serverStatePath(home)} and retry`,
        code: "UNRESPONSIVE",
      },
      opts,
    );
    process.exit(EXIT_FAIL);
  }

  const log = logPath(home);
  mkdirSync(join(home, "logs"), { recursive: true });
  // Keep one previous generation for post-mortems; the live file starts fresh.
  try {
    renameSync(log, `${log}.old`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fd = openSync(log, "a");

  // Re-exec this same CLI entry (dev: bin/keelson.ts, installed: dist/keelson.js)
  // as a detached session so the server outlives this process and its terminal.
  const child = spawn(
    process.execPath,
    [
      resolve(process.argv[1] ?? ""),
      "start",
      "--foreground",
      ...(opts.db ? ["--db", opts.db] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: ensureSpawnPath({
        ...process.env,
        KEELSON_HOME: home,
        KEELSON_SERVE_BACKGROUND: "1",
      } as Record<string, string>),
    },
  );
  closeSync(fd);
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const tail = logTail(log);
      emit(
        {
          error: `server exited during startup (code ${child.exitCode ?? child.signalCode})${tail ? `\n${tail}` : ""}`,
          code: "START_FAILED",
        },
        opts,
      );
      process.exit(EXIT_FAIL);
    }
    // A refused connection fails instantly, so boot polling stays on the 250ms
    // cadence; the longer timeout only matters once the port is bound and the
    // health route is slow to answer (loaded machine mid-bootstrap).
    const info = await probeServer({
      baseUrl: launchBaseUrl(),
      timeoutMs: STATUS_PROBE_TIMEOUT_MS,
    });
    if (info) {
      emit(
        {
          data: {
            status: "running",
            url: info.baseUrl,
            pid: child.pid,
            log,
          },
        },
        opts,
      );
      process.exit(EXIT_OK);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  const tail = logTail(log);
  emit(
    {
      error: `server did not respond within ${START_TIMEOUT_MS / 1000}s${tail ? `\n${tail}` : ""}`,
      code: "START_TIMEOUT",
    },
    opts,
  );
  process.exit(EXIT_FAIL);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return !isPidAlive(pid);
}

async function requestGracefulShutdown(state: ServerState): Promise<boolean> {
  if (!isLoopbackUrl(state.url)) return false;
  try {
    const res = await fetch(`${state.url}/api/server/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.shutdownToken}` },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runServeStop(opts: { json: boolean }): Promise<void> {
  const home = resolveKeelsonHome();
  const state = readServerState(home);
  const running = await probeKnown(state, STATUS_PROBE_TIMEOUT_MS);

  if (!state) {
    if (running) {
      emit(
        {
          error: `a server is responding at ${running.baseUrl} but ${home}/server.json does not exist — it was started from a different home (or an older keelson); stop it where it was started`,
          code: "UNMANAGED",
        },
        opts,
      );
      process.exit(EXIT_FAIL);
    }
    emit({ data: { status: "not running" } }, opts);
    process.exit(EXIT_OK);
  }

  // Identity gate: the recorded pid is only trustworthy while the server it
  // names answers at the recorded URL. A pid alone is never proof — the OS
  // recycles pids (quickly on Windows), so signaling on pid liveness alone
  // could kill an unrelated process that inherited the number after a crash.
  const respondingAtRecorded = running !== null && running.baseUrl === state.url;

  if (!respondingAtRecorded && !isPidAlive(state.pid)) {
    clearServerState(home);
    emit({ data: { status: "not running", note: "cleaned up stale server.json" } }, opts);
    process.exit(EXIT_OK);
  }

  if (!respondingAtRecorded) {
    emit(
      {
        error: `a process with pid ${state.pid} is alive but nothing responds at ${state.url}; refusing to signal a possibly recycled pid — if it is a hung keelson server, kill it manually and delete ${serverStatePath(home)}`,
        code: "STALE_STATE",
      },
      opts,
    );
    process.exit(EXIT_FAIL);
  }

  // Graceful first: the token-gated shutdown route drains runs and closes the
  // DB on every platform. An accepted token also confirms identity — the
  // responding server read this home's server.json, so the recorded pid is its
  // own and the signal fallback below is safe.
  const graceful = await requestGracefulShutdown(state);
  if (!graceful) {
    emit(
      {
        error: `a server responds at ${state.url} but did not accept the recorded shutdown token — it was started from a different home (or an older keelson); stop it where it was started`,
        code: "UNMANAGED",
      },
      opts,
    );
    process.exit(EXIT_FAIL);
  }

  let exited = await waitForExit(state.pid, STOP_TIMEOUT_MS);
  if (!exited && isPidAlive(state.pid)) {
    // Signals are the fallback for a drain that hangs (on Windows process.kill
    // is a hard TerminateProcess — the DB is WAL, so still crash-safe).
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Already gone between the liveness check and the kill.
    }
    exited = await waitForExit(state.pid, STOP_TIMEOUT_MS);
    if (!exited) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      exited = await waitForExit(state.pid, 2_000);
    }
  }

  if (!exited) {
    emit(
      {
        error: `server process (pid ${state.pid}) did not exit; kill it manually`,
        code: "STOP_FAILED",
      },
      opts,
    );
    process.exit(EXIT_FAIL);
  }

  clearServerState(home);
  emit({ data: { status: "stopped", pid: state.pid } }, opts);
  process.exit(EXIT_OK);
}

export async function runServeStatus(opts: { json: boolean }): Promise<void> {
  const home = resolveKeelsonHome();
  const state = readServerState(home);
  const info = await probeKnown(state, STATUS_PROBE_TIMEOUT_MS);
  const log = existsSync(logPath(home)) ? logPath(home) : undefined;

  if (info) {
    const owned = state !== null && isPidAlive(state.pid);
    const uptime = owned && state.startedAt ? uptimeSince(state.startedAt) : null;
    // Reflect what the RUNNING server actually mounted, not local config (which
    // may differ from the env the server was started with). A 404 means the MCP
    // route isn't mounted; any other status (405, or 401 when token-gated) means
    // it's live.
    const mcpUrl = `${info.baseUrl}/api/mcp`;
    let mcpMounted = false;
    try {
      const probe = await fetch(mcpUrl, {
        method: "GET",
        signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
      });
      mcpMounted = probe.status !== 404;
    } catch {
      mcpMounted = false;
    }
    emit(
      {
        data: {
          status: "running",
          url: info.baseUrl,
          ...(mcpMounted ? { mcpUrl } : {}),
          ...(owned ? { pid: state.pid } : {}),
          ...(uptime ? { uptime } : {}),
          ...(owned && state.version ? { version: state.version } : {}),
          schemaVersion: info.schemaVersion,
          ...(log ? { log } : {}),
        },
      },
      opts,
    );
    process.exit(EXIT_OK);
  }

  if (state && isPidAlive(state.pid)) {
    emit(
      {
        error: `server process (pid ${state.pid}) is running but not responding at ${state.url}${log ? `; check ${log}` : ""}`,
        code: "UNRESPONSIVE",
      },
      opts,
    );
    process.exit(EXIT_FAIL);
  }

  emit(
    {
      data: {
        status: "stopped",
        ...(state ? { note: `stale server.json (pid ${state.pid} is not running)` } : {}),
        hint: "run `keelson start`",
      },
    },
    opts,
  );
  process.exit(EXIT_NO_SERVER);
}

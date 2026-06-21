// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveKeelsonHome } from "./paths.ts";

// On-disk record of the running server process: written by the server once its
// listener is up, removed on graceful shutdown. `keelson status`/`stop`
// read it to find the pid, URL, and shutdown token. The token gates
// POST /api/server/shutdown so only a caller that can read the home directory
// (the operator's CLI, not a browser page) can stop the server.
export interface ServerState {
  readonly pid: number;
  readonly url: string;
  readonly startedAt: string;
  readonly version: string;
  readonly schemaVersion: string;
  readonly shutdownToken: string;
  // Present only when the MCP gateway is token-gated (config.mcp.requireToken).
  // Gates the /mcp endpoint, separate from shutdownToken so a leaked MCP token
  // can't also stop the server.
  readonly mcpToken?: string;
}

export function serverStatePath(home: string = resolveKeelsonHome()): string {
  return join(home, "server.json");
}

// The server binds loopback only (apps/server hard-codes 127.0.0.1), so a URL
// recorded in server.json must resolve to a loopback host. CLI commands run this
// guard before using the recorded URL as a fetch target, so a tampered or stale
// server.json can't redirect a request — or the MCP token paired with it — to an
// off-box host.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // WHATWG URL returns IPv6 hostnames bracketed (e.g. "[::1]"); strip them.
  return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ""));
}

export function writeServerState(state: ServerState, home: string = resolveKeelsonHome()): void {
  const path = serverStatePath(home);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  // The file carries the shutdown token; keep it owner-only where modes exist.
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function readServerState(home: string = resolveKeelsonHome()): ServerState | null {
  const path = serverStatePath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerState>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.url !== "string" || raw.url.length === 0) return null;
    if (typeof raw.shutdownToken !== "string") return null;
    return {
      pid: raw.pid,
      url: raw.url,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      version: typeof raw.version === "string" ? raw.version : "",
      schemaVersion: typeof raw.schemaVersion === "string" ? raw.schemaVersion : "",
      shutdownToken: raw.shutdownToken,
      ...(typeof raw.mcpToken === "string" ? { mcpToken: raw.mcpToken } : {}),
    };
  } catch {
    return null;
  }
}

export function clearServerState(home: string = resolveKeelsonHome()): void {
  rmSync(serverStatePath(home), { force: true });
}

// Signal 0 checks existence/permission without delivering anything. EPERM
// means the pid exists but belongs to another user — alive for our purposes.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

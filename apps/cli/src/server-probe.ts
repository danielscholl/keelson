// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:7878";
export const DEFAULT_PROBE_TIMEOUT_MS = 250;

export interface ServerInfo {
  baseUrl: string;
  name: string;
  phase: number;
  schemaVersion: string;
}

export interface ProbeOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

interface HealthPayload {
  ok?: unknown;
  name?: unknown;
  phase?: unknown;
  schema_version?: unknown;
}

function parseHealth(baseUrl: string, payload: HealthPayload): ServerInfo | null {
  if (payload.ok !== true) return null;
  if (typeof payload.name !== "string") return null;
  if (typeof payload.phase !== "number") return null;
  if (typeof payload.schema_version !== "string") return null;
  return {
    baseUrl,
    name: payload.name,
    phase: payload.phase,
    schemaVersion: payload.schema_version,
  };
}

export async function probeServer(opts: ProbeOptions = {}): Promise<ServerInfo | null> {
  const rawBaseUrl = opts.baseUrl ?? DEFAULT_SERVER_BASE_URL;
  // Strip trailing slashes so callers can pass `http://host:port` or
  // `http://host:port/` interchangeably without producing `//api/health`
  // (which Hono won't match).
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as HealthPayload;
    return parseHealth(baseUrl, payload);
  } catch {
    // Timeout, refused connection, JSON parse failure, network unreachable —
    // every "server isn't there" signal collapses to the same null result so
    // every downstream command can branch on a simple `probeServer() ?? …`.
    return null;
  }
}

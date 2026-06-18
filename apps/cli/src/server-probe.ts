// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:7878";
export const DEFAULT_PROBE_TIMEOUT_MS = 250;

// The base URL CLI commands probe when none is passed explicitly via
// `--base-url`. `KEELSON_SERVER_URL` overrides the loopback default so the CLI
// can target a server on a non-default host/port without repeating `--base-url`
// on every command; unset leaves the default unchanged. Deliberately not keyed
// off `PORT` — that var is commonly set for unrelated reasons and would
// misdirect the client probe. An invalid override throws so the misconfiguration
// surfaces immediately rather than silently appearing as "server down".
export function defaultServerBaseUrl(): string {
  const override = process.env.KEELSON_SERVER_URL?.trim();
  if (!override) return DEFAULT_SERVER_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(
      `KEELSON_SERVER_URL is not a valid URL: "${override}" (expected e.g. http://127.0.0.1:7878)`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `KEELSON_SERVER_URL is not a valid URL: "${override}" (expected e.g. http://127.0.0.1:7878)`,
    );
  }
  return override;
}

export interface ServerInfo {
  baseUrl: string;
  name: string;
  phase?: number;
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
  if (typeof payload.schema_version !== "string") return null;
  return {
    baseUrl,
    name: payload.name,
    // `phase` is optional: the health route stopped emitting it, so requiring
    // it here made every probe fail (server seen as down while actually up).
    ...(typeof payload.phase === "number" ? { phase: payload.phase } : {}),
    schemaVersion: payload.schema_version,
  };
}

export async function probeServer(opts: ProbeOptions = {}): Promise<ServerInfo | null> {
  const rawBaseUrl = opts.baseUrl ?? defaultServerBaseUrl();
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

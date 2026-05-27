// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Server-wide cross-cutting types. CORS origin check + the discriminated
// per-socket data type live here so any handler can import them without
// reaching into a sibling handler's module.

// Any port allowed because Vite shifts to 5174/5175/… when 5173 is busy;
// hard-coding the dev port breaks /api/db/reset etc. in that case.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!origin.startsWith("http://")) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(url.hostname);
}

// Discriminated by `kind` so the single Bun.serve `websocket` field can
// route chat, workflow-run, and snapshot frames.
export interface WsData {
  abort: AbortController;
  kind?: "chat" | "workflowRun" | "snapshot";
  // Set on workflowRun upgrades so the per-runId subscriber set can be looked
  // up at message/close time.
  runId?: string;
  // Set on snapshot upgrades so the per-key subscriber set can be looked up
  // at message/close time.
  snapshotKey?: string;
}

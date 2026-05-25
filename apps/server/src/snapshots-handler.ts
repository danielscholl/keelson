// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotManager } from "@keelson/shared";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { isAllowedOrigin, type WsData } from "./chat-handler.ts";
import type { SnapshotSubscribers } from "./snapshot-subscribers.ts";

export interface SnapshotsRoutesDeps {
  manager: SnapshotManager;
  subscribers: SnapshotSubscribers;
}

export function snapshotsRoutes(app: Hono, deps: SnapshotsRoutesDeps): void {
  const { manager } = deps;

  // Index endpoint — names of every registered snapshot key. Lightweight by
  // design (no payload values) so a polling /api/snapshots UI doesn't pay the
  // serialization cost of every cached frame.
  app.get("/api/snapshots", (c) => {
    return c.json({ keys: manager.keys() });
  });

  // Latest cached frame for a key. 404 distinguishes "never composed" from
  // "registered but stale" — both surface as undefined here because v0.2
  // doesn't lazy-compose on read (deterministic by design).
  app.get("/api/snapshots/:key", (c) => {
    const key = c.req.param("key");
    const frame = manager.latest(key);
    if (!frame) {
      return c.json({ error: "snapshot not found" }, 404);
    }
    return c.json(frame);
  });
}

// WS upgrade. Mirrors handleWorkflowRunUpgrade — origin-gated against the
// loopback allow-list so a malicious page can't open a socket to read another
// process's snapshots. The key is not validated against the manager here; a
// client that subscribes to an unregistered key simply receives no frames
// until something registers it (or the socket times out via idleTimeout).
export function handleSnapshotUpgrade(
  req: Request,
  server: Server<WsData>,
  snapshotKey: string,
): Response | undefined {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const data: WsData = {
    abort: new AbortController(),
    kind: "snapshot",
    snapshotKey,
  };
  const ok = server.upgrade(req, { data });
  if (ok) return undefined;
  return new Response("expected websocket", { status: 426 });
}

export function snapshotWebSocketHandlers(deps: {
  subscribers: SnapshotSubscribers;
  manager: SnapshotManager;
}): WebSocketHandler<WsData> {
  const { subscribers, manager } = deps;
  return {
    open(ws: ServerWebSocket<WsData>) {
      const key = ws.data.snapshotKey;
      if (!key) return;
      subscribers.subscribe(key, ws);
      // No on-connect replay frame: clients are expected to GET
      // `/api/snapshots/:key` to hydrate, then subscribe for live updates.
      // This mirrors the workflow-run REST-then-WS pattern in
      // apps/web/src/hooks/useWorkflowRun.ts. Sending the cached frame here
      // anyway is harmless (clients dedupe by `version`) so future work may
      // add it as a "warm start" optimization — leaving it off for v0.2
      // keeps the wire shape minimal and deterministic.
      void manager;
    },
    message() {
      // Snapshot WS is pure-broadcast; clients don't send frames. Ignore.
    },
    close(ws: ServerWebSocket<WsData>) {
      const key = ws.data.snapshotKey;
      if (!key) return;
      subscribers.unsubscribe(key, ws);
    },
  };
}

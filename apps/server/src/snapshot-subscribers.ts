// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotFrame } from "@keelson/shared";
import type { ServerWebSocket } from "bun";
import type { WsData } from "./chat-handler.ts";

// Per-key snapshot WS subscriber manager. Parallel to WorkflowSubscriberRegistry
// (workflows-handler.ts) but keyed by snapshotKey instead of runId and without
// Zod parse on the broadcast hot path — SnapshotManager owns the wire shape
// (its own recompose constructs the frame) so revalidation per fan-out would
// be redundant.
export interface SnapshotSubscribers {
  subscribe(key: string, ws: ServerWebSocket<WsData>): void;
  unsubscribe(key: string, ws: ServerWebSocket<WsData>): void;
  broadcast(key: string, frame: SnapshotFrame): void;
  hasKey(key: string): boolean;
  closeKey(key: string, code?: number, reason?: string): void;
  closeAll(code?: number, reason?: string): void;
}

class SnapshotSubscriberRegistry implements SnapshotSubscribers {
  private readonly subscribers = new Map<string, Set<ServerWebSocket<WsData>>>();

  subscribe(key: string, ws: ServerWebSocket<WsData>): void {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(ws);
  }

  unsubscribe(key: string, ws: ServerWebSocket<WsData>): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.subscribers.delete(key);
  }

  broadcast(key: string, frame: SnapshotFrame): void {
    const set = this.subscribers.get(key);
    if (!set || set.size === 0) return;
    const json = JSON.stringify(frame);
    for (const ws of set) {
      try {
        ws.send(json);
      } catch {
        // socket closed mid-send; close handler will drain it
      }
    }
  }

  hasKey(key: string): boolean {
    return this.subscribers.has(key);
  }

  closeKey(key: string, code = 1000, reason = "snapshot key closed"): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const ws of set) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.subscribers.delete(key);
  }

  closeAll(code = 1000, reason = "server shutting down"): void {
    for (const key of Array.from(this.subscribers.keys())) {
      this.closeKey(key, code, reason);
    }
  }
}

export function createSnapshotSubscribers(): SnapshotSubscribers {
  return new SnapshotSubscriberRegistry();
}

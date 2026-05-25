// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotComposer, SnapshotFrame, SnapshotManager } from "@keelson/shared";
import { createSnapshotSubscribers, type SnapshotSubscribers } from "./snapshot-subscribers.ts";

class SnapshotManagerImpl implements SnapshotManager {
  private readonly composers = new Map<string, SnapshotComposer<unknown>>();
  private readonly cache = new Map<string, SnapshotFrame<unknown>>();
  private readonly versions = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<SnapshotFrame<unknown> | undefined>>();
  private disposed = false;

  constructor(private readonly subscribers: SnapshotSubscribers) {}

  register<T>(key: string, compose: SnapshotComposer<T>): () => void {
    if (this.disposed) throw new Error("SnapshotManager has been disposed");
    if (!key) throw new Error("snapshot key must be a non-empty string");
    if (this.composers.has(key)) {
      throw new Error(`snapshot key '${key}' is already registered`);
    }
    const erased = compose as SnapshotComposer<unknown>;
    this.composers.set(key, erased);
    return () => {
      // Identity check guards against double-unregister and against a stale
      // handle calling after the key was re-registered with a new composer.
      if (this.composers.get(key) === erased) {
        this.composers.delete(key);
        this.cache.delete(key);
        this.versions.delete(key);
        this.subscribers.closeKey(key, 1000, "snapshot key unregistered");
      }
    };
  }

  async recompose<T = unknown>(key: string): Promise<SnapshotFrame<T> | undefined> {
    if (this.disposed) return undefined;
    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight as Promise<SnapshotFrame<T> | undefined>;
    }
    const compose = this.composers.get(key);
    if (!compose) return undefined;
    const promise = (async (): Promise<SnapshotFrame<unknown> | undefined> => {
      try {
        const data = await compose();
        const nextVersion = (this.versions.get(key) ?? -1) + 1;
        const frame: SnapshotFrame<unknown> = {
          type: "snapshot_update",
          key,
          version: nextVersion,
          composedAt: new Date().toISOString(),
          data,
        };
        this.versions.set(key, nextVersion);
        this.cache.set(key, frame);
        this.subscribers.broadcast(key, frame);
        return frame;
      } catch (err) {
        // Compose failures don't poison the cache — `latest` keeps the prior
        // value. Future recompose attempts run again. Failures surface as a
        // single console.warn line rather than an emitted error frame.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[snapshots] compose '${key}' failed: ${msg}`);
        return undefined;
      }
    })();
    this.inflight.set(key, promise);
    // The cleanup is registered AFTER inflight.set so it can't race a
    // synchronously-throwing composer: a sync throw settles `promise` before
    // we even reach this line, but `.finally` still schedules its callback on
    // the microtask queue — which always runs after the synchronous setter
    // here. Putting the delete inside the IIFE's own try/finally would let it
    // execute before `inflight.set`, stranding a stale resolved promise.
    promise.finally(() => {
      // Identity guard so a re-register's fresh inflight isn't clobbered by
      // the previous registration's late cleanup.
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    });
    return promise as Promise<SnapshotFrame<T> | undefined>;
  }

  latest<T = unknown>(key: string): SnapshotFrame<T> | undefined {
    return this.cache.get(key) as SnapshotFrame<T> | undefined;
  }

  keys(): string[] {
    return Array.from(this.composers.keys());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Drain in-flight composes so a broadcast doesn't race the close.
    await Promise.allSettled(Array.from(this.inflight.values()));
    this.composers.clear();
    this.cache.clear();
    this.versions.clear();
    this.subscribers.closeAll(1000, "server shutting down");
  }
}

export function createSnapshotManager(subscribers?: SnapshotSubscribers): SnapshotManager {
  return new SnapshotManagerImpl(subscribers ?? createSnapshotSubscribers());
}

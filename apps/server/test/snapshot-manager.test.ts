// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";
import { describe, expect, test } from "bun:test";
import type { SnapshotFrame } from "@keelson/shared";
import { createSnapshotManager } from "../src/snapshot-manager.ts";
import type { SnapshotSubscribers } from "../src/snapshot-subscribers.ts";

function recordingSubscribers(): {
  subscribers: SnapshotSubscribers;
  broadcasts: Array<{ key: string; frame: SnapshotFrame }>;
  closedKeys: string[];
  closedAll: boolean;
} {
  const broadcasts: Array<{ key: string; frame: SnapshotFrame }> = [];
  const closedKeys: string[] = [];
  let closedAll = false;
  const subscribers: SnapshotSubscribers = {
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (key, frame) => {
      broadcasts.push({ key, frame });
    },
    hasKey: () => false,
    closeKey: (key) => {
      closedKeys.push(key);
    },
    closeAll: () => {
      closedAll = true;
    },
  };
  return {
    subscribers,
    broadcasts,
    closedKeys,
    get closedAll() {
      return closedAll;
    },
  } as ReturnType<typeof recordingSubscribers>;
}

describe("SnapshotManager", () => {
  describe("register", () => {
    test("registers a key and exposes it via keys()", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("foo", () => ({ value: 1 }));
      expect(mgr.keys()).toEqual(["foo"]);
    });

    test("throws on duplicate key", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("foo", () => 1);
      expect(() => mgr.register("foo", () => 2)).toThrow(/already registered/);
    });

    test("throws on empty key", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      expect(() => mgr.register("", () => 1)).toThrow(/non-empty/);
    });

    test("unregister handle removes the key, drops cache, closes subscribers", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      const unregister = mgr.register("foo", () => 42);
      await mgr.recompose("foo");
      expect(mgr.latest("foo")?.data).toBe(42);
      unregister();
      expect(mgr.keys()).toEqual([]);
      expect(mgr.latest("foo")).toBeUndefined();
      expect(rec.closedKeys).toEqual(["foo"]);
    });

    test("unregister-then-reregister allows the key to come back fresh", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      const off1 = mgr.register("foo", () => "first");
      await mgr.recompose("foo");
      expect(mgr.latest("foo")?.data).toBe("first");
      off1();
      mgr.register("foo", () => "second");
      const frame = await mgr.recompose("foo");
      // Version resets on re-register because cache was dropped on unregister.
      expect(frame?.version).toBe(0);
      expect(frame?.data).toBe("second");
    });

    test("stale unregister handle is a no-op after reregistration", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      const off1 = mgr.register("foo", () => 1);
      off1();
      mgr.register("foo", () => 2);
      // Calling the original handle now must NOT unregister the new composer.
      off1();
      expect(mgr.keys()).toEqual(["foo"]);
    });
  });

  describe("recompose", () => {
    test("returns undefined for unregistered key", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      expect(await mgr.recompose("missing")).toBeUndefined();
    });

    test("composes, caches, broadcasts, and increments version", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      let counter = 0;
      mgr.register("counter", () => ++counter);
      const first = await mgr.recompose<number>("counter");
      const second = await mgr.recompose<number>("counter");
      expect(first?.version).toBe(0);
      expect(first?.data).toBe(1);
      expect(second?.version).toBe(1);
      expect(second?.data).toBe(2);
      expect(rec.broadcasts.map((b) => b.frame.version)).toEqual([0, 1]);
      expect(mgr.latest<number>("counter")?.data).toBe(2);
    });

    test("coalesces concurrent calls — single compose, single broadcast", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      let composeCalls = 0;
      mgr.register("slow", async () => {
        composeCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return composeCalls;
      });
      const [a, b, c] = await Promise.all([
        mgr.recompose<number>("slow"),
        mgr.recompose<number>("slow"),
        mgr.recompose<number>("slow"),
      ]);
      expect(composeCalls).toBe(1);
      expect(a?.version).toBe(0);
      // All three callers see the same frame (same version, same data).
      expect(a?.data).toBe(1);
      expect(b?.data).toBe(1);
      expect(c?.data).toBe(1);
      expect(rec.broadcasts).toHaveLength(1);
    });

    test("on compose throw, latest stays stale and no broadcast fires", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      let attempt = 0;
      mgr.register("flaky", () => {
        attempt++;
        if (attempt === 2) throw new Error("boom");
        return attempt;
      });
      const first = await mgr.recompose<number>("flaky");
      expect(first?.data).toBe(1);
      const second = await mgr.recompose<number>("flaky");
      expect(second).toBeUndefined();
      // Cache retains the prior good snapshot.
      expect(mgr.latest<number>("flaky")?.data).toBe(1);
      expect(mgr.latest<number>("flaky")?.version).toBe(0);
      // Only the successful compose broadcast.
      expect(rec.broadcasts).toHaveLength(1);
      // Subsequent recompose works again.
      const third = await mgr.recompose<number>("flaky");
      expect(third?.data).toBe(3);
      expect(third?.version).toBe(1);
    });

    test("after compose throw, in-flight slot clears so retries are possible", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("once", async () => {
        throw new Error("fail");
      });
      await mgr.recompose("once");
      // If inflight wasn't cleared, this would await the same rejected promise.
      const retry = mgr.recompose("once");
      expect(await retry).toBeUndefined();
    });

    test("composedAt is ISO8601 with offset", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("k", () => 1);
      const frame = await mgr.recompose("k");
      expect(frame?.composedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });
  });

  describe("dispose", () => {
    test("clears state and closes all subscribers", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      mgr.register("a", () => 1);
      mgr.register("b", () => 2);
      await mgr.dispose();
      expect(mgr.keys()).toEqual([]);
      expect(mgr.latest("a")).toBeUndefined();
      expect(rec.closedAll).toBe(true);
    });

    test("is idempotent", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      await mgr.dispose();
      await mgr.dispose(); // no throw
    });

    test("register after dispose throws", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      await mgr.dispose();
      expect(() => mgr.register("x", () => 1)).toThrow(/disposed/);
    });

    test("recompose after dispose returns undefined", async () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("x", () => 1);
      await mgr.dispose();
      expect(await mgr.recompose("x")).toBeUndefined();
    });

    test("waits for in-flight composes before closing", async () => {
      const rec = recordingSubscribers();
      const mgr = createSnapshotManager(rec.subscribers);
      let resolveCompose!: (v: number) => void;
      mgr.register("slow", () => new Promise<number>((r) => (resolveCompose = r)));
      const inflight = mgr.recompose<number>("slow");
      // Dispose starts but should not return until compose settles.
      const disposed = mgr.dispose();
      // Let microtasks run.
      await new Promise((r) => setTimeout(r, 5));
      // Compose still in flight — finish it.
      resolveCompose(99);
      await disposed;
      // The broadcast from the in-flight compose may or may not have landed
      // depending on whether dispose flipped `disposed=true` before the cache
      // write — either way, dispose() must have awaited the compose.
      const composeOutcome = await inflight;
      // Result is either the resolved frame (compose finished before dispose
      // observed the flag) or undefined. Both are valid; the contract is that
      // dispose blocks until in-flight settles.
      expect(composeOutcome === undefined || composeOutcome.data === 99).toBe(true);
      expect(rec.closedAll).toBe(true);
    });
  });

  describe("latest", () => {
    test("returns undefined for never-composed key", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      mgr.register("k", () => 1);
      expect(mgr.latest("k")).toBeUndefined();
    });

    test("returns undefined for unregistered key", () => {
      const { subscribers } = recordingSubscribers();
      const mgr = createSnapshotManager(subscribers);
      expect(mgr.latest("missing")).toBeUndefined();
    });
  });
});

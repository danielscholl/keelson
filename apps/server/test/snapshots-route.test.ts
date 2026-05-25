// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSnapshotManager } from "../src/snapshot-manager.ts";
import { createSnapshotSubscribers } from "../src/snapshot-subscribers.ts";
import {
  handleSnapshotUpgrade,
  snapshotsRoutes,
  snapshotWebSocketHandlers,
} from "../src/snapshots-handler.ts";

const ORIGIN = "http://127.0.0.1:5173";

function makeRig() {
  const subscribers = createSnapshotSubscribers();
  const manager = createSnapshotManager(subscribers);
  const app = new Hono();
  snapshotsRoutes(app, { manager, subscribers });
  return { app, manager, subscribers };
}

describe("snapshots REST", () => {
  test("GET /api/snapshots returns an empty key list when nothing is registered", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/snapshots"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [] });
  });

  test("GET /api/snapshots lists registered keys", async () => {
    const { app, manager } = makeRig();
    manager.register("alpha", () => 1);
    manager.register("beta", () => 2);
    const res = await app.fetch(new Request("http://test/api/snapshots"));
    expect(((await res.json()) as { keys: string[] }).keys.sort()).toEqual(["alpha", "beta"]);
  });

  test("GET /api/snapshots/:key 404s when key has never been composed", async () => {
    const { app, manager } = makeRig();
    manager.register("k", () => 1);
    const res = await app.fetch(new Request("http://test/api/snapshots/k"));
    expect(res.status).toBe(404);
  });

  test("GET /api/snapshots/:key returns the latest cached frame after recompose", async () => {
    const { app, manager } = makeRig();
    manager.register("partitions", () => ({ ids: ["alpha", "beta"] }));
    await manager.recompose("partitions");
    const res = await app.fetch(new Request("http://test/api/snapshots/partitions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      key: string;
      version: number;
      data: { ids: string[] };
    };
    expect(body.type).toBe("snapshot_update");
    expect(body.key).toBe("partitions");
    expect(body.version).toBe(0);
    expect(body.data).toEqual({ ids: ["alpha", "beta"] });
  });

  test("GET /api/snapshots/:key 404s for an unregistered key", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/snapshots/missing"));
    expect(res.status).toBe(404);
  });
});

describe("snapshots WS", () => {
  test("upgrade rejects a non-loopback origin with 403", () => {
    // server.upgrade is not invoked because origin gating fires first.
    const fakeServer = {
      upgrade: () => {
        throw new Error("origin gate should have rejected before upgrade");
      },
    } as unknown as Parameters<typeof handleSnapshotUpgrade>[1];
    const res = handleSnapshotUpgrade(
      new Request("http://127.0.0.1:7878/api/snapshots/foo/ws", {
        headers: { origin: "https://evil.example.com" },
      }),
      fakeServer,
      "foo",
    );
    expect(res?.status).toBe(403);
  });

  test("upgrade rejects a missing origin with 403", () => {
    const fakeServer = {
      upgrade: () => {
        throw new Error("origin gate should have rejected before upgrade");
      },
    } as unknown as Parameters<typeof handleSnapshotUpgrade>[1];
    const res = handleSnapshotUpgrade(
      new Request("http://127.0.0.1:7878/api/snapshots/foo/ws"),
      fakeServer,
      "foo",
    );
    expect(res?.status).toBe(403);
  });

  test("upgrade with loopback origin returns 426 when server cannot upgrade", () => {
    // server.upgrade returns false in test harness — origin gate passes,
    // route falls through to 426. Real Bun.serve handles the upgrade path.
    const fakeServer = {
      upgrade: () => false,
    } as unknown as Parameters<typeof handleSnapshotUpgrade>[1];
    const res = handleSnapshotUpgrade(
      new Request("http://127.0.0.1:7878/api/snapshots/foo/ws", {
        headers: { origin: ORIGIN },
      }),
      fakeServer,
      "foo",
    );
    expect(res?.status).toBe(426);
  });

  test("subscribers receive a snapshot_update frame on recompose", async () => {
    const { manager, subscribers } = makeRig();
    manager.register<{ value: number }>("counter", async () => ({ value: 7 }));

    const sent: unknown[] = [];
    const fakeWs = {
      data: { snapshotKey: "counter", kind: "snapshot" as const, abort: new AbortController() },
      send: (raw: string) => {
        sent.push(JSON.parse(raw));
      },
      close: () => {},
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof snapshotWebSocketHandlers>["open"]>
    >[0];

    const handlers = snapshotWebSocketHandlers({ subscribers });
    handlers.open?.(fakeWs);

    await manager.recompose("counter");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "snapshot_update",
      key: "counter",
      version: 0,
      data: { value: 7 },
    });
  });

  test("close handler unsubscribes so future broadcasts don't reach the socket", async () => {
    const { manager, subscribers } = makeRig();
    manager.register("k", () => 1);

    const sent: unknown[] = [];
    const fakeWs = {
      data: { snapshotKey: "k", kind: "snapshot" as const, abort: new AbortController() },
      send: (raw: string) => {
        sent.push(JSON.parse(raw));
      },
      close: () => {},
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof snapshotWebSocketHandlers>["open"]>
    >[0];

    const handlers = snapshotWebSocketHandlers({ subscribers });
    handlers.open?.(fakeWs);
    await manager.recompose("k");
    expect(sent).toHaveLength(1);

    handlers.close?.(fakeWs, 1000, "client disconnected");
    await manager.recompose("k");
    // Second recompose fires a broadcast, but the unsubscribed socket no
    // longer receives it.
    expect(sent).toHaveLength(1);
  });

  test("a rib publishing via composeBundle round-trips through GET and WS", async () => {
    // End-to-end shape check for the v0.2 contract: a rib whose composeBundle
    // is registered with the manager produces a frame visible both at the
    // REST endpoint AND to live WS subscribers.
    const { app, manager, subscribers } = makeRig();

    // Mimic what apps/server/src/ribs.ts will do in step 4 — register a
    // composeBundle closure under the rib's id.
    const fakeRibId = "fixture";
    let composeCalls = 0;
    manager.register(fakeRibId, async () => {
      composeCalls++;
      return { generation: composeCalls };
    });

    const sent: unknown[] = [];
    const fakeWs = {
      data: {
        snapshotKey: fakeRibId,
        kind: "snapshot" as const,
        abort: new AbortController(),
      },
      send: (raw: string) => {
        sent.push(JSON.parse(raw));
      },
      close: () => {},
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof snapshotWebSocketHandlers>["open"]>
    >[0];

    const handlers = snapshotWebSocketHandlers({ subscribers });
    handlers.open?.(fakeWs);

    // Initial compose — rib's onboot warm-up call would do this. WS receives.
    await manager.recompose(fakeRibId);
    // Second compose — config change scenario. WS receives again, version++.
    await manager.recompose(fakeRibId);

    expect(composeCalls).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ key: fakeRibId, version: 0, data: { generation: 1 } });
    expect(sent[1]).toMatchObject({ key: fakeRibId, version: 1, data: { generation: 2 } });

    // REST GET sees the latest.
    const res = await app.fetch(new Request(`http://test/api/snapshots/${fakeRibId}`));
    const body = (await res.json()) as { version: number; data: { generation: number } };
    expect(body.version).toBe(1);
    expect(body.data).toEqual({ generation: 2 });
  });
});

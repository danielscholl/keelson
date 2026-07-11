// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import { createOpStore, type OpStore } from "../src/op-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: OpStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-op-store-"));
  dbPath = join(tmpDir, "test.db");
  db = openDatabase({ path: dbPath });
  store = createOpStore(db);
});

afterEach(() => {
  rmTemp(tmpDir);
});

function createOp(id: string, over: Partial<Parameters<OpStore["create"]>[0]> = {}): void {
  store.create({
    id,
    kind: "squad_coordinate",
    owner: "rib:squad",
    steerable: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

describe("OpStore", () => {
  test("create + get round-trips a running op", () => {
    createOp("op-1", { title: "coordinate", steerable: true });
    const rec = store.get("op-1");
    expect(rec).toBeDefined();
    expect(rec?.id).toBe("op-1");
    expect(rec?.kind).toBe("squad_coordinate");
    expect(rec?.owner).toBe("rib:squad");
    expect(rec?.status).toBe("running");
    expect(rec?.steerable).toBe(true);
    expect(rec?.result).toBeNull();
    expect(rec?.completedAt).toBeNull();
  });

  test("appendEvent assigns a per-op monotonic seq; listEvents honors the cursor", () => {
    createOp("op-1");
    createOp("op-2");
    expect(
      store.appendEvent("op-1", { kind: "log", message: "a" }, "2026-01-01T00:00:01.000Z"),
    ).toBe(1);
    expect(
      store.appendEvent("op-1", { kind: "progress", message: "b" }, "2026-01-01T00:00:02.000Z"),
    ).toBe(2);
    // A second op keeps its own seq sequence.
    expect(
      store.appendEvent("op-2", { kind: "log", message: "x" }, "2026-01-01T00:00:03.000Z"),
    ).toBe(1);
    expect(
      store.appendEvent(
        "op-1",
        { kind: "log", message: "c", data: { n: 3 } },
        "2026-01-01T00:00:04.000Z",
      ),
    ).toBe(3);

    const fromZero = store.listEvents("op-1", 0);
    expect(fromZero.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(fromZero[0]?.message).toBe("a");

    const afterTwo = store.listEvents("op-1", 2);
    expect(afterTwo.map((e) => e.seq)).toEqual([3]);
    expect(afterTwo[0]?.data).toEqual({ n: 3 });

    expect(store.listEvents("op-1", 3)).toEqual([]);
    expect(store.listEvents("op-2", 0).map((e) => e.seq)).toEqual([1]);
  });

  test("setTerminal persists status + result and only settles a running op", () => {
    createOp("op-1");
    store.setTerminal("op-1", "done", "2026-01-01T00:01:00.000Z", {
      result: { ok: true, count: 5 },
    });
    const rec = store.get("op-1");
    expect(rec?.status).toBe("done");
    expect(rec?.result).toEqual({ ok: true, count: 5 });
    expect(rec?.completedAt).toBe("2026-01-01T00:01:00.000Z");

    // A second terminal write is a no-op (guarded by WHERE status='running').
    store.setTerminal("op-1", "error", "2026-01-01T00:02:00.000Z", { error: "late" });
    expect(store.get("op-1")?.status).toBe("done");
  });

  test("settle appends the terminal frame and flips the row in one step", () => {
    createOp("op-1");
    const seq = store.settle(
      "op-1",
      "done",
      { kind: "done", message: "done", data: { ok: true } },
      "2026-01-01T00:01:00.000Z",
      { result: { ok: true } },
    );
    expect(seq).toBe(1);
    const rec = store.get("op-1");
    expect(rec?.status).toBe("done");
    expect(rec?.result).toEqual({ ok: true });
    expect(store.listEvents("op-1", 0).map((e) => e.kind)).toEqual(["done"]);
  });

  test("a non-serializable frame value / result stores a placeholder instead of throwing", () => {
    createOp("op-1");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      store.appendEvent(
        "op-1",
        { kind: "log", message: "x", data: cyclic },
        "2026-01-01T00:00:01.000Z",
      ),
    ).not.toThrow();
    // A BigInt result would make JSON.stringify throw — settle must still land.
    expect(() =>
      store.settle("op-1", "done", { kind: "done" }, "2026-01-01T00:01:00.000Z", {
        result: 10n as unknown,
      }),
    ).not.toThrow();
    expect(store.get("op-1")?.status).toBe("done");
    expect(store.listEvents("op-1", 0)[0]?.data).toBe("[unserializable value]");
  });

  test("list orders newest ops first", () => {
    createOp("op-old", { createdAt: "2026-01-01T00:00:00.000Z" });
    createOp("op-new", { createdAt: "2026-01-02T00:00:00.000Z" });
    expect(store.list().map((r) => r.id)).toEqual(["op-new", "op-old"]);
  });

  test("boot sweep flips a left-running op to orphaned but preserves terminal rows across restart", () => {
    createOp("op-running");
    createOp("op-done");
    store.appendEvent("op-done", { kind: "progress", message: "p" }, "2026-01-01T00:00:01.000Z");
    store.setTerminal("op-done", "done", "2026-01-01T00:00:02.000Z", { result: "final" });
    db.close();

    // Simulate a restart: reopen the db and construct a fresh store (its
    // constructor runs the boot sweep).
    const db2 = openDatabase({ path: dbPath });
    const store2 = createOpStore(db2);
    expect(store2.get("op-running")?.status).toBe("orphaned");
    expect(store2.get("op-running")?.completedAt).not.toBeNull();
    // The terminal op and its result survive the restart untouched.
    const done = store2.get("op-done");
    expect(done?.status).toBe("done");
    expect(done?.result).toBe("final");
    expect(store2.listEvents("op-done", 0).map((e) => e.seq)).toEqual([1]);
    db2.close();
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";

import { createRunSlots, resolveMaxConcurrentRuns } from "./run-concurrency.ts";

// Let queued grant callbacks run.
const flush = () => Promise.resolve();

describe("createRunSlots", () => {
  test("clamps the limit to a floor of 1", () => {
    expect(createRunSlots(0).limit).toBe(1);
    expect(createRunSlots(-5).limit).toBe(1);
    expect(createRunSlots(2.9).limit).toBe(2);
    expect(createRunSlots(3).limit).toBe(3);
  });

  test("grants up to the limit immediately and queues the excess", async () => {
    const slots = createRunSlots(2);
    await slots.acquire();
    await slots.acquire();
    expect(slots.active).toBe(2);

    let granted = false;
    const pending = slots.acquire().then((rel) => {
      granted = true;
      return rel;
    });
    await flush();
    expect(granted).toBe(false);
    expect(slots.waiting).toBe(1);
    // Keep the promise referenced so the runtime doesn't flag it.
    void pending;
  });

  test("releasing a slot grants the next waiter (FIFO)", async () => {
    const slots = createRunSlots(1);
    const first = await slots.acquire();

    const order: number[] = [];
    const p2 = slots.acquire().then((rel) => {
      order.push(2);
      return rel;
    });
    const p3 = slots.acquire().then((rel) => {
      order.push(3);
      return rel;
    });
    await flush();
    expect(slots.waiting).toBe(2);

    first();
    const r2 = await p2;
    expect(order).toEqual([2]);
    expect(slots.active).toBe(1);

    r2();
    await p3;
    expect(order).toEqual([2, 3]);
  });

  test("release is idempotent — a double call frees only one slot", async () => {
    const slots = createRunSlots(2);
    const rel = await slots.acquire();
    await slots.acquire();
    expect(slots.active).toBe(2);
    rel();
    rel();
    expect(slots.active).toBe(1);
  });

  test("aborting while queued frees the queue slot without consuming a run slot", async () => {
    const slots = createRunSlots(1);
    const held = await slots.acquire();
    expect(slots.active).toBe(1);

    const ac = new AbortController();
    const pending = slots.acquire(ac.signal);
    await flush();
    expect(slots.waiting).toBe(1);

    ac.abort();
    const noopRelease = await pending;
    expect(slots.waiting).toBe(0);
    expect(slots.active).toBe(1); // never consumed a slot

    // The abandoned release must be a no-op — it must not free the held slot.
    noopRelease();
    expect(slots.active).toBe(1);

    held();
    expect(slots.active).toBe(0);
  });

  test("an already-aborted signal against a full pool does not consume a slot", async () => {
    const slots = createRunSlots(1);
    await slots.acquire();
    const ac = new AbortController();
    ac.abort();

    const rel = await slots.acquire(ac.signal);
    expect(slots.active).toBe(1);
    expect(slots.waiting).toBe(0);
    rel();
    expect(slots.active).toBe(1);
  });

  test("an already-aborted signal does not consume a slot even when capacity is free", async () => {
    const slots = createRunSlots(2);
    const ac = new AbortController();
    ac.abort();

    const noopRelease = await slots.acquire(ac.signal);
    expect(slots.active).toBe(0);
    expect(slots.waiting).toBe(0);
    noopRelease(); // must be a no-op
    expect(slots.active).toBe(0);

    // A live caller still gets the untouched slot.
    await slots.acquire();
    expect(slots.active).toBe(1);
  });
});

describe("resolveMaxConcurrentRuns", () => {
  test("defaults to 4 when unset, empty, or unparseable", () => {
    expect(resolveMaxConcurrentRuns({})).toBe(4);
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "" })).toBe(4);
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "  " })).toBe(4);
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "abc" })).toBe(4);
  });

  test("floors invalid numbers to the default", () => {
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "0" })).toBe(4);
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "-3" })).toBe(4);
  });

  test("honors a valid explicit ceiling", () => {
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "1" })).toBe(1);
    expect(resolveMaxConcurrentRuns({ KEELSON_MAX_CONCURRENT_RUNS: "8" })).toBe(8);
  });
});

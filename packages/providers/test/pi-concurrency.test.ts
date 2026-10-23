// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { PiVendorSlots } from "../src/pi/concurrency.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PiVendorSlots", () => {
  test("unlimited vendors never wait", async () => {
    const slots = new PiVendorSlots({ rec: 1 });
    const a = await slots.acquire("openai");
    const b = await slots.acquire("openai");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(slots.isSaturated("openai")).toBe(false);
  });

  test("a limited vendor queues turns in order until a slot frees", async () => {
    const slots = new PiVendorSlots({ rec: 1 });
    const order: string[] = [];
    const first = await slots.acquire("rec");
    expect(slots.isSaturated("rec")).toBe(true);
    const second = slots.acquire("rec").then((r) => {
      order.push("second");
      return r;
    });
    const third = slots.acquire("rec").then((r) => {
      order.push("third");
      return r;
    });
    await tick();
    expect(order).toEqual([]);
    first?.();
    (await second)?.();
    (await third)?.();
    expect(order).toEqual(["second", "third"]);
    expect(slots.isSaturated("rec")).toBe(false);
  });

  test("an abort while waiting returns null and leaves the queue intact", async () => {
    const slots = new PiVendorSlots({ rec: 1 });
    const held = await slots.acquire("rec");
    const abort = new AbortController();
    const cancelled = slots.acquire("rec", abort.signal);
    const next = slots.acquire("rec");
    abort.abort();
    expect(await cancelled).toBeNull();
    held?.();
    expect(await next).not.toBeNull();
  });

  test("a waiter cancelled right after being woken passes the wake-up on", async () => {
    const slots = new PiVendorSlots({ rec: 1 });
    const held = await slots.acquire("rec");
    const abort = new AbortController();
    const first = slots.acquire("rec", abort.signal);
    const second = slots.acquire("rec");
    await tick();
    held?.();
    abort.abort();
    expect(await first).toBeNull();
    const release = await Promise.race([second, tick().then(() => "stuck" as const)]);
    expect(release).not.toBe("stuck");
    expect(release).not.toBeNull();
  });

  test("release is idempotent", async () => {
    const slots = new PiVendorSlots({ rec: 2 });
    const a = await slots.acquire("rec");
    a?.();
    a?.();
    const b = await slots.acquire("rec");
    const c = await slots.acquire("rec");
    expect(slots.isSaturated("rec")).toBe(true);
    b?.();
    c?.();
  });
});

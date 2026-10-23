// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Per-vendor turn slots for pi. A local engine that serves one generation at a
// time (Recursive's rec, a single-slot llama.cpp) answers an overlapping
// request with HTTP 429, and parallel DAG nodes or a chat beside a workflow
// overlap constantly — so turns on a limited vendor queue here instead.
export class PiVendorSlots {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limits: Readonly<Record<string, number>> = {}) {}

  limitFor(vendor: string): number | undefined {
    const limit = this.limits[vendor];
    return limit !== undefined && limit >= 1 ? Math.floor(limit) : undefined;
  }

  // True when acquire() would have to wait.
  isSaturated(vendor: string): boolean {
    const limit = this.limitFor(vendor);
    return limit !== undefined && (this.active.get(vendor) ?? 0) >= limit;
  }

  // Resolves to a release function once a slot is free, or null when the
  // signal aborts first. Unlimited vendors resolve immediately.
  async acquire(vendor: string, signal?: AbortSignal): Promise<(() => void) | null> {
    const limit = this.limitFor(vendor);
    if (limit === undefined) return () => {};
    while ((this.active.get(vendor) ?? 0) >= limit) {
      if (signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(vendor) ?? [];
        this.waiters.set(vendor, queue);
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = queue.indexOf(wake);
          if (i >= 0) queue.splice(i, 1);
          resolve();
        };
        queue.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal?.aborted) return null;
    this.active.set(vendor, (this.active.get(vendor) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(vendor, (this.active.get(vendor) ?? 1) - 1);
      this.waiters.get(vendor)?.shift()?.();
    };
  }
}

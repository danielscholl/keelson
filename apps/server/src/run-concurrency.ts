// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Bounds how many heavyweight (worktree-isolated) workflow runs execute at
// once. Each such run creates a git worktree, installs deps, and drives
// validate-style nodes that fan out into hundreds of subprocesses; running
// several at once saturates the host and pushes individual `bun test` cases
// past their per-test timeout, which surfaces as a `posix_spawn` ENOENT when a
// timed-out test's teardown removes a cwd out from under an in-flight git
// spawn. Queuing the excess keeps the host below that cliff.

export interface RunSlots {
  /**
   * Acquire a slot, resolving with a release fn once one is free. When `signal`
   * aborts while queued, resolves early with a no-op release WITHOUT consuming a
   * slot — the caller checks `signal.aborted` to distinguish. Idempotent
   * release: calling it more than once frees exactly one slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Slots currently held. */
  readonly active: number;
  /** Callers parked waiting for a slot. */
  readonly waiting: number;
  /** Configured ceiling. */
  readonly limit: number;
}

export function createRunSlots(limit: number): RunSlots {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  // FIFO of grant callbacks parked waiting for a slot.
  const queue: Array<() => void> = [];

  function acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      // An already-cancelled caller must never take a slot — even when one is
      // free — or it briefly blocks a live run before releasing.
      if (signal?.aborted) {
        resolve(() => {});
        return;
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        active -= 1;
        const next = queue.shift();
        if (next) next();
      };

      const grant = (): void => {
        active += 1;
        resolve(release);
      };

      if (active < max) {
        grant();
        return;
      }

      // Parked. onSlot fires when a slot frees; onAbort fires if the caller is
      // cancelled first. Whichever runs first detaches the other so only one
      // settles the promise.
      const onSlot = (): void => {
        signal?.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = (): void => {
        const i = queue.indexOf(onSlot);
        if (i >= 0) queue.splice(i, 1);
        resolve(() => {});
      };
      queue.push(onSlot);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    acquire,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    limit: max,
  };
}

/**
 * Resolve the concurrent-run ceiling from `KEELSON_MAX_CONCURRENT_RUNS`.
 * Defaults to 4 so independent isolated runs can make progress while the cap
 * still bounds validation-heavy subprocess fan-out. Operators can override it.
 */
export function resolveMaxConcurrentRuns(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.KEELSON_MAX_CONCURRENT_RUNS;
  if (raw === undefined || raw.trim() === "") return 4;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 4;
  return n;
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// Wire frame the snapshot WS broadcasts on each recompose. Single-type union for now;
// adding error/invalidated frames later is non-breaking via the existing discriminator.
export const snapshotFrameSchema = z
  .object({
    type: z.literal("snapshot_update"),
    key: z.string().min(1),
    version: z.number().int().nonnegative(),
    composedAt: z.string().datetime({ offset: true }),
    data: z.unknown(),
  })
  .strict();

export type SnapshotFrame<T = unknown> = {
  type: "snapshot_update";
  key: string;
  version: number;
  composedAt: string;
  data: T;
};

// Compose function registered under a snapshot key. May be sync or async; the
// manager always awaits the return.
export type SnapshotComposer<T> = () => Promise<T> | T;

// Multi-consumer snapshot surface owned by the harness composition root.
// Ribs publish snapshots either through the typed `composeBundle` seam in
// the `Rib` contract or imperatively via `RibContext.getSnapshotManager()`.
export interface SnapshotManager {
  // Register a compose function under a key. Throws on duplicate key — call
  // the returned unregister handle before re-registering.
  register<T>(key: string, compose: SnapshotComposer<T>): () => void;

  // Recompose a registered key, broadcast a `snapshot_update` frame to
  // subscribers, and cache the result for future `latest()` reads.
  //
  // Concurrent calls coalesce: the in-flight promise is shared so a single
  // compose runs per resolution. Returns `undefined` if the key is not
  // registered, or if the compose function threw (the failure is logged and
  // the previous `latest` is preserved).
  recompose<T = unknown>(key: string): Promise<SnapshotFrame<T> | undefined>;

  // Returns the latest cached frame for a key. Wrapped (not bare `data`) so
  // late-joining WS clients can compare `version` against in-flight frames
  // and dedupe.
  latest<T = unknown>(key: string): SnapshotFrame<T> | undefined;

  // Enumerate registered keys — backs the `/api/snapshots` index endpoint.
  keys(): string[];

  // Idempotent teardown. Awaited from the rib/composition-root disposal
  // sequence; closes any held subscriber sockets and drops cached state.
  dispose(): Promise<void>;
}

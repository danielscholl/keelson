// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  SnapshotComposer,
  SnapshotFrame,
  SnapshotManager,
  SnapshotValidator,
} from "@keelson/shared";

// Per-rib facade over the shared SnapshotManager. A rib may only register keys
// under its own namespace (`rib:<id>` or `rib:<id>:*`) — an out-of-namespace
// register throws, the same way a self-id mismatch throws at activation: it's a
// rib-package bug, not operator misconfiguration. The bare `rib.id` is accepted
// as an alias for `rib:<id>` so a rib calling `recompose(rib.id)` keeps working
// after the composeBundle auto-registration moved under the namespace.
//
// `dispose()` releases only the handles this facade handed out; it never
// disposes the base manager — the composition root owns that lifecycle.
export function createScopedSnapshotManager(base: SnapshotManager, ribId: string): SnapshotManager {
  const prefix = `rib:${ribId}`;
  const owned = (key: string): boolean => key === prefix || key.startsWith(`${prefix}:`);
  // Map the bare rib id onto the namespaced root; leave everything else as-is.
  const resolve = (key: string): string => (key === ribId ? prefix : key);

  const handles = new Set<() => void>();
  let disposed = false;

  return {
    register<T>(
      key: string,
      compose: SnapshotComposer<T>,
      opts?: { validate?: SnapshotValidator<T> },
    ): () => void {
      // Honor the local disposed flag the same way the base manager does, so a
      // late closure held by a torn-down rib can't register a fresh handle the
      // already-run dispose() will never release.
      if (disposed) throw new Error(`scoped snapshot manager for '${ribId}' is disposed`);
      const resolved = resolve(key);
      if (!owned(resolved)) {
        throw new Error(`rib '${ribId}' may only register snapshot keys under '${prefix}:*'`);
      }
      const baseHandle = base.register(resolved, compose, opts);
      const handle = (): void => {
        if (handles.delete(handle)) baseHandle();
      };
      handles.add(handle);
      return handle;
    },
    recompose<T = unknown>(key: string): Promise<SnapshotFrame<T> | undefined> {
      if (disposed) return Promise.resolve(undefined);
      const resolved = resolve(key);
      // A rib reads only its own namespace — a guessed run-scoped or
      // foreign-rib key resolves to nothing rather than the base value.
      if (!owned(resolved)) return Promise.resolve(undefined);
      return base.recompose<T>(resolved);
    },
    latest<T = unknown>(key: string): SnapshotFrame<T> | undefined {
      const resolved = resolve(key);
      if (!owned(resolved)) return undefined;
      return base.latest<T>(resolved);
    },
    keys(): string[] {
      // A rib sees only its own namespace, never another rib's keys.
      return base.keys().filter(owned);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const handle of Array.from(handles)) handle();
      handles.clear();
    },
  };
}

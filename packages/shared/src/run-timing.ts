// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Critical-path accounting for a finished (or finishing) workflow run, computed
// client-side from the per-node timestamps every run record already carries.

export interface RunTimingNode {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly startedAt?: string | number | null;
  readonly completedAt?: string | number | null;
}

export interface RunTiming {
  /** Elapsed time from the run's first start to its last completion. */
  readonly wallClockMs: number;
  /** Longest dependency chain, summing each node's own duration. */
  readonly criticalPathMs: number;
  /**
   * `criticalPathMs / wallClockMs`, clamped to [0, 1]. 1 means the run took no
   * longer than its longest chain, so no node waited on anything but its own
   * dependencies.
   */
  readonly parallelism: number;
}

function toMs(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Compute wall clock, critical path, and their ratio for a run. Nodes without
 * both timestamps (skipped, pending) weigh zero on the chain. Returns `null`
 * when no node carries timing. `run` bounds the wall clock when both of its
 * timestamps are known; otherwise the node timestamps' span is used.
 */
export function runTiming(
  nodes: readonly RunTimingNode[],
  run?: { startedAt?: string | number | null; completedAt?: string | number | null },
): RunTiming | null {
  const durations = new Map<string, number>();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const started = toMs(node.startedAt);
    const completed = toMs(node.completedAt);
    if (started === undefined || completed === undefined) continue;
    durations.set(node.id, Math.max(0, completed - started));
    earliest = Math.min(earliest, started);
    latest = Math.max(latest, completed);
  }
  if (durations.size === 0) return null;

  const ids = new Set(nodes.map((node) => node.id));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = (node.dependsOn ?? []).filter((dep) => ids.has(dep) && dep !== node.id);
    remaining.set(node.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  // Longest path ending at each node, in Kahn order; a cycle (impossible for a
  // validated workflow) leaves its members unvisited and off the chain.
  const pathTo = new Map<string, number>();
  const queue = nodes.map((node) => node.id).filter((id) => remaining.get(id) === 0);
  let criticalPathMs = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const total = (pathTo.get(id) ?? 0) + (durations.get(id) ?? 0);
    pathTo.set(id, total);
    criticalPathMs = Math.max(criticalPathMs, total);
    for (const dependent of dependents.get(id) ?? []) {
      pathTo.set(dependent, Math.max(pathTo.get(dependent) ?? 0, total));
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }

  const runStart = toMs(run?.startedAt);
  const runEnd = toMs(run?.completedAt);
  const wallClockMs = Math.max(
    0,
    runStart !== undefined && runEnd !== undefined ? runEnd - runStart : latest - earliest,
  );
  const parallelism =
    wallClockMs === 0 ? 1 : Math.min(1, Math.max(0, criticalPathMs / wallClockMs));
  return { wallClockMs, criticalPathMs, parallelism };
}

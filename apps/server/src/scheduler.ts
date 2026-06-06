// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotManager } from "@keelson/shared";
import type { WorkflowDefinition } from "@keelson/workflows";
import { allRegions, type RibManifest } from "./ribs.ts";
import type { WorkflowController } from "./workflows-handler.ts";

const TICK_MS = 30_000;
// Cap on genuinely-new runs started per tick. With ascending-cadence ordering
// this staggers a cold boot across a few ticks instead of firing every
// collector at once.
const NEW_RUNS_PER_TICK = 2;

// Aliased so the injected timer fns and the stored handle share one type — a
// bare `ReturnType<typeof setInterval>` unions with the global's overloaded
// signature when defaulted, tripping the dom-vs-node `number | Timeout` clash.
type TimerHandle = ReturnType<typeof setInterval>;
type IntervalSetter = (fn: () => void, ms: number) => TimerHandle;
type IntervalClearer = (handle: TimerHandle) => void;

// One auto-refresh job: re-run `workflow` whenever the frame at `key` is older
// than `cadenceMs`. Derived from a surface region; 1:1 workflow→key in practice
// (a bound workflow publishes exactly one snapshot key).
export interface SurfaceSchedule {
  workflow: string;
  cadenceMs: number;
  key: string;
}

// Walk the activated ribs' surfaces and turn each cadence-bearing region into a
// schedule, dropping (with a warning) any whose workflow can't actually refresh
// it. Pairing the warning with the schedule here means the set we warn about
// and the set we run can never drift apart. `resolveBoundKey` returns the
// snapshot key a workflow republishes the way the run path resolves it
// (catalog → bound producer), or undefined when it isn't a refreshable producer
// — so a project workflow shadowing a rib's name resolves to undefined and is
// skipped rather than fired uselessly on every tick.
export function deriveSurfaceSchedules(
  manifests: readonly RibManifest[],
  resolveBoundKey: (workflow: string) => string | undefined,
): { schedules: SurfaceSchedule[]; warnings: string[] } {
  const warnings: string[] = [];
  const byWorkflow = new Map<string, SurfaceSchedule>();
  for (const manifest of manifests) {
    for (const surface of manifest.surfaces) {
      for (const region of allRegions(surface.layout)) {
        if (region.cadenceMs === undefined) continue;
        if (!region.workflow) {
          warnings.push(
            `surface region '${region.key}' sets cadenceMs but has no workflow; not auto-refreshing`,
          );
          continue;
        }
        const boundKey = resolveBoundKey(region.workflow);
        if (boundKey === undefined) {
          warnings.push(
            `surface region '${region.key}' workflow '${region.workflow}' is not a refreshable bound producer (unknown, unbound, or shadowed by a project workflow); not scheduling`,
          );
          continue;
        }
        if (boundKey !== region.key) {
          warnings.push(
            `surface region '${region.key}' workflow '${region.workflow}' publishes to '${boundKey}', not this region's key; not scheduling`,
          );
          continue;
        }
        const existing = byWorkflow.get(region.workflow);
        if (existing) {
          existing.cadenceMs = Math.min(existing.cadenceMs, region.cadenceMs);
        } else {
          byWorkflow.set(region.workflow, {
            workflow: region.workflow,
            cadenceMs: region.cadenceMs,
            key: region.key,
          });
        }
      }
    }
  }
  return { schedules: [...byWorkflow.values()], warnings };
}

// Resolve the snapshot key a workflow republishes, the way the run path does:
// by the catalog OBJECT, not the name. A bound rib producer resolves to its
// key; an unknown name, an unbound workflow, or a project workflow that shadows
// a rib's name (a different object the bindings map doesn't hold) resolves to
// undefined — so the scheduler won't fire it uselessly on every tick.
export function makeBoundKeyResolver(
  catalog: { get: (name: string) => WorkflowDefinition | undefined },
  bindings: ReadonlyMap<WorkflowDefinition, unknown>,
  boundKeys: ReadonlyMap<string, string>,
): (workflow: string) => string | undefined {
  return (workflow) => {
    const def = catalog.get(workflow);
    if (def === undefined || !bindings.has(def)) return undefined;
    return boundKeys.get(workflow);
  };
}

export interface SchedulerDeps {
  schedules: readonly SurfaceSchedule[];
  // Only the two seams the heartbeat needs; a test stub supplies just these.
  controller: Pick<WorkflowController, "startRun" | "findActiveRun">;
  snapshotManager: Pick<SnapshotManager, "latest">;
  repoRoot: string;
  disabled?: boolean;
  // Injection points so tests drive ticks deterministically without real timers.
  now?: () => number;
  setIntervalFn?: IntervalSetter;
  clearIntervalFn?: IntervalClearer;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

// A single coarse heartbeat that keeps snapshot-backed surface regions fresh
// even when no client tab is mounted. It fires due collectors through the same
// run-start seam the SPA uses, reading staleness from each frame's `composedAt`
// so a client refresh and a server tick suppress each other.
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const {
    schedules,
    controller,
    snapshotManager,
    repoRoot,
    disabled = false,
    now = Date.now,
  } = deps;
  const setIntervalFn: IntervalSetter = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn: IntervalClearer = deps.clearIntervalFn ?? clearInterval;
  // Ascending cadence so a cold boot warms short-cadence panels first under the
  // per-tick cap; the first ticks are the boot warm-pass, no separate path.
  const ordered = [...schedules].sort((a, b) => a.cadenceMs - b.cadenceMs);
  let handle: TimerHandle | undefined;

  const tick = (): void => {
    const t = now();
    let started = 0;
    for (const schedule of ordered) {
      if (started >= NEW_RUNS_PER_TICK) break;
      const frame = snapshotManager.latest(schedule.key);
      const composedMs = frame?.composedAt ? Date.parse(frame.composedAt) : Number.NaN;
      const fresh = !Number.isNaN(composedMs) && t - composedMs < schedule.cadenceMs;
      if (fresh) continue;
      // Already running (including a hung collector mid-timeout) → skip without
      // spending the cap; once it reaches a terminal state a later tick re-fires.
      // {} mirrors the inputs startRun fires with, so the de-dup keys align.
      if (controller.findActiveRun(schedule.workflow, repoRoot, {})) continue;
      const result = controller.startRun({
        name: schedule.workflow,
        inputs: {},
        workingDir: repoRoot,
      });
      if (result.ok) {
        started += 1;
      } else {
        console.warn(
          `[keelson] scheduler could not start '${schedule.workflow}': ${result.message}`,
        );
      }
    }
  };

  return {
    start(): void {
      if (disabled || handle !== undefined || ordered.length === 0) return;
      tick();
      handle = setIntervalFn(tick, TICK_MS);
    },
    stop(): void {
      if (handle !== undefined) {
        clearIntervalFn(handle);
        handle = undefined;
      }
    },
  };
}

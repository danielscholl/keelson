// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, test } from "bun:test";
import type { Rib, RibContext, RibSurfaceDescriptor, SnapshotManager } from "@keelson/shared";
import type { WorkflowDefinition } from "@keelson/workflows";
import { bootstrapRibs } from "../src/bootstrap.ts";
import type { RibManifest } from "../src/ribs.ts";
import {
  createScheduler,
  deriveSurfaceSchedules,
  makeBoundKeyResolver,
  type SurfaceSchedule,
} from "../src/scheduler.ts";
import type { WorkflowController } from "../src/workflows-handler.ts";

type Region = {
  key: string;
  workflow?: string;
  workflowArgs?: Record<string, string>;
  cadenceMs?: number;
};

function surface(id: string, columns: Region[]): RibSurfaceDescriptor {
  return { id, title: id, layout: { rows: [{ columns }] } };
}

function manifest(surfaces: RibSurfaceDescriptor[]): RibManifest {
  return {
    id: "osdu",
    displayName: "OSDU",
    registered: [],
    views: [],
    surfaces,
    hasOnAction: false,
    acceptsIngest: false,
  };
}

const keyResolver =
  (keys: Record<string, string>) =>
  (workflow: string): string | undefined =>
    keys[workflow];

describe("deriveSurfaceSchedules", () => {
  test("schedules a cadence region whose workflow publishes its own key", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [
        manifest([
          surface("s", [{ key: "rib:osdu:cluster", workflow: "osdu-cluster", cadenceMs: 600_000 }]),
        ]),
      ],
      keyResolver({ "osdu-cluster": "rib:osdu:cluster" }),
    );
    expect(warnings).toEqual([]);
    expect(schedules).toEqual([
      { workflow: "osdu-cluster", cadenceMs: 600_000, key: "rib:osdu:cluster" },
    ]);
  });

  test("warns and skips when the workflow is not a bound producer", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [
        manifest([
          surface("s", [{ key: "rib:osdu:cluster", workflow: "ghost", cadenceMs: 600_000 }]),
        ]),
      ],
      keyResolver({}),
    );
    expect(schedules).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a refreshable bound producer");
  });

  test("warns and skips when the workflow publishes a different key", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [manifest([surface("s", [{ key: "rib:osdu:a", workflow: "w", cadenceMs: 600_000 }])])],
      keyResolver({ w: "rib:osdu:b" }),
    );
    expect(schedules).toEqual([]);
    expect(warnings[0]).toContain("publishes to 'rib:osdu:b'");
  });

  test("warns and skips a cadence region with no workflow", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [manifest([surface("s", [{ key: "rib:osdu:x", cadenceMs: 600_000 }])])],
      keyResolver({}),
    );
    expect(schedules).toEqual([]);
    expect(warnings[0]).toContain("has no workflow");
  });

  test("warns and skips an args-bearing region (client-driven only)", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [
        manifest([
          surface("s", [
            {
              key: "rib:osdu:lens:a",
              workflow: "re-author",
              workflowArgs: { lens: "a" },
              cadenceMs: 600_000,
            },
          ]),
        ]),
      ],
      keyResolver({ "re-author": "rib:osdu:lens:a" }),
    );
    expect(schedules).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("client-side only");
  });

  test("silently leaves a region without a cadence unscheduled", () => {
    const { schedules, warnings } = deriveSurfaceSchedules(
      [manifest([surface("s", [{ key: "rib:osdu:x", workflow: "w" }])])],
      keyResolver({ w: "rib:osdu:x" }),
    );
    expect(schedules).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("de-dupes two regions on the same workflow, keeping the smaller cadence", () => {
    const { schedules } = deriveSurfaceSchedules(
      [
        manifest([
          {
            id: "s",
            title: "s",
            layout: {
              header: { key: "rib:osdu:x", workflow: "w", cadenceMs: 600_000 },
              rows: [{ columns: [{ key: "rib:osdu:x", workflow: "w", cadenceMs: 1_800_000 }] }],
            },
          },
        ]),
      ],
      keyResolver({ w: "rib:osdu:x" }),
    );
    expect(schedules).toEqual([{ workflow: "w", cadenceMs: 600_000, key: "rib:osdu:x" }]);
  });
});

describe("makeBoundKeyResolver", () => {
  const ribDef = { name: "collect" } as unknown as WorkflowDefinition;
  const boundKeys = new Map([["collect", "rib:osdu:cluster"]]);
  const bindings = new Map<WorkflowDefinition, unknown>([[ribDef, { publish() {} }]]);

  test("returns the bound key for a bound producer", () => {
    const resolve = makeBoundKeyResolver({ get: () => ribDef }, bindings, boundKeys);
    expect(resolve("collect")).toBe("rib:osdu:cluster");
  });

  test("returns undefined when a project workflow shadows the rib's name", () => {
    // The catalog resolves the name to a DIFFERENT object the bindings map does
    // not hold, so the run path would never republish the rib key.
    const shadow = { name: "collect" } as unknown as WorkflowDefinition;
    const resolve = makeBoundKeyResolver({ get: () => shadow }, bindings, boundKeys);
    expect(resolve("collect")).toBeUndefined();
  });

  test("returns undefined for an unknown workflow", () => {
    const resolve = makeBoundKeyResolver({ get: () => undefined }, bindings, boundKeys);
    expect(resolve("collect")).toBeUndefined();
  });
});

// A controller stub that records starts and treats anything it has started as
// live (mirrors the real registry: a started run stays in activeRuns until it
// reaches a terminal state).
function makeController() {
  const starts: string[] = [];
  const active = new Set<string>();
  const controller: Pick<WorkflowController, "startRun" | "findActiveRun"> = {
    startRun: ({ name }) => {
      starts.push(name);
      active.add(name);
      return { ok: true, runId: `r-${name}`, conversationId: "c" };
    },
    findActiveRun: (name) =>
      active.has(name) ? { runId: `live-${name}`, conversationId: "c" } : undefined,
  };
  return { starts, active, controller };
}

function makeSnapshots(frames: Map<string, string>): Pick<SnapshotManager, "latest"> {
  return {
    latest: ((key: string) => {
      const composedAt = frames.get(key);
      return composedAt === undefined
        ? undefined
        : { type: "snapshot_update", key, version: 1, composedAt, data: null };
    }) as Pick<SnapshotManager, "latest">["latest"],
  };
}

const HANDLE = 0 as unknown as ReturnType<typeof setInterval>;

// A manual clock + captured tick so multi-tick behavior is deterministic.
function harness(schedules: SurfaceSchedule[], snapshots: Pick<SnapshotManager, "latest">) {
  const ctl = makeController();
  let nowMs = 1_700_000_000_000;
  let captured: (() => void) | undefined;
  let setCalls = 0;
  let clearCalls = 0;
  const scheduler = createScheduler({
    schedules,
    controller: ctl.controller,
    snapshotManager: snapshots,
    repoRoot: "/repo",
    now: () => nowMs,
    setIntervalFn: (fn) => {
      setCalls += 1;
      captured = fn;
      return HANDLE;
    },
    clearIntervalFn: () => {
      clearCalls += 1;
    },
  });
  return {
    scheduler,
    starts: ctl.starts,
    tickAgain: () => captured?.(),
    advance: (ms: number) => {
      nowMs += ms;
    },
    capturedSet: () => captured !== undefined,
    setCalls: () => setCalls,
    clearCalls: () => clearCalls,
    nowMs: () => nowMs,
  };
}

describe("createScheduler", () => {
  const cold: SurfaceSchedule[] = [
    { workflow: "osdu-features", cadenceMs: 7_200_000, key: "rib:osdu:features" },
    { workflow: "osdu-cluster", cadenceMs: 600_000, key: "rib:osdu:cluster" },
    { workflow: "osdu-release", cadenceMs: 1_800_000, key: "rib:osdu:release" },
  ];

  test("cold boot fires ascending-cadence, capped per tick, staggering over ticks", () => {
    const h = harness(cold, makeSnapshots(new Map()));
    h.scheduler.start();
    // First tick: the two shortest cadences, in order.
    expect(h.starts).toEqual(["osdu-cluster", "osdu-release"]);
    h.advance(30_000);
    h.tickAgain();
    // The first two are now live (skipped); the 2h panel warms next.
    expect(h.starts).toEqual(["osdu-cluster", "osdu-release", "osdu-features"]);
  });

  test("does not fire while a frame is fresh", () => {
    const frames = new Map([["rib:osdu:cluster", new Date(1_700_000_000_000).toISOString()]]);
    const h = harness([cold[1]!], makeSnapshots(frames));
    h.scheduler.start();
    expect(h.starts).toEqual([]);
  });

  test("fires once a frame is older than its cadence", () => {
    const frames = new Map([
      ["rib:osdu:cluster", new Date(1_700_000_000_000 - 700_000).toISOString()],
    ]);
    const h = harness([cold[1]!], makeSnapshots(frames));
    h.scheduler.start();
    expect(h.starts).toEqual(["osdu-cluster"]);
  });

  test("tags producer runs as origin 'scheduled'", () => {
    // Retention itself is a creation-time invariant in startRunCore (covered by
    // the route/store tests); the scheduler's only retention-relevant job is to
    // stamp the right origin so those runs become prunable.
    const origins: Array<string | undefined> = [];
    const controller: Pick<WorkflowController, "startRun" | "findActiveRun"> = {
      startRun: ({ name, origin }) => {
        origins.push(origin);
        return { ok: true, runId: `r-${name}`, conversationId: "c" };
      },
      findActiveRun: () => undefined,
    };
    createScheduler({
      schedules: [cold[1]!],
      controller,
      snapshotManager: makeSnapshots(new Map()),
      repoRoot: "/repo",
      now: () => 1_700_000_000_000,
      setIntervalFn: () => HANDLE,
      clearIntervalFn: () => {},
    }).start();
    expect(origins).toEqual(["scheduled"]);
  });

  test("a frame that turns fresh after a fire suppresses the next tick", () => {
    const frames = new Map<string, string>();
    // Controller that never reports active, so only composedAt can suppress.
    const starts: string[] = [];
    const controller: Pick<WorkflowController, "startRun" | "findActiveRun"> = {
      startRun: ({ name }) => {
        starts.push(name);
        return { ok: true, runId: "r", conversationId: "c" };
      },
      findActiveRun: () => undefined,
    };
    let nowMs = 1_700_000_000_000;
    let captured: (() => void) | undefined;
    createScheduler({
      schedules: [cold[1]!],
      controller,
      snapshotManager: makeSnapshots(frames),
      repoRoot: "/repo",
      now: () => nowMs,
      setIntervalFn: (fn) => {
        captured = fn;
        return HANDLE;
      },
      clearIntervalFn: () => {},
    }).start();
    expect(starts).toEqual(["osdu-cluster"]);
    frames.set("rib:osdu:cluster", new Date(nowMs).toISOString());
    nowMs += 30_000;
    captured?.();
    expect(starts).toEqual(["osdu-cluster"]);
  });

  test("disabled scheduler never arms a timer or fires", () => {
    const ctl = makeController();
    let armed = false;
    const scheduler = createScheduler({
      schedules: cold,
      controller: ctl.controller,
      snapshotManager: makeSnapshots(new Map()),
      repoRoot: "/repo",
      disabled: true,
      now: () => 0,
      setIntervalFn: (fn) => {
        armed = true;
        void fn;
        return HANDLE;
      },
      clearIntervalFn: () => {},
    });
    scheduler.start();
    expect(armed).toBe(false);
    expect(ctl.starts).toEqual([]);
  });

  test("empty schedules: start() is a no-op", () => {
    const h = harness([], makeSnapshots(new Map()));
    h.scheduler.start();
    expect(h.capturedSet()).toBe(false);
    expect(h.starts).toEqual([]);
  });

  test("start() is idempotent and stop() clears the interval", () => {
    const h = harness(cold, makeSnapshots(new Map()));
    h.scheduler.start();
    h.scheduler.start();
    expect(h.setCalls()).toBe(1);
    h.scheduler.stop();
    expect(h.clearCalls()).toBe(1);
  });
});

// The RibContext.refreshWorkflow resolver bootstrapRibs builds from a
// getWorkflowController getter + refreshCwd. Driven through bootstrapRibs (not a
// reconstructed standalone) so the real inline resolver, the applyRibs id-bind
// spread, and the late-bound getter are exercised together.
describe("bootstrapRibs refreshWorkflow resolver", () => {
  const REFRESH_CWD = "/keelson-home";

  // A rib whose registerTools captures the per-rib ctx so the test can call the
  // wired ctx.refreshWorkflow directly.
  function capturingRib(sink: { ctx?: RibContext }): Rib {
    return {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        sink.ctx = ctx;
        return [];
      },
    };
  }

  type StartParams = Parameters<WorkflowController["startRun"]>[0];

  function recordingController(
    impl: (p: StartParams) => ReturnType<WorkflowController["startRun"]>,
  ) {
    const calls: StartParams[] = [];
    const controller = {
      startRun: (p: StartParams) => {
        calls.push(p);
        return impl(p);
      },
    } as unknown as WorkflowController;
    return { calls, controller };
  }

  // bootstrapRibs filters `active` by KEELSON_RIBS; clear it so the supplied rib
  // always activates regardless of the ambient env.
  let savedRibs: string | undefined;
  afterEach(() => {
    if (savedRibs === undefined) delete process.env.KEELSON_RIBS;
    else process.env.KEELSON_RIBS = savedRibs;
  });
  function isolateRibsEnv() {
    savedRibs = process.env.KEELSON_RIBS;
    delete process.env.KEELSON_RIBS;
  }

  test("re-runs the named bound producer via controller.startRun with aligned cwd/inputs/origin", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    const { calls, controller } = recordingController(({ name }) => ({
      ok: true,
      runId: `r-${name}`,
      conversationId: "c",
    }));
    await bootstrapRibs({
      available: { chamber: capturingRib(sink) },
      getWorkflowController: () => controller,
      refreshCwd: REFRESH_CWD,
    });
    expect(sink.ctx?.refreshWorkflow).toBeDefined();
    await sink.ctx?.refreshWorkflow?.("chamber-roster");
    expect(calls).toHaveLength(1);
    // De-dupe key alignment with the heartbeat: (name, workingDir, {}) + scheduled.
    expect(calls[0]).toMatchObject({
      name: "chamber-roster",
      inputs: {},
      workingDir: REFRESH_CWD,
      origin: "scheduled",
    });
  });

  test("optional inputs ride to the run (a per-item producer's args)", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    const { calls, controller } = recordingController(({ name }) => ({
      ok: true,
      runId: `r-${name}`,
      conversationId: "c",
    }));
    await bootstrapRibs({
      available: { chamber: capturingRib(sink) },
      getWorkflowController: () => controller,
      refreshCwd: REFRESH_CWD,
    });
    await sink.ctx?.refreshWorkflow?.("chamber-lens-refresh", { lens: "morning-brief" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "chamber-lens-refresh",
      inputs: { lens: "morning-brief" },
      workingDir: REFRESH_CWD,
      origin: "scheduled",
    });
  });

  test("an unknown workflow name resolves without throwing and republishes nothing", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    const { calls, controller } = recordingController(() => ({
      ok: false,
      message: "unknown workflow 'ghost'",
    }));
    await bootstrapRibs({
      available: { chamber: capturingRib(sink) },
      getWorkflowController: () => controller,
      refreshCwd: REFRESH_CWD,
    });
    // Resolver ignores result.ok — a { ok:false } never throws and never republishes.
    await expect(sink.ctx?.refreshWorkflow?.("ghost")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("a throwing controller is swallowed (fail-soft)", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    const { controller } = recordingController(() => {
      throw new Error("boom");
    });
    await bootstrapRibs({
      available: { chamber: capturingRib(sink) },
      getWorkflowController: () => controller,
      refreshCwd: REFRESH_CWD,
    });
    await expect(sink.ctx?.refreshWorkflow?.("x")).resolves.toBeUndefined();
  });

  test("a null controller (boot not complete) resolves to a no-op", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    let attempts = 0;
    await bootstrapRibs({
      available: { chamber: capturingRib(sink) },
      getWorkflowController: () => {
        attempts += 1;
        return undefined;
      },
      refreshCwd: REFRESH_CWD,
    });
    await expect(sink.ctx?.refreshWorkflow?.("x")).resolves.toBeUndefined();
    // The getter was consulted, but no startRun could be attempted.
    expect(attempts).toBe(1);
  });

  test("omits the seam when no controller getter is supplied (older-harness degradation)", async () => {
    isolateRibsEnv();
    const sink: { ctx?: RibContext } = {};
    await bootstrapRibs({ available: { chamber: capturingRib(sink) }, refreshCwd: REFRESH_CWD });
    expect(sink.ctx?.refreshWorkflow).toBeUndefined();
  });
});

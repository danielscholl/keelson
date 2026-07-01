// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { type WatchStayRunDeps, watchStayRun } from "../src/lib/watchStayRun.ts";

type Run = { status: string; error: string | null };

// A harness that returns the given run states in order (repeating the last), with a
// no-op sleep so polling doesn't wait real time.
function harness(runs: Run[]) {
  const toasts: { kind: string; message: string }[] = [];
  let i = 0;
  const deps: WatchStayRunDeps = {
    getRun: async () => runs[Math.min(i++, runs.length - 1)]!,
    toast: { push: (t) => toasts.push(t) },
    intervalMs: 0,
    maxPolls: 10,
    sleep: async () => {},
  };
  return { deps, toasts };
}

describe("watchStayRun", () => {
  test("toasts ok when the run succeeds, polling through a 'running' state", async () => {
    const { deps, toasts } = harness([
      { status: "running", error: null },
      { status: "succeeded", error: null },
    ]);
    await watchStayRun("squad-coordinate-run", "r1", deps);
    expect(toasts).toEqual([{ kind: "ok", message: "squad-coordinate-run ✓" }]);
  });

  test("toasts the run error when it fails", async () => {
    const { deps, toasts } = harness([{ status: "failed", error: "no matching active members" }]);
    await watchStayRun("squad-coordinate-run", "r1", deps);
    expect(toasts).toEqual([
      { kind: "error", message: "squad-coordinate-run failed: no matching active members" },
    ]);
  });

  test("toasts a bare status when a terminal run carries no error", async () => {
    const { deps, toasts } = harness([{ status: "cancelled", error: null }]);
    await watchStayRun("x", "r1", deps);
    expect(toasts).toEqual([{ kind: "error", message: "x cancelled" }]);
  });

  test("a transient getRun failure is skipped, not fatal", async () => {
    let calls = 0;
    const toasts: { kind: string; message: string }[] = [];
    const deps: WatchStayRunDeps = {
      getRun: async () => {
        calls++;
        if (calls === 1) throw new Error("network");
        return { status: "succeeded", error: null };
      },
      toast: { push: (t) => toasts.push(t) },
      intervalMs: 0,
      maxPolls: 5,
      sleep: async () => {},
    };
    await watchStayRun("x", "r1", deps);
    expect(toasts).toEqual([{ kind: "ok", message: "x ✓" }]);
    expect(calls).toBe(2);
  });

  test("stays silent when the run never settles within the poll cap", async () => {
    const { deps, toasts } = harness([{ status: "running", error: null }]);
    await watchStayRun("x", "r1", { ...deps, maxPolls: 3 });
    expect(toasts).toEqual([]);
  });
});

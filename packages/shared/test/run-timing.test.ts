// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { runTiming } from "../src/run-timing.ts";

const t = (ms: number): string => new Date(Date.UTC(2026, 8, 30, 0, 0, 0, ms)).toISOString();

describe("runTiming", () => {
  it("returns null when no node carries timing", () => {
    expect(runTiming([{ id: "a" }, { id: "b", dependsOn: ["a"], startedAt: t(0) }])).toBeNull();
  });

  it("sums a chain so the critical path equals the wall clock", () => {
    const timing = runTiming([
      { id: "a", startedAt: t(0), completedAt: t(100) },
      { id: "b", dependsOn: ["a"], startedAt: t(100), completedAt: t(300) },
      { id: "c", dependsOn: ["b"], startedAt: t(300), completedAt: t(350) },
    ]);
    expect(timing).toEqual({ wallClockMs: 350, criticalPathMs: 350, criticalPathRatio: 1 });
  });

  it("takes the longest branch of a diamond and reports the ratio", () => {
    // a → {b: 400, c: 50 → e: 100} → d. Longest chain is a → b → d = 550.
    const timing = runTiming([
      { id: "a", startedAt: t(0), completedAt: t(100) },
      { id: "b", dependsOn: ["a"], startedAt: t(100), completedAt: t(500) },
      { id: "c", dependsOn: ["a"], startedAt: t(100), completedAt: t(150) },
      { id: "e", dependsOn: ["c"], startedAt: t(150), completedAt: t(250) },
      { id: "d", dependsOn: ["b", "c"], startedAt: t(1000), completedAt: t(1100) },
    ]);
    expect(timing).toEqual({
      wallClockMs: 1100,
      criticalPathMs: 600,
      criticalPathRatio: 600 / 1100,
    });
  });

  it("weighs skipped and pending nodes as zero and ignores unknown edges", () => {
    const timing = runTiming([
      { id: "a", startedAt: t(0), completedAt: t(200) },
      { id: "gate", dependsOn: ["a"] },
      { id: "b", dependsOn: ["gate", "ghost"], startedAt: t(200), completedAt: t(260) },
    ]);
    expect(timing).toEqual({ wallClockMs: 260, criticalPathMs: 260, criticalPathRatio: 1 });
  });

  it("measures the span of the recorded executions, not any outer clock", () => {
    // A converge run keeps only each node's final round; the ratio describes it.
    const timing = runTiming([
      { id: "draft", startedAt: t(5000), completedAt: t(5100) },
      { id: "gate", dependsOn: ["draft"], startedAt: t(5100), completedAt: t(5150) },
    ]);
    expect(timing).toEqual({ wallClockMs: 150, criticalPathMs: 150, criticalPathRatio: 1 });
  });
});

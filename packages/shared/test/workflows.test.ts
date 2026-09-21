// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { startWorkflowRunBodySchema, workflowRunDetailSchema } from "../src/workflows.ts";

function makeRunDetail(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    workflowName: "fix-issue",
    status: "paused" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    conversationId: null,
    projectId: null,
    workingDir: "/tmp/repo",
    worktreePath: null,
    worktreeBase: null,
    origin: "manual" as const,
    ribId: null,
    inputs: {},
    nodes: [],
    ...overrides,
  };
}

describe("workflowRunDetailSchema", () => {
  it("defaults brief to null", () => {
    expect(workflowRunDetailSchema.parse(makeRunDetail()).brief).toBeNull();
  });

  it("defaults the preflight notice to null and accepts a persisted notice", () => {
    expect(workflowRunDetailSchema.parse(makeRunDetail()).preflightNotice).toBeNull();
    expect(
      workflowRunDetailSchema.parse(
        makeRunDetail({ preflightNotice: "preflight not checked: offline-catalog" }),
      ).preflightNotice,
    ).toBe("preflight not checked: offline-catalog");
  });

  it("defaults old isolation payloads and validates durable isolation state", () => {
    const legacy = workflowRunDetailSchema.parse(makeRunDetail());
    expect(legacy.isolationEnabled).toBeNull();
    expect(legacy.worktreeEstablished).toBe(false);

    const isolated = workflowRunDetailSchema.parse(
      makeRunDetail({ isolationEnabled: true, worktreeEstablished: true }),
    );
    expect(isolated.isolationEnabled).toBe(true);
    expect(isolated.worktreeEstablished).toBe(true);

    expect(() =>
      workflowRunDetailSchema.parse(makeRunDetail({ isolationEnabled: "true" })),
    ).toThrow();
    expect(() =>
      workflowRunDetailSchema.parse(makeRunDetail({ worktreeEstablished: 1 })),
    ).toThrow();
  });

  describe("startWorkflowRunBodySchema", () => {
    it("accepts an explicit preflight override", () => {
      expect(
        startWorkflowRunBodySchema.parse({
          inputs: {},
          workingDir: "/tmp/repo",
          preflight: false,
        }).preflight,
      ).toBe(false);
    });
  });

  it("accepts an attached brief", () => {
    const brief = {
      sourceUrl: "https://github.com/danielscholl/keelson/issues/1",
      title: "Fix criteria coverage",
      criteria: ["Flag uncovered acceptance criteria"],
    };
    expect(workflowRunDetailSchema.parse(makeRunDetail({ brief })).brief).toEqual(brief);
  });
});

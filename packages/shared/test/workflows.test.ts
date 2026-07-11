// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { workflowRunDetailSchema } from "../src/workflows.ts";

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

  it("accepts an attached brief", () => {
    const brief = {
      sourceUrl: "https://github.com/danielscholl/keelson/issues/1",
      title: "Fix criteria coverage",
      criteria: ["Flag uncovered acceptance criteria"],
    };
    expect(workflowRunDetailSchema.parse(makeRunDetail({ brief })).brief).toEqual(brief);
  });
});

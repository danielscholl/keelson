// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import {
  nodeOutputRowSchema,
  startWorkflowRunBodySchema,
  workflowFrameSchema,
  workflowRunDetailSchema,
} from "../src/workflows.ts";

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

  it("defaults the definition hash to null and accepts a persisted hash", () => {
    expect(workflowRunDetailSchema.parse(makeRunDetail()).definitionHash).toBeNull();
    const hash = "0f".repeat(32);
    expect(
      workflowRunDetailSchema.parse(makeRunDetail({ definitionHash: hash })).definitionHash,
    ).toBe(hash);
    expect(() => workflowRunDetailSchema.parse(makeRunDetail({ definitionHash: 7 }))).toThrow();
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

describe("sandbox outcome on node rows and node_done", () => {
  it("rows default the outcome to null and reject values outside the enum", () => {
    const row = {
      nodeId: "b",
      status: "succeeded",
      outputText: null,
      contentParts: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };
    expect(nodeOutputRowSchema.parse(row)).toMatchObject({ sandbox: null, sandboxBackend: null });
    expect(
      nodeOutputRowSchema.parse({ ...row, sandbox: "mxc", sandboxBackend: "seatbelt" }),
    ).toMatchObject({ sandbox: "mxc", sandboxBackend: "seatbelt" });
    expect(nodeOutputRowSchema.safeParse({ ...row, sandbox: "docker" }).success).toBe(false);
  });

  it("node_done carries an optional outcome and backend", () => {
    const frame = { type: "node_done", nodeId: "b", status: "succeeded", error: null };
    expect(
      workflowFrameSchema.parse({ ...frame, sandbox: "provider", sandboxBackend: "claude" }),
    ).toMatchObject({ sandbox: "provider", sandboxBackend: "claude" });
    expect(workflowFrameSchema.safeParse({ ...frame, sandbox: "on" }).success).toBe(false);
  });
});

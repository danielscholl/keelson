// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  type WorkflowFrame,
  type WorkflowRunDetail,
  workflowRunDetailSchema,
} from "@keelson/shared";
import {
  applyFrame,
  hydrateFromSnapshot,
  mergeNode,
  type NodeView,
  type RunView,
} from "../src/hooks/useWorkflowRun.ts";

// Drives the pure frame reducer with plain state closures — no React, no WS.
function harness() {
  let run: RunView = { runId: "r1", status: "loading", warnings: [] };
  let nodes: Record<string, NodeView> = {};
  const setRun = (update: RunView | ((prev: RunView) => RunView)): void => {
    run = typeof update === "function" ? update(run) : update;
  };
  const setNodes = (
    update:
      | Record<string, NodeView>
      | ((prev: Record<string, NodeView>) => Record<string, NodeView>),
  ): void => {
    nodes = typeof update === "function" ? update(nodes) : update;
  };
  return {
    apply: (frame: WorkflowFrame) =>
      applyFrame(
        frame,
        setRun as React.Dispatch<React.SetStateAction<RunView>>,
        setNodes as React.Dispatch<React.SetStateAction<Record<string, NodeView>>>,
      ),
    node: (id: string) => nodes[id],
  };
}

const textChunk = (nodeId: string, content: string): WorkflowFrame => ({
  type: "node_chunk",
  nodeId,
  chunk: { type: "text", content },
});

describe("applyFrame converge relaunch", () => {
  test("a node_started after node_done resets the accumulated view", () => {
    const h = harness();
    // Round 1: run, stream, settle.
    h.apply({ type: "node_started", nodeId: "extract-pr" });
    h.apply(textChunk("extract-pr", "46"));
    h.apply({ type: "node_log", nodeId: "extract-pr", line: "round 1 log" });
    h.apply({
      type: "node_done",
      nodeId: "extract-pr",
      status: "succeeded",
      error: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const settled = h.node("extract-pr");
    expect(settled?.status).toBe("succeeded");
    expect(settled?.contentParts).toEqual([{ type: "text", text: "46" }]);

    // Round 2 relaunch: the executor reset the node's outputs; the view must
    // reset with it instead of concatenating rounds ("4646") and carrying
    // round 1's usage/completion over the new launch.
    h.apply({ type: "node_started", nodeId: "extract-pr" });
    const relaunched = h.node("extract-pr");
    expect(relaunched?.status).toBe("running");
    expect(relaunched?.contentParts).toEqual([]);
    expect(relaunched?.logLines).toEqual([]);
    expect(relaunched?.completedAt).toBeUndefined();
    expect(relaunched?.usage).toBeUndefined();

    h.apply(textChunk("extract-pr", "46"));
    expect(h.node("extract-pr")?.contentParts).toEqual([{ type: "text", text: "46" }]);
  });

  test("a first node_started keeps content that raced ahead of it", () => {
    const h = harness();
    // A chunk arriving before its node_started (defensive ordering) must not
    // be wiped: only a relaunch from a terminal state resets.
    h.apply(textChunk("fetch-state", "early"));
    h.apply({ type: "node_started", nodeId: "fetch-state" });
    expect(h.node("fetch-state")?.contentParts).toEqual([{ type: "text", text: "early" }]);
    expect(h.node("fetch-state")?.status).toBe("running");
  });
});

describe("mergeNode effort", () => {
  const base = (partial: Partial<NodeView> & { nodeId: string }): NodeView => ({
    status: "succeeded",
    contentParts: [],
    thinkingText: "",
    logLines: [],
    ...partial,
  });

  test("a node_done carrying no tier clears the snapshot's stale one", () => {
    const snapshot = base({ nodeId: "n1", provider: "copilot", effort: "xhigh" });
    // What applyFrame writes for a node_done with no effort: key present, value undefined.
    const live = base({ nodeId: "n1", provider: "copilot", effort: undefined });
    expect(mergeNode(snapshot, live).effort).toBeUndefined();
  });

  test("a live side that never saw node_done defers to the snapshot", () => {
    const snapshot = base({ nodeId: "n1", provider: "copilot", effort: "xhigh" });
    const live = base({ nodeId: "n1", status: "running" });
    expect(mergeNode(snapshot, live).effort).toBe("xhigh");
  });

  test("a live tier wins over the snapshot's", () => {
    const snapshot = base({ nodeId: "n1", effort: "low" });
    const live = base({ nodeId: "n1", effort: "xhigh" });
    expect(mergeNode(snapshot, live).effort).toBe("xhigh");
  });

  test("the snapshot's server-recorded start beats live's later client stamp", () => {
    const snapshot = base({ nodeId: "n1", status: "running", startedAt: 1_000 });
    const live = base({ nodeId: "n1", status: "running", startedAt: 23_000 });
    expect(mergeNode(snapshot, live).startedAt).toBe(1_000);
  });

  test("a snapshot with no start defers to live's stamp", () => {
    const snapshot = base({ nodeId: "n1", status: "pending" });
    const live = base({ nodeId: "n1", status: "running", startedAt: 23_000 });
    expect(mergeNode(snapshot, live).startedAt).toBe(23_000);
  });
});

describe("hydrateFromSnapshot running overlay", () => {
  const detail = (overrides: Record<string, unknown>): WorkflowRunDetail =>
    workflowRunDetailSchema.parse({
      runId: "r1",
      workflowName: "wf",
      status: "running",
      startedAt: "2026-08-14T20:00:00.000Z",
      completedAt: null,
      error: null,
      conversationId: null,
      projectId: null,
      workingDir: null,
      worktreePath: null,
      inputs: {},
      nodes: [],
      ...overrides,
    });

  test("an in-flight node hydrates as a running view with the server start", () => {
    const startedAt = "2026-08-14T20:00:05.000Z";
    const { nodes } = hydrateFromSnapshot(
      detail({ runningNodes: [{ nodeId: "author", startedAt }] }),
    );
    expect(nodes.author?.status).toBe("running");
    expect(nodes.author?.startedAt).toBe(Date.parse(startedAt));
    expect(nodes.author?.contentParts).toEqual([]);
    expect(nodes.author?.completedAt).toBeUndefined();
  });

  test("a snapshot without the overlay hydrates no running rows", () => {
    const { nodes } = hydrateFromSnapshot(detail({}));
    expect(Object.keys(nodes)).toEqual([]);
  });

  test("the running overlay outranks a stale terminal row for the same node", () => {
    const { nodes } = hydrateFromSnapshot(
      detail({
        nodes: [
          {
            nodeId: "author",
            status: "succeeded",
            outputText: "round 1",
            contentParts: null,
            startedAt: "2026-08-14T19:59:00.000Z",
            completedAt: "2026-08-14T19:59:30.000Z",
            error: null,
          },
        ],
        runningNodes: [{ nodeId: "author", startedAt: "2026-08-14T20:00:05.000Z" }],
      }),
    );
    expect(nodes.author?.status).toBe("running");
    expect(nodes.author?.logLines).toEqual([]);
    expect(nodes.author?.completedAt).toBeUndefined();
  });
});

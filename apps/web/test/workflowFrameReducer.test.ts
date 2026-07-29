// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { WorkflowFrame } from "@keelson/shared";
import { applyFrame, type NodeView, type RunView } from "../src/hooks/useWorkflowRun.ts";

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

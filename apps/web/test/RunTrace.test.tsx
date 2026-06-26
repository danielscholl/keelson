// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { beforeAll, describe, expect, test } from "bun:test";
import type { WorkflowNodeSummary } from "@keelson/shared";
import { render, screen } from "@testing-library/react";
import { RunTrace } from "../src/components/Workflows/RunTrace.tsx";
import type { NodeView } from "../src/hooks/useWorkflowRun.ts";

function node(partial: Partial<NodeView> & { nodeId: string }): NodeView {
  return {
    status: "succeeded",
    contentParts: [],
    thinkingText: "",
    logLines: [],
    ...partial,
  };
}

describe("RunTrace — per-node model", () => {
  // Warm the module graph (RunTrace pulls MarkdownContent → shiki) so the
  // first render doesn't pay the import cost inside its per-test timeout.
  beforeAll(async () => {
    await import("../src/components/Workflows/RunTrace.tsx");
  }, 30000);

  test("shows the configured model for a prompt node and omits it for bash", () => {
    const schemaNodes: WorkflowNodeSummary[] = [
      { id: "collect", type: "bash" },
      { id: "reason", type: "prompt", model: "claude-opus-4.8" },
    ];
    const nodes: Record<string, NodeView> = {
      collect: node({ nodeId: "collect", type: "bash" }),
      reason: node({ nodeId: "reason", type: "prompt" }),
    };
    const { container } = render(
      <RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />,
    );
    expect(screen.getByText("claude-opus-4.8")).toBeDefined();
    expect(screen.getByTitle("Model: claude-opus-4.8")).toBeDefined();
    // Exactly one model pill — the bash node carries no model.
    expect(container.querySelectorAll(".node-model")).toHaveLength(1);
  });

  test("runtime provider·model from the node result wins over the declared model", () => {
    const schemaNodes: WorkflowNodeSummary[] = [{ id: "reason", type: "prompt", model: "auto" }];
    const nodes: Record<string, NodeView> = {
      reason: node({ nodeId: "reason", type: "prompt", provider: "copilot", model: "auto" }),
    };
    render(<RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />);
    // The runtime chip combines provider + model and reads "Ran on …".
    expect(screen.getByText("copilot · auto")).toBeDefined();
    expect(screen.getByTitle("Ran on copilot · auto")).toBeDefined();
    // The static "Model: …" chip is replaced by the runtime one, not duplicated.
    expect(screen.queryByTitle("Model: auto")).toBeNull();
  });

  test("falls back to the declared model until the node reports a runtime provider/model", () => {
    const schemaNodes: WorkflowNodeSummary[] = [
      { id: "reason", type: "prompt", model: "claude-sonnet-4-6" },
    ];
    // Still running — no provider/model on the view yet.
    const nodes: Record<string, NodeView> = {
      reason: node({ nodeId: "reason", type: "prompt", status: "running" }),
    };
    render(<RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={true} />);
    expect(screen.getByTitle("Model: claude-sonnet-4-6")).toBeDefined();
  });
});

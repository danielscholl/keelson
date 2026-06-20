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
});

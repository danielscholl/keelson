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

const TRACE_USAGE_TOOLTIP =
  "Cumulative input tokens across all model API calls in this node — not the current prompt size. Context fill is shown separately.";

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

  test("backfills the declared model when the runtime reports a provider but no model", () => {
    const schemaNodes: WorkflowNodeSummary[] = [{ id: "reason", type: "prompt", model: "auto" }];
    // Ran on copilot, but the provider reported no concrete model.
    const nodes: Record<string, NodeView> = {
      reason: node({ nodeId: "reason", type: "prompt", provider: "copilot" }),
    };
    render(<RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />);
    // Provider from the runtime, model backfilled from the declared "auto".
    expect(screen.getByText("copilot · auto")).toBeDefined();
    expect(screen.getByTitle("Ran on copilot · auto")).toBeDefined();
  });

  test("node usage popover shows context and cache rows from reported usage", () => {
    const schemaNodes: WorkflowNodeSummary[] = [{ id: "reason", type: "prompt" }];
    const nodes: Record<string, NodeView> = {
      reason: node({
        nodeId: "reason",
        type: "prompt",
        usage: {
          inputTokens: 1500,
          outputTokens: 340,
          cacheReadInputTokens: 9000,
          cacheCreationInputTokens: 1200,
          contextTokens: 60_000,
          contextWindow: 200_000,
        },
      }),
    };
    const { container } = render(
      <RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />,
    );
    const trigger = screen.getByTitle(TRACE_USAGE_TOOLTIP);
    const popoverId = trigger.getAttribute("popovertarget");

    expect(trigger.textContent).toBe("↑1.5k ↓340");
    expect(popoverId).toContain("reason");
    expect(container.querySelector(`[id="${popoverId}"]`)).not.toBeNull();
    expect(screen.getByText("Context")).toBeDefined();
    expect(screen.getByText("60k of 200k (30%)")).toBeDefined();
    expect(screen.getByText("Node")).toBeDefined();
    expect(screen.getByText("Cache read")).toBeDefined();
    expect(screen.getByText("9k")).toBeDefined();
    expect(screen.getByText("Cache write")).toBeDefined();
    expect(screen.getByText("1.2k")).toBeDefined();
  });

  test("node usage popover omits absent cache and context rows", () => {
    const schemaNodes: WorkflowNodeSummary[] = [{ id: "reason", type: "prompt" }];
    const nodes: Record<string, NodeView> = {
      reason: node({
        nodeId: "reason",
        type: "prompt",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };
    render(<RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />);

    expect(screen.getByTitle(TRACE_USAGE_TOOLTIP)).toBeDefined();
    expect(screen.queryByText("Context")).toBeNull();
    expect(screen.queryByText("Cache read")).toBeNull();
    expect(screen.queryByText("Cache write")).toBeNull();
  });

  test("context-only usage does not render a fabricated input/output chip", () => {
    const schemaNodes: WorkflowNodeSummary[] = [{ id: "reason", type: "prompt" }];
    const nodes: Record<string, NodeView> = {
      reason: node({
        nodeId: "reason",
        type: "prompt",
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 42_000, contextWindow: 200_000 },
      }),
    };
    const { container } = render(
      <RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />,
    );

    expect(container.querySelector(".trace-usage")).toBeNull();
    expect(screen.queryByText(/↑0/)).toBeNull();
    expect(screen.queryByText(/↓0/)).toBeNull();
  });

  test("node usage popover ids are unique per node", () => {
    const schemaNodes: WorkflowNodeSummary[] = [
      { id: "plan/one", type: "prompt" },
      { id: "plan/two", type: "prompt" },
    ];
    const nodes: Record<string, NodeView> = {
      "plan/one": node({
        nodeId: "plan/one",
        type: "prompt",
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
      "plan/two": node({
        nodeId: "plan/two",
        type: "prompt",
        usage: { inputTokens: 20, outputTokens: 2 },
      }),
    };
    const { container } = render(
      <RunTrace schemaNodes={schemaNodes} nodes={nodes} runId="r1" streaming={false} />,
    );
    const ids = [...container.querySelectorAll(".trace-usage")].map((el) =>
      el.getAttribute("popovertarget"),
    );

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain("plan%2Fone");
    expect(ids[1]).toContain("plan%2Ftwo");
  });
});

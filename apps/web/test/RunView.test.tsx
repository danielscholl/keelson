// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, mock, test } from "bun:test";
import type { WorkflowDetail } from "@keelson/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NodeView, UseWorkflowRunResult } from "../src/hooks/useWorkflowRun.ts";

let runResult: UseWorkflowRunResult;

mock.module("../src/hooks/useWorkflowRun.ts", () => ({
  useWorkflowRun: () => runResult,
}));

mock.module("../src/components/Workflows/DagGraph.tsx", () => ({
  DagGraph: () => <div data-testid="dag-graph" />,
}));

mock.module("../src/components/Workflows/RunTrace.tsx", () => ({
  fallbackStatusFromRun: (status: string) => {
    if (status === "cancelled") return "cancelled";
    if (status === "succeeded" || status === "failed") return "skipped";
    return "pending";
  },
  RunTrace: () => <div data-testid="run-trace" />,
}));

const { RunView } = await import("../src/components/Workflows/RunView.tsx");

function node(partial: Partial<NodeView> & { nodeId: string }): NodeView {
  return {
    status: "succeeded",
    contentParts: [],
    thinkingText: "",
    logLines: [],
    ...partial,
  };
}

function result(nodes: Record<string, NodeView>): UseWorkflowRunResult {
  return {
    run: {
      runId: "run-12345678",
      workflowName: "smoke-test",
      status: "succeeded",
      startedAt: 0,
      completedAt: 1000,
      error: null,
      warnings: [],
      conversationId: null,
      projectId: null,
      workingDir: null,
      worktreePath: null,
    },
    nodes,
    status: "ready",
    error: null,
    wsState: "closed",
    cancel: async () => {},
    resumeRun: async () => {},
    resume: async () => {},
  };
}

const workflow: WorkflowDetail = {
  name: "smoke-test",
  description: "",
  nodes: [
    { id: "collect", type: "prompt" },
    { id: "verify", type: "prompt" },
  ],
};

describe("RunView usage header", () => {
  test("shows a run-level input/output popover without rolling up cache or context", () => {
    runResult = result({
      collect: node({
        nodeId: "collect",
        type: "prompt",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 9000,
          contextTokens: 60_000,
          contextWindow: 200_000,
        },
      }),
      verify: node({
        nodeId: "verify",
        type: "prompt",
        usage: { inputTokens: 200, outputTokens: 30, cacheCreationInputTokens: 1200 },
      }),
    });

    render(<RunView workflow={workflow} runId="run-12345678" onBack={() => {}} />);

    const trigger = screen.getByRole("button", {
      name: "300 input tokens, 50 output tokens across nodes",
    });
    expect(trigger.textContent).toBe("↑300 ↓50");
    expect(trigger.getAttribute("title")).toBe("350 tokens total across nodes · 300 in · 50 out");
    expect(trigger.getAttribute("popovertarget")).toContain("workflow-run-usage-");
    expect(screen.getByText("Run")).toBeDefined();
    expect(screen.getByText("↑ Input")).toBeDefined();
    expect(screen.getByText("300")).toBeDefined();
    expect(screen.getByText("↓ Output")).toBeDefined();
    expect(screen.getByText("50")).toBeDefined();
    expect(screen.queryByText("Context")).toBeNull();
    expect(screen.queryByText("Cache read")).toBeNull();
    expect(screen.queryByText("Cache write")).toBeNull();
  });

  test("hides the run-level usage chip when no node reported spend", () => {
    runResult = result({
      collect: node({
        nodeId: "collect",
        type: "prompt",
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 60_000, contextWindow: 200_000 },
      }),
    });

    const { container } = render(
      <RunView workflow={workflow} runId="run-12345678" onBack={() => {}} />,
    );

    expect(container.querySelector(".run-usage")).toBeNull();
    expect(screen.queryByText(/↑0/)).toBeNull();
    expect(screen.queryByText(/↓0/)).toBeNull();
  });
});

describe("RunView resume", () => {
  test("a failed run offers a Resume button that re-enters the run", () => {
    const resumeRun = mock(async () => {});
    const base = result({});
    runResult = {
      ...base,
      run: { ...base.run, status: "failed", error: "revalidate: exit code 1" },
      resumeRun,
    };

    render(<RunView workflow={workflow} runId="run-12345678" onBack={() => {}} />);

    const btn = screen.getByRole("button", { name: /Resume/ });
    fireEvent.click(btn);
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });

  test("a succeeded run shows no Resume button", () => {
    runResult = result({});
    render(<RunView workflow={workflow} runId="run-12345678" onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
  });
});

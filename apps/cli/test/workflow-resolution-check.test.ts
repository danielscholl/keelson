// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from "@keelson/workflows";
import { runWorkflowResolutionCheck } from "../src/checks/workflow-resolution.ts";

const COPILOT_CAPABILITIES = {
  defaultModel: "auto",
  models: ["auto"],
  modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
} as const;
const CLAUDE_CAPABILITIES = {
  defaultModel: "claude-opus-4-8",
  models: ["claude-fable-5", "claude-opus-4-8", "claude-haiku-4-5"],
  modelClasses: {
    fast: "claude-haiku-4-5",
    balanced: "claude-opus-4-8",
    deep: "claude-fable-5",
  },
} as const;

function workflow(
  name: string,
  nodes: Array<Record<string, unknown>>,
  provider?: string,
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name,
    description: "Exercises the workflow resolution doctor check.",
    ...(provider !== undefined ? { provider } : {}),
    nodes,
  });
}

const catalog = [
  workflow("portable", [{ id: "draft", prompt: "Draft.", model: "balanced" }]),
  workflow(
    "pinned-review",
    [
      {
        id: "logic",
        prompt: "Review logic.",
        model: "deep",
        model_by_provider: { copilot: "gpt-5.6-sol" },
      },
      {
        id: "risk",
        prompt: "Review risk.",
        model: "deep",
        model_by_provider: { copilot: "claude-opus-4.8" },
      },
    ],
    "copilot",
  ),
];

function discoverWorkflows() {
  return {
    workflows: catalog.map((definition) => ({
      workflow: definition,
      path: `${definition.name}.yaml`,
      source: "bundled" as const,
    })),
    errors: [],
    warnings: [],
  };
}

describe("workflow resolution doctor check", () => {
  test("reports the catalog native when Copilot is registered", () => {
    const result = runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [
        { id: "copilot", capabilities: COPILOT_CAPABILITIES },
      ],
      defaultProviderId: "copilot",
    });

    expect(result.category).toBe("workflow-resolution");
    expect(result.checks).toHaveLength(catalog.length);
    expect(result.checks.every(({ status }) => status === "ok")).toBe(true);
    expect(result.checks.every(({ detail }) => detail?.startsWith("native"))).toBe(
      true,
    );
  });

  test("names provider fallback and diversity collapse on Claude", () => {
    const result = runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [
        { id: "claude", capabilities: CLAUDE_CAPABILITIES },
      ],
      defaultProviderId: "claude",
    });

    expect(result.category).toBe("workflow-resolution");
    const pinned = result.checks.find(({ name }) => name === "pinned-review");
    expect(pinned?.status).toBe("warn");
    expect(pinned?.detail).toContain(
      "logic falls back to claude/claude-fable-5",
    );
    expect(pinned?.detail).toContain("lens/role diversity collapsed");
    expect(result.checks.find(({ name }) => name === "portable")?.status).toBe(
      "ok",
    );
  });

  test("blocks prompt workflows when no provider is registered", () => {
    const result = runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [],
    });

    expect(result.category).toBe("workflow-resolution");
    expect(result.checks.every(({ status }) => status === "warn")).toBe(true);
    expect(result.checks.every(({ detail }) => detail?.startsWith("blocked"))).toBe(
      true,
    );
    expect(result.checks.every(({ hint }) => hint?.includes("provider add"))).toBe(
      true,
    );
  });
});

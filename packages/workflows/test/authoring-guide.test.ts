// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";

import {
  AUTHORING_GUIDE_TOPICS,
  authoringGuideSection,
  WORKFLOW_AUTHORING_GUIDE,
} from "../src/authoring-guide.ts";
import {
  approvalOnRejectSchema,
  dagNodeBaseSchema,
  triggerRuleSchema,
} from "../src/schema/dag-node.ts";
import type { ConvergeConfig } from "../src/schema/converge.ts";
import type { LoopNodeConfig } from "../src/schema/loop.ts";
import { stepRetryConfigSchema } from "../src/schema/retry.ts";

// Record<keyof T, true> so the compiler flags a renamed/removed loop field
// here, and the runtime check below flags one the guide stops documenting.
const LOOP_CONFIG_KEYS: Record<keyof LoopNodeConfig, true> = {
  prompt: true,
  until: true,
  max_iterations: true,
  fresh_context: true,
  until_bash: true,
  interactive: true,
  gate_message: true,
};

const CONVERGE_CONFIG_KEYS: Record<keyof ConvergeConfig, true> = {
  gate: true,
  max_rounds: true,
  on_exhaust: true,
};

const NODE_TYPE_KEYWORDS = [
  "prompt",
  "bash",
  "command",
  "script",
  "loop",
  "approval",
  "cancel",
] as const;

const EXPECTED_SECTIONS = [
  "overview",
  "authoring-flow",
  "top-level-fields",
  "description-format",
  "node-types",
  "common-node-fields",
  "variables-and-data-flow",
  "control-flow-patterns",
  "validation",
  "scopes-and-saving",
  "example",
] as const;

describe("workflow authoring guide", () => {
  test("embeds a non-empty guide with every expected section", () => {
    expect(WORKFLOW_AUTHORING_GUIDE.length).toBeGreaterThan(1000);
    expect(AUTHORING_GUIDE_TOPICS).toEqual([...EXPECTED_SECTIONS]);
  });

  test("every topic round-trips through authoringGuideSection", () => {
    for (const topic of AUTHORING_GUIDE_TOPICS) {
      const section = authoringGuideSection(topic);
      expect(section).toBeDefined();
      expect(section!.startsWith("## ")).toBe(true);
    }
    // Case-insensitive and heading-form lookups both resolve.
    expect(authoringGuideSection("Node Types")).toBe(authoringGuideSection("node-types")!);
    expect(authoringGuideSection("no-such-topic")).toBeUndefined();
  });

  // Drift guards: a schema change that the guide doesn't document fails CI.
  test("documents every node type keyword", () => {
    for (const keyword of NODE_TYPE_KEYWORDS) {
      expect(WORKFLOW_AUTHORING_GUIDE).toContain(`\`${keyword}\``);
    }
  });

  test("documents every dagNodeBaseSchema field", () => {
    for (const field of Object.keys(dagNodeBaseSchema.shape)) {
      expect(WORKFLOW_AUTHORING_GUIDE).toContain(field);
    }
  });

  test("documents every trigger rule", () => {
    for (const rule of triggerRuleSchema.options) {
      expect(WORKFLOW_AUTHORING_GUIDE).toContain(rule);
    }
  });

  // Nested block fields drift too — a wrong field name in the guide makes
  // every draft authored from it fail validation.
  test("documents the nested retry, loop, converge, and approval on_reject fields", () => {
    const nestedKeys = [
      ...Object.keys(stepRetryConfigSchema.shape),
      ...Object.keys(LOOP_CONFIG_KEYS),
      ...Object.keys(CONVERGE_CONFIG_KEYS),
      ...Object.keys(approvalOnRejectSchema.shape),
    ];
    for (const field of nestedKeys) {
      expect(WORKFLOW_AUTHORING_GUIDE).toContain(field);
    }
  });
});

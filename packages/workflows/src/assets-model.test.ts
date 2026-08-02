// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { parseWorkflow } from "./loader.ts";
import type { WorkflowDefinition } from "./schema/index.ts";

const MODEL_TIERS = new Set(["fast", "balanced", "deep"]);

function bareConcreteModelIds(
  workflow: WorkflowDefinition,
): Array<{ nodeId: string; model: string }> {
  const findings: Array<{ nodeId: string; model: string }> = [];
  if (workflow.model !== undefined && !MODEL_TIERS.has(workflow.model)) {
    findings.push({ nodeId: "<workflow>", model: workflow.model });
  }
  for (const node of workflow.nodes) {
    if (node.prompt !== undefined && node.model !== undefined && !MODEL_TIERS.has(node.model)) {
      findings.push({ nodeId: node.id, model: node.model });
    }
  }
  return findings;
}

function loadBundledWorkflows(): Array<{ filename: string; workflow: WorkflowDefinition }> {
  const dir = path.join(import.meta.dir, "../assets/workflows");
  const filenames = fs
    .readdirSync(dir)
    .filter((filename) => /\.ya?ml$/.test(filename))
    .sort();

  return filenames.map((filename) => {
    const filePath = path.join(dir, filename);
    const result = parseWorkflow(fs.readFileSync(filePath, "utf8"), filePath);
    if (result.error !== null || result.workflow === null) {
      throw new Error(`${filename}: ${result.error?.error ?? "workflow missing"}`);
    }
    return { filename, workflow: result.workflow };
  });
}

describe("bundled workflow model policy", () => {
  test("uses portable tiers and leaves provider selection to the runner", () => {
    const violations: string[] = [];
    for (const { filename, workflow } of loadBundledWorkflows()) {
      for (const finding of bareConcreteModelIds(workflow)) {
        violations.push(`${filename}:${finding.nodeId} uses model '${finding.model}'`);
      }
      if (workflow.provider !== undefined) {
        violations.push(`${filename}:<workflow> pins provider '${workflow.provider}'`);
      }
      if (workflow.model === "auto") {
        violations.push(`${filename}:<workflow> uses model 'auto'`);
      }
      for (const node of workflow.nodes) {
        if ("model" in node && node.model === "auto") {
          violations.push(`${filename}:${node.id} uses model 'auto'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("flags a bare concrete prompt model", () => {
    const result = parseWorkflow(
      `
name: pinned-model
description: exercises the bundled asset model guard
nodes:
  - id: review
    prompt: Review the change.
    model: gpt-5.6-sol
`,
      "pinned-model.yaml",
    );

    expect(result.error).toBeNull();
    expect(bareConcreteModelIds(result.workflow!)).toEqual([
      { nodeId: "review", model: "gpt-5.6-sol" },
    ]);
  });
});

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
import type { DagNode } from "./schema/index.ts";

// The sandbox is on by default, so every bundled node runs confined unless it
// is listed here. Widening this set should be a deliberate, reviewed change.
const OPTED_OUT: Record<string, string[]> = {
  "adversarial-review": ["intake", "save"],
  "design-converge": ["intake", "persist", "complete"],
  "fix-issue": [
    "extract-issue",
    "fetch-issue",
    "detect-base",
    "implement",
    "validate",
    "fix-validation",
    "revalidate",
    "create-pr",
    "enforce-draft",
    "apply-fixes",
    "re-review",
    "post-fix-validate",
    "await-ci",
    "triage-ci",
    "fix-ci",
    "finalize-pr",
  ],
  hillclimb: ["preflight", "baseline", "round-1", "round-2", "round-3", "collect"],
  investigate: ["intake", "finalize"],
  "plan-act-evaluate": [
    "intake",
    "publish-plan",
    "detect-forge",
    "act-local",
    "evaluate",
    "open-pr",
    "act-delegate",
    "await-copilot",
    "ci-signals",
    "capture-diff",
    "pr-review",
    "report",
  ],
  "pr-review": ["scope", "post-review"],
  "resolve-pr": [
    "fetch-state",
    "triage",
    "fix",
    "validate",
    "fix-validation",
    "apply-review-fix",
    "revalidate",
    "push",
    "reply-resolve",
    "resolve-retry",
    "await-ci",
    "post-ci-state",
  ],
  "workflow-builder": ["validate-yaml"],
};

const dir = path.join(import.meta.dir, "../assets/workflows");
const bundled = fs
  .readdirSync(dir)
  .filter((filename: string) => /\.ya?ml$/.test(filename))
  .sort()
  .map((filename: string) => {
    const filePath = path.join(dir, filename);
    const text = fs.readFileSync(filePath, "utf8") as string;
    const result = parseWorkflow(text, filePath);
    if (result.error !== null || result.workflow === null) {
      throw new Error(`${filename}: ${result.error?.error ?? "workflow missing"}`);
    }
    return { name: result.workflow.name, text, workflow: result.workflow };
  });

function allNodes(nodes: readonly DagNode[]): DagNode[] {
  return nodes.flatMap((node) => {
    const inner = (node as { loop?: { nodes?: DagNode[] } }).loop?.nodes;
    return [node, ...(inner !== undefined ? allNodes(inner) : [])];
  });
}

describe("bundled workflow sandbox opt-outs", () => {
  test("exactly the listed nodes opt out, and only with `enabled: false`", () => {
    const actual: Record<string, string[]> = {};
    for (const { name, workflow } of bundled) {
      expect(workflow.sandbox).toBeUndefined();
      const out = allNodes(workflow.nodes).filter((node) => node.sandbox !== undefined);
      for (const node of out) expect(node.sandbox).toEqual({ enabled: false });
      if (out.length > 0) actual[name] = out.map((node) => node.id);
    }
    expect(actual).toEqual(OPTED_OUT);
  });

  test("smoke-test stays fully sandboxed: it is the canary", () => {
    const smoke = bundled.find((w) => w.name === "smoke-test");
    expect(smoke).toBeDefined();
    expect(smoke?.text).not.toContain("sandbox:");
  });

  test("every opt-out says why on the line above it", () => {
    for (const { name, text } of bundled) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (line.trim() !== "sandbox: { enabled: false }") return;
        expect({ name, line: i + 1, above: lines[i - 1]?.trim().startsWith("# ") }).toEqual({
          name,
          line: i + 1,
          above: true,
        });
      });
    }
  });
});

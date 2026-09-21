// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./loader.ts";
import { diagnoseModelDiversity } from "./model-diversity.ts";
import type { WorkflowDefinition } from "./schema/index.ts";

function makeWorkflow(
  nodes: WorkflowDefinition["nodes"],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name: "diversity-test",
    description: "exercises model diversity diagnostics",
    nodes,
    ...overrides,
  };
}

describe("diagnoseModelDiversity", () => {
  test("does not conflate within-node provider variation with sibling diversity", () => {
    const workflow = makeWorkflow([
      {
        id: "first",
        prompt: "First lens",
        model: "deep",
        model_by_provider: { copilot: "model-x", claude: "model-y" },
      },
      {
        id: "second",
        prompt: "Second lens",
        model: "deep",
        model_by_provider: { copilot: "model-x", claude: "model-y" },
      },
    ]);

    expect(diagnoseModelDiversity(workflow, "codex")).toEqual([]);
  });

  test("uses the inherited workflow model when sibling mappings collapse", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "first",
          prompt: "First lens",
          model_by_provider: { copilot: "model-a" },
        },
        {
          id: "second",
          prompt: "Second lens",
          model_by_provider: { copilot: "model-b" },
        },
      ],
      { model: "deep" },
    );

    expect(diagnoseModelDiversity(workflow, "claude")).toEqual([
      "diversity-test: no 'claude' entry in model_by_provider for nodes first, second -- all resolve to 'deep'; lens/role diversity collapsed on this provider.",
    ]);
  });

  test("gives a provider override precedence over workflow and node pins", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "first",
          prompt: "First lens",
          provider: "copilot",
          model: "deep",
          model_by_provider: { copilot: "model-a" },
        },
        {
          id: "second",
          prompt: "Second lens",
          provider: "copilot",
          model: "deep",
          model_by_provider: { copilot: "model-b" },
        },
      ],
      { provider: "copilot" },
    );

    expect(diagnoseModelDiversity(workflow, "claude")).toEqual([]);
    expect(diagnoseModelDiversity(workflow, undefined, "claude")).toHaveLength(1);
  });

  test("diagnoses parsed command mappings and ignores an unsupported loop mapping", () => {
    const result = parseWorkflow(
      `
name: parsed-diversity
description: exercises parsed model diversity
nodes:
  - id: first-command
    command: first-review
    model: deep
    model_by_provider:
      copilot: model-a
  - id: second-command
    command: second-review
    model: deep
    model_by_provider:
      copilot: model-b
  - id: review-loop
    loop:
      prompt: Review again.
      until: DONE
      max_iterations: 2
    model: deep
    model_by_provider:
      copilot: model-c
`,
      "parsed-diversity.yaml",
    );

    expect(result.error).toBeNull();
    if (result.workflow === null) throw new Error("expected parsed workflow");
    expect(result.workflow.nodes[2]?.model_by_provider).toBeUndefined();
    expect(
      result.warnings.some(
        (warning) =>
          warning.kind === "ai_fields_on_non_ai_node" &&
          warning.message.includes("model_by_provider"),
      ),
    ).toBe(true);
    expect(diagnoseModelDiversity(result.workflow, "claude")).toEqual([
      "parsed-diversity: no 'claude' entry in model_by_provider for nodes first-command, second-command -- all resolve to 'deep'; lens/role diversity collapsed on this provider.",
    ]);
  });
});

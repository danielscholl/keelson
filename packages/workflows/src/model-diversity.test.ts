// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
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
});

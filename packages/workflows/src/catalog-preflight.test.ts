// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import {
  checkWorkflowCatalog,
  formatPreflightViolations,
  type LiveCatalog,
} from "./catalog-preflight.ts";
import { type WorkflowDefinition, workflowDefinitionSchema } from "./schema/index.ts";

const PROVIDERS = new Map([
  [
    "copilot",
    {
      defaultModel: "auto",
      models: ["auto"],
      modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
    },
  ],
]);

function makeWorkflow(
  node: Record<string, unknown>,
  fields: Record<string, unknown> = {},
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name: "preflight-test",
    description: "Exercises live catalog preflight.",
    provider: "copilot",
    ...fields,
    nodes: [{ id: "review", prompt: "Review.", ...node }],
  });
}

function check(workflow: WorkflowDefinition, liveCatalog: LiveCatalog) {
  return checkWorkflowCatalog(workflow, {
    providers: PROVIDERS,
    defaultProviderId: "copilot",
    liveCatalog,
  });
}

describe("checkWorkflowCatalog", () => {
  test("flags a retired provider-specific model on its pinned provider", () => {
    const result = check(
      makeWorkflow({ model_by_provider: { copilot: "retired-model" } }),
      new Map([["copilot", [{ id: "current-model" }]]]),
    );

    expect(result).toEqual({
      violations: [
        {
          nodeId: "review",
          provider: "copilot",
          kind: "model",
          value: "retired-model",
          reason: "model 'retired-model' is not in copilot's live catalog",
        },
      ],
      notChecked: [],
    });
  });

  test("flags an effort outside the model's reported support", () => {
    const result = check(
      makeWorkflow({ model: "current-model", effort: "xhigh" }),
      new Map([
        [
          "copilot",
          [{ id: "current-model", supportedReasoningEfforts: ["low", "medium", "high"] }],
        ],
      ]),
    );

    expect(result.violations).toEqual([
      {
        nodeId: "review",
        provider: "copilot",
        kind: "effort",
        value: "xhigh",
        reason: "effort 'xhigh' exceeds copilot/current-model (supports low, medium, high)",
      },
    ]);
  });

  test("normalizes max effort to xhigh", () => {
    const result = check(
      makeWorkflow({ model: "current-model", effort: "max" }),
      new Map([
        ["copilot", [{ id: "current-model", supportedReasoningEfforts: ["high"] }]],
      ]),
    );

    expect(result.violations[0]).toMatchObject({
      kind: "effort",
      value: "max",
      reason: "effort 'max' exceeds copilot/current-model (supports high)",
    });
  });

  test("reports an unavailable catalog as not checked", () => {
    const result = check(
      makeWorkflow({ model: "retired-model", effort: "xhigh" }),
      new Map([["copilot", null]]),
    );

    expect(result).toEqual({ violations: [], notChecked: ["copilot"] });
  });

  test("does not flag an unpinned node resolving to a provider default sentinel", () => {
    const result = check(makeWorkflow({ model: "balanced" }), new Map([["copilot", []]]));

    expect(result).toEqual({ violations: [], notChecked: [] });
  });

  test("accepts a literal present in the live catalog", () => {
    const result = check(
      makeWorkflow({ model: "current-model" }),
      new Map([["copilot", [{ id: "current-model" }]]]),
    );

    expect(result).toEqual({ violations: [], notChecked: [] });
  });

  test("a model reporting no effort list is not judged on effort", () => {
    const result = check(
      makeWorkflow({ model: "current-model", effort: "xhigh" }),
      new Map([["copilot", [{ id: "current-model" }]]]),
    );

    expect(result).toEqual({ violations: [], notChecked: [] });
  });
});

describe("formatPreflightViolations", () => {
  test("formats violations and unavailable providers deterministically", () => {
    expect(
      formatPreflightViolations({
        violations: [
          {
            nodeId: "review",
            provider: "copilot",
            kind: "model",
            value: "retired-model",
            reason: "model 'retired-model' is not in copilot's live catalog",
          },
        ],
        notChecked: ["zeta", "alpha"],
      }),
    ).toBe(
      "- review: model 'retired-model' is not in copilot's live catalog\nnot checked: alpha, zeta",
    );
  });
});

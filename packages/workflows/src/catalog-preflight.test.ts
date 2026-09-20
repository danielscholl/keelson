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

const PROVIDERS_WITH_CLAUDE = new Map([
  ...PROVIDERS,
  [
    "claude",
    {
      defaultModel: "claude-model",
      models: ["claude-model"],
      modelClasses: { fast: "claude-model", balanced: "claude-model", deep: "claude-model" },
    },
  ],
]);

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

  test("does not flag a pinned literal once resolution fell back to another provider's default", () => {
    const result = checkWorkflowCatalog(makeWorkflow({ model: "retired-model" }), {
      providers: PROVIDERS_WITH_CLAUDE,
      defaultProviderId: "copilot",
      runProviderId: "claude",
      liveCatalog: new Map([["claude", [{ id: "claude-model" }]]]),
    });

    expect(result).toEqual({ violations: [], notChecked: [] });
  });

  test("judges effort against the resolved model, not a stale literal it fell back from", () => {
    const result = checkWorkflowCatalog(makeWorkflow({ model: "retired-model", effort: "xhigh" }), {
      providers: PROVIDERS_WITH_CLAUDE,
      defaultProviderId: "copilot",
      runProviderId: "claude",
      liveCatalog: new Map([
        ["claude", [{ id: "claude-model", supportedReasoningEfforts: ["low"] }]],
      ]),
    });

    expect(result.violations).toEqual([
      {
        nodeId: "review",
        provider: "claude",
        kind: "effort",
        value: "xhigh",
        reason: "effort 'xhigh' exceeds claude/claude-model (supports low)",
      },
    ]);
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
      new Map([["copilot", [{ id: "current-model", supportedReasoningEfforts: ["high"] }]]]),
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

  test("does not inherit a workflow literal when the node selects auto", () => {
    const result = check(
      makeWorkflow({ model: "auto" }, { model: "retired-workflow-model" }),
      new Map([["copilot", []]]),
    );

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

describe("checkWorkflowCatalog — model_by cases", () => {
  const LIVE: LiveCatalog = new Map([["copilot", [{ id: "gpt-live" }]]]);

  test("a retired model in any branch is a violation, not just the one a run would take", () => {
    const result = check(
      makeWorkflow({
        model_by: {
          from: "$inputs.tier",
          cases: {
            deep: { model: "gpt-retired" },
            std: { model: "gpt-live" },
          },
        },
      }),
      LIVE,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.value).toBe("gpt-retired");
    expect(result.violations[0]?.caseKey).toBe("deep");
    expect(result.violations[0]?.reason).toContain("model_by case 'deep'");
  });

  test("every branch on the live catalog is clean", () => {
    const result = check(
      makeWorkflow({
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { model: "gpt-live" }, std: { model: "gpt-live" } },
        },
      }),
      LIVE,
    );
    expect(result.violations).toEqual([]);
  });

  test("a branch's model_by_provider pin is checked for that provider", () => {
    const result = check(
      makeWorkflow({
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { model_by_provider: { copilot: "gpt-retired" } } },
        },
      }),
      LIVE,
    );
    expect(result.violations.map((v) => v.value)).toEqual(["gpt-retired"]);
  });

  test("a model class in a branch is not judged against the catalog", () => {
    const result = check(
      makeWorkflow({
        model_by: { from: "$inputs.tier", cases: { deep: { model: "deep" } } },
      }),
      LIVE,
    );
    expect(result.violations).toEqual([]);
  });

  test("a branch's effort is judged against that branch's own model", () => {
    const result = check(
      makeWorkflow({
        model_by: {
          from: "$inputs.tier",
          cases: {
            deep: { model: "gpt-live", effort: "xhigh" },
            std: { model: "gpt-live", effort: "high" },
          },
        },
      }),
      new Map([["copilot", [{ id: "gpt-live", supportedReasoningEfforts: ["low", "high"] }]]]),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("effort");
    expect(result.violations[0]?.caseKey).toBe("deep");
  });

  test("a branch without its own effort inherits the node's and is still judged", () => {
    const result = check(
      makeWorkflow({
        effort: "xhigh",
        model_by: { from: "$inputs.tier", cases: { deep: { model: "gpt-live" } } },
      }),
      new Map([["copilot", [{ id: "gpt-live", supportedReasoningEfforts: ["low", "high"] }]]]),
    );
    expect(result.violations.map((v) => v.kind)).toContain("effort");
  });

  test("an unreachable provider reports not-checked rather than violations", () => {
    const result = check(
      makeWorkflow({
        model_by: { from: "$inputs.tier", cases: { deep: { model: "gpt-retired" } } },
      }),
      new Map([["copilot", null]]),
    );
    expect(result.violations).toEqual([]);
    expect(result.notChecked).toEqual(["copilot"]);
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

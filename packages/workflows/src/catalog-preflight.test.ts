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
  return makeWorkflowWithNodes([{ id: "review", prompt: "Review.", ...node }], fields);
}

function makeWorkflowWithNodes(
  nodes: Array<Record<string, unknown>>,
  fields: Record<string, unknown> = {},
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name: "preflight-test",
    description: "Exercises live catalog preflight.",
    provider: "copilot",
    ...fields,
    nodes,
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

  test("flags a tier the operator override pins to a retired model", () => {
    const result = checkWorkflowCatalog(makeWorkflow({ model: "deep" }), {
      providers: PROVIDERS,
      defaultProviderId: "copilot",
      modelClassOverride: (providerId, modelClass) =>
        providerId === "copilot" && modelClass === "deep" ? "retired-deep" : undefined,
      liveCatalog: new Map([["copilot", [{ id: "current-model" }]]]),
    });

    expect(result.violations).toEqual([
      {
        nodeId: "review",
        provider: "copilot",
        kind: "model",
        value: "retired-deep",
        reason:
          "model class 'deep' resolves via config.json modelClasses to 'retired-deep', which is not in copilot's live catalog",
      },
    ]);
  });

  test("does not flag a tier resolved only by provider-owned fallbacks", () => {
    const providers = new Map([
      [
        "copilot",
        {
          defaultModel: "gone",
          models: ["gone"],
          modelClasses: { fast: "gone", balanced: "gone", deep: "gone" },
        },
      ],
    ]);
    const result = checkWorkflowCatalog(makeWorkflow({ model: "deep" }), {
      providers,
      defaultProviderId: "copilot",
      liveCatalog: new Map([["copilot", [{ id: "current-model" }]]]),
    });

    expect(result).toEqual({ violations: [], notChecked: [] });
  });

  test("accepts a tier the operator override pins to a live model", () => {
    const result = checkWorkflowCatalog(makeWorkflow({ model: "deep" }), {
      providers: PROVIDERS,
      defaultProviderId: "copilot",
      modelClassOverride: () => "current-model",
      liveCatalog: new Map([["copilot", [{ id: "current-model" }]]]),
    });

    expect(result).toEqual({ violations: [], notChecked: [] });
  });

  test("applies a class override only to its provider", () => {
    const result = checkWorkflowCatalog(makeWorkflow({ model: "deep" }), {
      providers: PROVIDERS_WITH_CLAUDE,
      defaultProviderId: "copilot",
      runProviderId: "claude",
      modelClassOverride: (providerId) =>
        providerId === "copilot" ? "retired-copilot-deep" : undefined,
      liveCatalog: new Map([["claude", [{ id: "claude-model" }]]]),
    });

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

  test("flags a command node's retired provider-specific model", () => {
    const result = check(
      makeWorkflowWithNodes([
        {
          id: "command-review",
          command: "review",
          model_by_provider: { copilot: "retired-model" },
        },
      ]),
      new Map([["copilot", [{ id: "current-model" }]]]),
    );

    expect(result.violations).toEqual([
      {
        nodeId: "command-review",
        provider: "copilot",
        kind: "model",
        value: "retired-model",
        reason: "model 'retired-model' is not in copilot's live catalog",
      },
    ]);
  });

  test("flags a command tier the operator override pins to a retired model", () => {
    const result = checkWorkflowCatalog(
      makeWorkflowWithNodes([{ id: "command-review", command: "review", model: "deep" }]),
      {
        providers: PROVIDERS,
        defaultProviderId: "copilot",
        modelClassOverride: () => "retired-deep",
        liveCatalog: new Map([["copilot", [{ id: "current-model" }]]]),
      },
    );

    expect(result.violations).toMatchObject([
      {
        nodeId: "command-review",
        kind: "model",
        value: "retired-deep",
      },
    ]);
    expect(result.violations[0]?.reason).toContain("model class 'deep'");
  });

  test("checks every model_by branch on a command node", () => {
    const result = checkWorkflowCatalog(
      makeWorkflowWithNodes([
        {
          id: "command-review",
          command: "review",
          model_by: {
            from: "$inputs.tier",
            cases: {
              retired: { model: "retired-model" },
              classed: { model: "deep" },
              excessive: { model: "current-model", effort: "xhigh" },
            },
          },
        },
      ]),
      {
        providers: PROVIDERS,
        defaultProviderId: "copilot",
        modelClassOverride: (_providerId, modelClass) =>
          modelClass === "deep" ? "retired-deep" : undefined,
        liveCatalog: new Map([
          ["copilot", [{ id: "current-model", supportedReasoningEfforts: ["low", "high"] }]],
        ]),
      },
    );

    expect(result.violations).toMatchObject([
      {
        nodeId: "command-review",
        kind: "model",
        value: "retired-model",
        caseKey: "retired",
      },
      {
        nodeId: "command-review",
        kind: "model",
        value: "retired-deep",
        caseKey: "classed",
      },
      {
        nodeId: "command-review",
        kind: "effort",
        value: "xhigh",
        caseKey: "excessive",
      },
    ]);
  });

  test("checks a loop node's inherited workflow model and effort", () => {
    const loop = {
      id: "loop-review",
      loop: { prompt: "Review again.", until: "DONE", max_iterations: 2 },
    };
    const modelResult = check(
      makeWorkflowWithNodes([loop], { model: "retired-model" }),
      new Map([["copilot", [{ id: "current-model" }]]]),
    );
    const effortResult = check(
      makeWorkflowWithNodes([loop], { model: "current-model", effort: "xhigh" }),
      new Map([["copilot", [{ id: "current-model", supportedReasoningEfforts: ["low", "high"] }]]]),
    );
    const overrideResult = checkWorkflowCatalog(makeWorkflowWithNodes([loop], { model: "deep" }), {
      providers: PROVIDERS,
      defaultProviderId: "copilot",
      modelClassOverride: () => "retired-deep",
      liveCatalog: new Map([["copilot", [{ id: "current-model" }]]]),
    });

    expect(modelResult.violations).toMatchObject([
      { nodeId: "loop-review", kind: "model", value: "retired-model" },
    ]);
    expect(effortResult.violations).toMatchObject([
      { nodeId: "loop-review", kind: "effort", value: "xhigh" },
    ]);
    expect(overrideResult.violations).toMatchObject([
      { nodeId: "loop-review", kind: "model", value: "retired-deep" },
    ]);
  });

  test("continues to exclude deterministic and control nodes", () => {
    const result = check(
      makeWorkflowWithNodes(
        [
          { id: "bash", bash: "true" },
          { id: "script", script: "console.log('done')", runtime: "bun" },
          { id: "approval", approval: { message: "Continue?" } },
          { id: "cancel", cancel: "Stop." },
        ],
        { model: "retired-model", effort: "xhigh" },
      ),
      new Map([["copilot", [{ id: "current-model", supportedReasoningEfforts: ["low", "high"] }]]]),
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

  test("an operator-pinned model class in a branch is judged against the catalog", () => {
    const result = checkWorkflowCatalog(
      makeWorkflow({
        model_by: { from: "$inputs.tier", cases: { deep: { model: "deep" } } },
      }),
      {
        providers: PROVIDERS,
        defaultProviderId: "copilot",
        modelClassOverride: (_providerId, modelClass) =>
          modelClass === "deep" ? "retired-deep" : undefined,
        liveCatalog: LIVE,
      },
    );

    expect(result.violations).toMatchObject([
      {
        nodeId: "review",
        kind: "model",
        value: "retired-deep",
        caseKey: "deep",
      },
    ]);
    expect(result.violations[0]?.reason).toContain("model class 'deep'");
    expect(result.violations[0]?.reason).toContain("model_by case 'deep'");
    expect(result.violations[0]?.reason).toContain("config.json modelClasses");
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

  test("a static pin every case replaces is not reported", () => {
    const result = check(
      makeWorkflow({
        model: "gpt-retired",
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { model: "gpt-live" }, std: { model: "gpt-live" } },
        },
      }),
      LIVE,
    );
    expect(result.violations).toEqual([]);
  });

  test("a static pin a case leaves in place is still reported", () => {
    const result = check(
      makeWorkflow({
        model: "gpt-retired",
        // `std` sets only effort, so the static pin is reachable through it.
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { model: "gpt-live" }, std: { effort: "low" } },
        },
      }),
      LIVE,
    );
    expect(result.violations.map((v) => v.value)).toContain("gpt-retired");
  });

  test("an effort-only case is judged against the model it inherits", () => {
    const result = check(
      makeWorkflow({
        model: "gpt-live",
        model_by: { from: "$inputs.tier", cases: { deep: { effort: "xhigh" } } },
      }),
      new Map([["copilot", [{ id: "gpt-live", supportedReasoningEfforts: ["low", "high"] }]]]),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("effort");
    expect(result.violations[0]?.caseKey).toBe("deep");
  });

  test("a case's plain model does not mask a static model_by_provider pin", () => {
    // applyModelCase leaves model_by_provider in place, and the prompt handler
    // gives it precedence, so the retired per-provider pin is what runs.
    const result = check(
      makeWorkflow({
        model_by_provider: { copilot: "gpt-retired" },
        model_by: { from: "$inputs.tier", cases: { deep: { model: "gpt-live" } } },
      }),
      LIVE,
    );
    expect(result.violations.map((v) => v.value)).toEqual(["gpt-retired"]);
  });

  test("a static effort every case replaces is not reported", () => {
    const result = check(
      makeWorkflow({
        model: "gpt-live",
        effort: "xhigh",
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { effort: "high" }, std: { effort: "low" } },
        },
      }),
      new Map([["copilot", [{ id: "gpt-live", supportedReasoningEfforts: ["low", "high"] }]]]),
    );
    expect(result.violations).toEqual([]);
  });

  test("an effort-only case on an inherited model is still judged", () => {
    const providers = new Map([
      [
        "copilot",
        {
          defaultModel: "gpt-default",
          models: ["gpt-default"],
          modelClasses: { fast: "gpt-default", balanced: "gpt-default", deep: "gpt-default" },
        },
      ],
    ]);
    const workflow = makeWorkflow({
      model_by: { from: "$inputs.tier", cases: { deep: { effort: "xhigh" } } },
    });
    const result = checkWorkflowCatalog(workflow, {
      providers,
      defaultProviderId: "copilot",
      liveCatalog: new Map([
        ["copilot", [{ id: "gpt-default", supportedReasoningEfforts: ["low", "high"] }]],
      ]),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("effort");
    expect(result.violations[0]?.caseKey).toBe("deep");
  });

  test("a case naming a model class is judged on what the class resolves to", () => {
    // Mirrors the static path, which checks effort against the resolved model
    // whether or not the pin was a class.
    const providers = new Map([
      [
        "copilot",
        {
          defaultModel: "gpt-default",
          models: ["gpt-deep", "gpt-default"],
          modelClasses: { fast: "gpt-default", balanced: "gpt-default", deep: "gpt-deep" },
        },
      ],
    ]);
    const result = checkWorkflowCatalog(
      makeWorkflow({
        model_by: { from: "$inputs.tier", cases: { deep: { model: "deep", effort: "xhigh" } } },
      }),
      {
        providers,
        defaultProviderId: "copilot",
        liveCatalog: new Map([
          ["copilot", [{ id: "gpt-deep", supportedReasoningEfforts: ["low", "high"] }]],
        ]),
      },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("effort");
    expect(result.violations[0]?.reason).toContain("gpt-deep");
  });

  test("a case that drops the provider from model_by_provider is judged on the fallback", () => {
    // applyModelCase replaces the whole map, so the node's own resolution names
    // a pin the case removed.
    const providers = new Map([
      [
        "copilot",
        {
          defaultModel: "gpt-default",
          models: ["gpt-pinned", "gpt-default"],
          modelClasses: { fast: "gpt-default", balanced: "gpt-default", deep: "gpt-default" },
        },
      ],
    ]);
    const result = checkWorkflowCatalog(
      makeWorkflow({
        model_by_provider: { copilot: "gpt-pinned" },
        model_by: {
          from: "$inputs.tier",
          cases: { deep: { model_by_provider: { claude: "other" }, effort: "xhigh" } },
        },
      }),
      {
        providers,
        defaultProviderId: "copilot",
        liveCatalog: new Map([
          [
            "copilot",
            [
              { id: "gpt-pinned", supportedReasoningEfforts: ["low", "high", "xhigh"] },
              { id: "gpt-default", supportedReasoningEfforts: ["low", "high"] },
            ],
          ],
        ]),
      },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("effort");
    expect(result.violations[0]?.reason).toContain("gpt-default");
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

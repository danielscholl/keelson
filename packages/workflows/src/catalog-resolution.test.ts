// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import { resolveWorkflowCatalog, resolveWorkflowResolution } from "./catalog-resolution.ts";
import { type WorkflowDefinition, workflowDefinitionSchema } from "./schema/index.ts";

const COPILOT_CAPABILITIES = {
  defaultModel: "auto",
  models: ["auto"],
  modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
} as const;
const CLAUDE_CAPABILITIES = {
  defaultModel: "claude-opus-4-8",
  models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  modelClasses: {
    fast: "claude-haiku-4-5",
    balanced: "claude-opus-4-8",
    deep: "claude-fable-5",
  },
} as const;

function makeWorkflow(
  nodes: Array<Record<string, unknown>>,
  fields: { name?: string; provider?: string; model?: string } = {},
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name: fields.name ?? "catalog-test",
    description: "Exercises static catalog resolution.",
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    nodes,
  });
}

describe("resolveWorkflowResolution", () => {
  test("keeps a registered provider pin and its provider-specific model native", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "review",
          prompt: "Review.",
          model: "deep",
          model_by_provider: { copilot: "gpt-5.6-sol" },
        },
      ],
      { provider: "copilot" },
    );

    const result = resolveWorkflowResolution(workflow, {
      providers: new Map([["copilot", COPILOT_CAPABILITIES]]),
      defaultProviderId: "copilot",
    });

    expect(result.tier).toBe("native");
    expect(result.nodes).toEqual([
      {
        nodeId: "review",
        preferredProvider: "copilot",
        effectiveProvider: "copilot",
        model: "gpt-5.6-sol",
        providerFellBack: false,
        modelFellBack: false,
      },
    ]);
  });

  test("degrades an unavailable provider pin through the fallback provider class", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "review",
          prompt: "Review.",
          model: "deep",
          model_by_provider: { copilot: "gpt-5.6-sol" },
        },
      ],
      { provider: "copilot" },
    );

    const result = resolveWorkflowResolution(workflow, {
      providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
      defaultProviderId: "claude",
    });

    expect(result.tier).toBe("degrades");
    expect(result.nodes[0]).toMatchObject({
      effectiveProvider: "claude",
      model: "claude-fable-5",
      providerFellBack: true,
      modelFellBack: false,
    });
    expect(result.fallbackNodes).toEqual([{ nodeId: "review", to: "claude/claude-fable-5" }]);
  });

  test("reports diversity collapse when provider mappings converge", () => {
    const workflow = makeWorkflow([
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
    ]);

    const result = resolveWorkflowResolution(workflow, {
      providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
      defaultProviderId: "claude",
    });

    expect(result.tier).toBe("degrades");
    expect(result.fallbackNodes).toEqual([]);
    expect(result.collapses).toHaveLength(1);
    expect(result.collapses[0]).toContain("logic, risk");
  });

  test("keeps an unpinned prompt native on the default provider", () => {
    const result = resolveWorkflowCatalog(
      [makeWorkflow([{ id: "draft", prompt: "Draft.", model: "balanced" }])],
      {
        providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
        defaultProviderId: "claude",
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe("native");
    expect(result[0]?.nodes[0]?.model).toBe("claude-opus-4-8");
  });

  test("blocks prompt workflows when no provider is available", () => {
    const result = resolveWorkflowResolution(makeWorkflow([{ id: "draft", prompt: "Draft." }]), {
      providers: new Map(),
    });

    expect(result.tier).toBe("blocked");
    expect(result.nodes[0]?.effectiveProvider).toBeUndefined();
  });

  test("falls back from a foreign literal outside the effective provider catalog", () => {
    const result = resolveWorkflowResolution(
      makeWorkflow([{ id: "draft", prompt: "Draft.", model: "gpt-5.6-sol" }], {
        provider: "copilot",
      }),
      {
        providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
        defaultProviderId: "claude",
      },
    );

    expect(result.nodes[0]).toMatchObject({
      model: "claude-opus-4-8",
      providerFellBack: true,
      modelFellBack: true,
    });
  });

  test("does not validate a literal against its own pinned provider catalog", () => {
    const result = resolveWorkflowResolution(
      makeWorkflow([{ id: "draft", prompt: "Draft.", model: "gpt-5.6-sol" }], {
        provider: "copilot",
      }),
      {
        providers: new Map([["copilot", COPILOT_CAPABILITIES]]),
        defaultProviderId: "copilot",
      },
    );

    expect(result.tier).toBe("native");
    expect(result.nodes[0]).toMatchObject({
      model: "gpt-5.6-sol",
      modelFellBack: false,
    });
  });

  test("prefers configured model classes and otherwise uses the provider default", () => {
    const workflow = makeWorkflow([{ id: "draft", prompt: "Draft.", model: "deep" }]);
    const configured = resolveWorkflowResolution(workflow, {
      providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
      defaultProviderId: "claude",
      modelClassOverride: (providerId, modelClass) =>
        providerId === "claude" && modelClass === "deep" ? "claude-custom-deep" : undefined,
    });
    const defaulted = resolveWorkflowResolution(workflow, {
      providers: new Map([
        ["gateway", { defaultModel: "gateway-default", models: ["gateway-default"] }],
      ]),
      defaultProviderId: "gateway",
    });

    expect(configured.nodes[0]?.model).toBe("claude-custom-deep");
    expect(defaulted.nodes[0]?.model).toBe("gateway-default");
  });
});

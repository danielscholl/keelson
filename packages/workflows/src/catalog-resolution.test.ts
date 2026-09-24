// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import {
  resolveWorkflowCatalog,
  resolveWorkflowResolution,
  resolveWorkflowResolutionReady,
} from "./catalog-resolution.ts";
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
  test("awaits one in-flight Copilot catalog for concurrent class resolutions", async () => {
    const gate = Promise.withResolvers<void>();
    let loads = 0;
    let loading: Promise<void> | undefined;
    const capabilities = {
      defaultModel: "auto",
      models: ["auto"],
      modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
    };
    const options = {
      providers: new Map([["copilot", capabilities]]),
      defaultProviderId: "copilot",
    };
    const wait = () => {
      if (!loading) {
        loads++;
        loading = gate.promise.then(() => {
          Object.assign(capabilities.modelClasses, {
            fast: "fast-model",
            balanced: "balanced-model",
            deep: "deep-model",
          });
          capabilities.models.push("fast-model", "balanced-model", "deep-model");
        });
      }
      return loading;
    };
    const fast = resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "fast", prompt: "fast", model: "fast" }]),
      options,
      wait,
    );
    const deep = resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "deep", prompt: "deep", model: "deep" }]),
      options,
      wait,
    );
    expect(loads).toBe(1);
    gate.resolve();
    expect((await fast).nodes[0]?.model).toBe("fast-model");
    expect((await deep).nodes[0]?.model).toBe("deep-model");
  });

  test("does not wait for explicit pins, absent classes or another provider", async () => {
    let waits = 0;
    const options = {
      providers: new Map<string, typeof COPILOT_CAPABILITIES | typeof CLAUDE_CAPABILITIES>([
        ["copilot", COPILOT_CAPABILITIES],
        ["claude", CLAUDE_CAPABILITIES],
      ]),
      defaultProviderId: "copilot",
    };
    const wait = async () => {
      waits++;
    };
    const explicit = await resolveWorkflowResolutionReady(
      makeWorkflow([
        { id: "explicit", prompt: "go", model: "deep", model_by_provider: { copilot: "pinned" } },
      ]),
      options,
      wait,
    );
    await resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "none", prompt: "go" }]),
      options,
      wait,
    );
    await resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "other", prompt: "go", model: "fast", provider: "claude" }]),
      options,
      wait,
    );
    await resolveWorkflowResolutionReady(
      makeWorkflow([
        {
          id: "dispatch",
          prompt: "go",
          model: "deep",
          model_by: {
            from: "$inputs.tier",
            cases: { exact: { model: "pinned" } },
          },
        },
      ]),
      options,
      wait,
    );
    const configured = await resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "configured", prompt: "go", model: "deep" }]),
      {
        ...options,
        modelClassOverride: (id, cls) =>
          id === "copilot" && cls === "deep" ? "config-deep" : undefined,
      },
      wait,
    );
    expect(explicit.nodes[0]?.model).toBe("pinned");
    expect(configured.nodes[0]?.model).toBe("config-deep");
    expect(waits).toBe(0);
  });

  test("settles unavailable discovery then resolves later Copilot classes to auto", async () => {
    const options = {
      providers: new Map([["copilot", COPILOT_CAPABILITIES]]),
      defaultProviderId: "copilot",
    };
    const wait = () => Promise.resolve();
    const workflow = makeWorkflow([{ id: "deep", prompt: "go", model: "deep" }]);
    expect((await resolveWorkflowResolutionReady(workflow, options, wait)).nodes[0]?.model).toBe(
      "auto",
    );
    expect((await resolveWorkflowResolutionReady(workflow, options, wait)).nodes[0]?.model).toBe(
      "auto",
    );
  });

  test("resolves initialized Copilot classes, overrides and provider fallback consistently", async () => {
    const capabilities = {
      defaultModel: "auto",
      models: ["auto", "fast-model", "balanced-model", "deep-model"],
      modelClasses: { fast: "fast-model", balanced: "balanced-model", deep: "deep-model" },
    };
    const options = {
      providers: new Map([["copilot", capabilities]]),
      defaultProviderId: "copilot",
    };
    const workflow = makeWorkflow([
      { id: "fast", prompt: "fast", model: "fast" },
      { id: "balanced", prompt: "balanced", model: "balanced" },
      { id: "deep", prompt: "deep", model: "deep" },
    ]);
    const resolved = await resolveWorkflowResolutionReady(workflow, options, async () => {});
    expect(resolved.nodes.map(({ model }) => model)).toEqual([
      "fast-model",
      "balanced-model",
      "deep-model",
    ]);
    const configured = await resolveWorkflowResolutionReady(
      workflow,
      {
        ...options,
        modelClassOverride: (id, cls) =>
          id === "copilot" && cls === "deep" ? "pinned-deep" : undefined,
      },
      async () => {},
    );
    expect(configured.nodes.map(({ model }) => model)).toEqual([
      "fast-model",
      "balanced-model",
      "pinned-deep",
    ]);
    const fallback = await resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "review", prompt: "review", model: "deep" }], {
        provider: "missing",
      }),
      options,
      async () => {},
    );
    expect(fallback.nodes[0]).toMatchObject({
      effectiveProvider: "copilot",
      model: "deep-model",
      providerFellBack: true,
      modelFellBack: false,
    });
    const runOverride = await resolveWorkflowResolutionReady(
      makeWorkflow([{ id: "review", prompt: "review", model: "deep" }], {
        provider: "claude",
      }),
      { ...options, runProviderId: "copilot" },
      async () => {},
    );
    expect(runOverride.nodes[0]).toMatchObject({
      effectiveProvider: "copilot",
      model: "deep-model",
      providerFellBack: true,
      modelFellBack: false,
    });
  });

  test("keeps a registered provider pin and its provider-specific model native", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "review",
          prompt: "Review.",
          model: "deep",
          model_by_provider: { copilot: "gpt-6-sol" },
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
        model: "gpt-6-sol",
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
          model_by_provider: { copilot: "gpt-6-sol" },
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
        model_by_provider: { copilot: "gpt-6-sol" },
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

  test("blocks command and loop nodes while excluding non-agent nodes", () => {
    const workflow = makeWorkflow([
      { id: "command", command: "review" },
      {
        id: "loop",
        loop: { prompt: "Review again.", until: "DONE", max_iterations: 2 },
      },
      { id: "bash", bash: "true" },
      { id: "script", script: "console.log('done')", runtime: "bun" },
      { id: "approval", approval: { message: "Continue?" } },
      { id: "cancel", cancel: "Stop." },
    ]);

    const result = resolveWorkflowResolution(workflow, { providers: new Map() });

    expect(result.tier).toBe("blocked");
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["command", "loop"]);
    expect(result.nodes.every((node) => node.effectiveProvider === undefined)).toBe(true);
  });

  test("falls command and loop provider pins back through their model settings", () => {
    const workflow = makeWorkflow(
      [
        {
          id: "command",
          command: "review",
          model: "deep",
          model_by_provider: { copilot: "gpt-6-sol" },
        },
        {
          id: "loop",
          loop: { prompt: "Review again.", until: "DONE", max_iterations: 2 },
        },
      ],
      { provider: "copilot", model: "balanced" },
    );

    const result = resolveWorkflowResolution(workflow, {
      providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
      defaultProviderId: "claude",
    });

    expect(result.tier).toBe("degrades");
    expect(result.nodes).toMatchObject([
      {
        nodeId: "command",
        effectiveProvider: "claude",
        model: "claude-fable-5",
        providerFellBack: true,
      },
      {
        nodeId: "loop",
        effectiveProvider: "claude",
        model: "claude-opus-4-8",
        providerFellBack: true,
      },
    ]);
    expect(result.fallbackNodes).toEqual([
      { nodeId: "command", to: "claude/claude-fable-5" },
      { nodeId: "loop", to: "claude/claude-opus-4-8" },
    ]);
  });

  test("blocks a run provider override that is not registered", () => {
    const result = resolveWorkflowResolution(makeWorkflow([{ id: "draft", prompt: "Draft." }]), {
      providers: new Map([["claude", CLAUDE_CAPABILITIES]]),
      defaultProviderId: "claude",
      runProviderId: "missing",
    });

    expect(result.tier).toBe("blocked");
    expect(result.nodes[0]?.effectiveProvider).toBe("missing");
  });

  test("diagnoses diversity with each node's resolved provider and model", () => {
    const workflow = makeWorkflow([
      {
        id: "copilot",
        prompt: "Copilot.",
        provider: "copilot",
        model: "deep",
        model_by_provider: { copilot: "gpt-6-sol" },
      },
      {
        id: "first",
        prompt: "First fallback.",
        provider: "missing",
        model: "deep",
        model_by_provider: { copilot: "model-a" },
      },
      {
        id: "second",
        prompt: "Second fallback.",
        provider: "missing",
        model: "deep",
        model_by_provider: { copilot: "model-b" },
      },
    ]);

    const result = resolveWorkflowResolution(workflow, {
      providers: new Map<string, typeof COPILOT_CAPABILITIES | typeof CLAUDE_CAPABILITIES>([
        ["copilot", COPILOT_CAPABILITIES],
        ["claude", CLAUDE_CAPABILITIES],
      ]),
      defaultProviderId: "claude",
    });

    expect(result.collapses).toEqual([
      "catalog-test: no 'claude' entry in model_by_provider for nodes first, second -- all resolve to 'claude-fable-5'; lens/role diversity collapsed on this provider.",
    ]);
  });

  test("falls back from a foreign literal outside the effective provider catalog", () => {
    const result = resolveWorkflowResolution(
      makeWorkflow([{ id: "draft", prompt: "Draft.", model: "gpt-6-sol" }], {
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
      makeWorkflow([{ id: "draft", prompt: "Draft.", model: "gpt-6-sol" }], {
        provider: "copilot",
      }),
      {
        providers: new Map([["copilot", COPILOT_CAPABILITIES]]),
        defaultProviderId: "copilot",
      },
    );

    expect(result.tier).toBe("native");
    expect(result.nodes[0]).toMatchObject({
      model: "gpt-6-sol",
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

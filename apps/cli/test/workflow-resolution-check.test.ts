// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  CopilotClientFactory,
  clearRegistry,
  type ModelInfo,
  registerCopilotProvider,
} from "@keelson/providers";
import {
  type DiscoveryRoot,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from "@keelson/workflows";
import { runWorkflowResolutionCheck } from "../src/checks/workflow-resolution.ts";
import { workflowDiscoveryRoots } from "../src/paths.ts";

const COPILOT_CAPABILITIES = {
  defaultModel: "auto",
  models: ["auto", "fast-model", "balanced-model", "deep-model"],
  modelClasses: { fast: "fast-model", balanced: "balanced-model", deep: "deep-model" },
} as const;
const COLLAPSED_COPILOT_CAPABILITIES = {
  defaultModel: "auto",
  models: ["auto"],
  modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
} as const;
const CLAUDE_CAPABILITIES = {
  defaultModel: "claude-opus-4-8",
  models: ["claude-fable-5", "claude-opus-4-8", "claude-haiku-4-5"],
  modelClasses: {
    fast: "claude-haiku-4-5",
    balanced: "claude-opus-4-8",
    deep: "claude-fable-5",
  },
} as const;

function workflow(
  name: string,
  nodes: Array<Record<string, unknown>>,
  provider?: string,
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name,
    description: "Exercises the workflow resolution doctor check.",
    ...(provider !== undefined ? { provider } : {}),
    nodes,
  });
}

const catalog = [
  workflow("portable", [{ id: "draft", prompt: "Draft.", model: "balanced" }]),
  workflow(
    "pinned-review",
    [
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
    ],
    "copilot",
  ),
];

function discoverWorkflows() {
  return {
    workflows: catalog.map((definition) => ({
      workflow: definition,
      path: `${definition.name}.yaml`,
      source: "bundled" as const,
    })),
    errors: [],
    warnings: [],
  };
}

describe("workflow resolution doctor check", () => {
  test("uses the shared discovery roots unless a directory is explicit", async () => {
    const discoveredRoots: Array<readonly DiscoveryRoot[]> = [];
    const discover = (roots: readonly DiscoveryRoot[]) => {
      discoveredRoots.push(roots);
      return { workflows: [], errors: [], warnings: [] };
    };

    await runWorkflowResolutionCheck({
      discoverWorkflows: discover,
      loadConfig: () => ({}),
      listProviders: () => [],
    });
    await runWorkflowResolutionCheck({
      discoverWorkflows: discover,
      workflowsDir: "/tmp/explicit-workflows",
      loadConfig: () => ({}),
      listProviders: () => [],
    });

    expect(discoveredRoots).toEqual([
      workflowDiscoveryRoots(),
      [{ dir: "/tmp/explicit-workflows", source: "global" }],
    ]);
  });

  test("reports the catalog native when Copilot is registered", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [{ id: "copilot", capabilities: COPILOT_CAPABILITIES }],
      defaultProviderId: "copilot",
    });

    expect(result.category).toBe("workflow-resolution");
    expect(result.checks).toHaveLength(catalog.length);
    expect(result.checks.every(({ status }) => status === "ok")).toBe(true);
    expect(result.checks.every(({ detail }) => detail?.startsWith("native"))).toBe(true);
  });

  test("names provider fallback and diversity collapse on Claude", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [{ id: "claude", capabilities: CLAUDE_CAPABILITIES }],
      defaultProviderId: "claude",
    });

    expect(result.category).toBe("workflow-resolution");
    const pinned = result.checks.find(({ name }) => name === "pinned-review");
    expect(pinned?.status).toBe("warn");
    expect(pinned?.detail).toContain("logic falls back to claude/claude-fable-5");
    expect(pinned?.detail).toContain("lens/role diversity collapsed");
    expect(result.checks.find(({ name }) => name === "portable")?.status).toBe("ok");
  });

  test("honors the workflow provider environment pin before config", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({ defaultProvider: "copilot" }),
      listProviders: () => [
        { id: "copilot", capabilities: COPILOT_CAPABILITIES },
        { id: "claude", capabilities: CLAUDE_CAPABILITIES },
      ],
      envProviderId: " claude ",
    });

    expect(result.checks.find(({ name }) => name === "portable")?.detail).toContain("on claude");
  });

  test("blocks unpinned prompts when the environment pin is not registered", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({ defaultProvider: "copilot" }),
      listProviders: () => [{ id: "copilot", capabilities: COPILOT_CAPABILITIES }],
      envProviderId: "missing",
    });

    const portable = result.checks.find(({ name }) => name === "portable");
    expect(portable?.status).toBe("warn");
    expect(portable?.detail).toContain(
      "blocked — provider 'missing' selected by KEELSON_WORKFLOW_PROVIDER is not registered",
    );
    expect(result.checks.find(({ name }) => name === "pinned-review")?.status).toBe("ok");
  });

  test("blocks unpinned prompts when the environment pins the workflow provider", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({ defaultProvider: "copilot" }),
      listProviders: () => [{ id: "copilot", capabilities: COPILOT_CAPABILITIES }],
      envProviderId: "workflow",
    });

    const portable = result.checks.find(({ name }) => name === "portable");
    expect(portable?.status).toBe("warn");
    expect(portable?.detail).toContain(
      "blocked — provider 'workflow' selected by KEELSON_WORKFLOW_PROVIDER is not registered",
    );
    expect(result.checks.find(({ name }) => name === "pinned-review")?.status).toBe("ok");
  });

  test("blocks prompt workflows when no provider is registered", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: () => [],
    });

    expect(result.category).toBe("workflow-resolution");
    expect(result.checks.every(({ status }) => status === "warn")).toBe(true);
    expect(result.checks.every(({ detail }) => detail?.startsWith("blocked"))).toBe(true);
    expect(result.checks.every(({ hint }) => hint?.includes("provider add"))).toBe(true);
  });

  test("awaits asynchronous provider discovery before resolving classes", async () => {
    const gate = Promise.withResolvers<typeof COPILOT_CAPABILITIES>();
    let settled = false;
    const report = runWorkflowResolutionCheck({
      discoverWorkflows,
      loadConfig: () => ({}),
      listProviders: async () => [{ id: "copilot", capabilities: await gate.promise }],
      defaultProviderId: "copilot",
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(COPILOT_CAPABILITIES);
    const result = await report;
    expect(result.checks.find(({ name }) => name === "portable")?.status).toBe("ok");
    expect(result.checks.some(({ name }) => name === "copilot model classes")).toBe(false);
  });

  test("default discovery waits for the registered Copilot catalog even with no workflows", async () => {
    const original = process.env.KEELSON_PROVIDERS;
    process.env.KEELSON_PROVIDERS = "stub";
    clearRegistry();
    const gate = Promise.withResolvers<ModelInfo[] | null>();
    class CatalogFactory extends CopilotClientFactory {
      override async listModels(): Promise<ModelInfo[] | null> {
        return gate.promise;
      }
    }
    try {
      registerCopilotProvider({
        getCredential: async () => undefined,
        clientFactory: new CatalogFactory(),
      });
      let settled = false;
      const report = runWorkflowResolutionCheck({
        discoverWorkflows: () => ({ workflows: [], errors: [], warnings: [] }),
        loadConfig: () => ({}),
      }).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      gate.resolve([
        { id: "auto" },
        { id: "fast-model", costTier: "low" },
        { id: "balanced-model", costTier: "mid" },
        { id: "deep-model", costTier: "high" },
      ]);
      expect((await report).checks).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.KEELSON_PROVIDERS;
      else process.env.KEELSON_PROVIDERS = original;
      clearRegistry();
    }
  });

  test("warns about collapsed Copilot routing even with no workflows", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows: () => ({ workflows: [], errors: [], warnings: [] }),
      loadConfig: () => ({}),
      listProviders: () => [{ id: "copilot", capabilities: COLLAPSED_COPILOT_CAPABILITIES }],
    });
    expect(result.checks).toEqual([
      {
        name: "copilot model classes",
        status: "warn",
        detail:
          "fast, balanced, and deep all request auto routing; the served model may differ between turns",
        hint: "set distinct copilot.modelClasses entries in config.json",
      },
    ]);
  });

  test("warns for a concrete collapse and for a configured gateway", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows: () => ({ workflows: [], errors: [], warnings: [] }),
      loadConfig: () => ({
        gateways: [{ name: "local", baseUrl: "http://localhost:11434/v1", protocol: "openai" }],
      }),
      listProviders: () => [
        {
          id: "copilot",
          capabilities: {
            defaultModel: "auto",
            models: ["auto", "single"],
            modelClasses: { fast: "single", balanced: "single", deep: "single" },
          },
        },
        {
          id: "local",
          capabilities: {
            defaultModel: "local-model",
            models: ["local-model"],
            modelClasses: {
              fast: "local-model",
              balanced: "local-model",
              deep: "local-model",
            },
          },
        },
      ],
    });
    expect(result.checks.map(({ name }) => name)).toEqual([
      "copilot model classes",
      "local model classes",
    ]);
    expect(result.checks[0]?.detail).toContain("all request 'single'");
    expect(result.checks[1]?.hint).toContain("gateways[].modelClasses");
  });

  test("merges partial overrides and reports collapse only when effective values coincide", async () => {
    const discover = () => ({ workflows: [], errors: [], warnings: [] });
    const repair = await runWorkflowResolutionCheck({
      discoverWorkflows: discover,
      loadConfig: () => ({ copilot: { modelClasses: { deep: "deep-model" } } }),
      listProviders: () => [{ id: "copilot", capabilities: COLLAPSED_COPILOT_CAPABILITIES }],
    });
    expect(repair.checks).toEqual([]);
    const collapse = await runWorkflowResolutionCheck({
      discoverWorkflows: discover,
      loadConfig: () => ({
        copilot: { modelClasses: { fast: "same", balanced: "same", deep: "same" } },
      }),
      listProviders: () => [{ id: "copilot", capabilities: COPILOT_CAPABILITIES }],
    });
    expect(collapse.checks.map(({ name }) => name)).toEqual(["copilot model classes"]);
  });

  test("skips incomplete, empty, and internal provider defaults", async () => {
    const result = await runWorkflowResolutionCheck({
      discoverWorkflows: () => ({ workflows: [], errors: [], warnings: [] }),
      loadConfig: () => ({}),
      listProviders: () => [
        { id: "missing", capabilities: { defaultModel: "", models: [] } },
        { id: "workflow", capabilities: { defaultModel: "same", models: ["same"] } },
      ],
    });
    expect(result.checks).toEqual([]);
  });
});

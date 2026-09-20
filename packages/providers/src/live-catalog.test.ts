import { beforeEach, describe, expect, test } from "bun:test";

import { fetchLiveModelCatalog } from "./live-catalog.ts";
import { clearRegistry, registerProvider } from "./registry.ts";
import type { IAgentProvider, ModelInfo, ProviderCapabilities } from "./types.ts";

const CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  streaming: false,
  tools: false,
  reasoningEffort: false,
  models: ["current-model"],
  defaultModel: "current-model",
};

class CatalogProvider implements IAgentProvider {
  constructor(
    private readonly models: ModelInfo[],
    private readonly failure?: Error,
  ) {}

  getType() {
    return "catalog";
  }

  getCapabilities() {
    return CAPABILITIES;
  }

  async *sendQuery() {
    yield { type: "done" as const };
  }

  async listModels() {
    if (this.failure !== undefined) throw this.failure;
    return this.models;
  }
}

class FallbackCatalogProvider extends CatalogProvider {
  async listModelsLive() {
    return null;
  }
}

beforeEach(() => {
  clearRegistry();
});

describe("fetchLiveModelCatalog", () => {
  test("maps a registered provider to its live model list", async () => {
    const models: ModelInfo[] = [{ id: "current-model", supportedReasoningEfforts: ["high"] }];
    registerProvider({
      id: "live",
      displayName: "Live",
      factory: () => new CatalogProvider(models),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    const result = await fetchLiveModelCatalog(["live", "live"]);

    expect(result).toEqual(new Map([["live", models]]));
  });

  test("maps a provider whose list call throws to null", async () => {
    registerProvider({
      id: "broken",
      displayName: "Broken",
      factory: () => new CatalogProvider([], new Error("offline")),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    expect(await fetchLiveModelCatalog(["broken"])).toEqual(new Map([["broken", null]]));
  });

  test("preserves a live-catalog failure instead of using the picker fallback", async () => {
    registerProvider({
      id: "fallback",
      displayName: "Fallback",
      factory: () => new FallbackCatalogProvider([{ id: "fallback-model" }]),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    expect(await fetchLiveModelCatalog(["fallback"])).toEqual(new Map([["fallback", null]]));
  });

  test("maps an unregistered provider to null", async () => {
    expect(await fetchLiveModelCatalog(["missing"])).toEqual(new Map([["missing", null]]));
  });
});

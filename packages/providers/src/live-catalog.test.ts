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

class LiveCatalogProvider extends CatalogProvider {
  async listModelsLive() {
    return this.listModels();
  }
}

class FallbackCatalogProvider extends CatalogProvider {
  async listModelsLive() {
    return null;
  }
}

class HangingCatalogProvider extends CatalogProvider {
  async listModelsLive() {
    return new Promise<ModelInfo[] | null>(() => {});
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
      factory: () => new LiveCatalogProvider(models),
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
      factory: () => new LiveCatalogProvider([], new Error("offline")),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    expect(await fetchLiveModelCatalog(["broken"])).toEqual(new Map([["broken", null]]));
  });

  test("maps a provider without a live catalog to null", async () => {
    registerProvider({
      id: "picker-only",
      displayName: "Picker only",
      factory: () => new CatalogProvider([{ id: "curated-model" }]),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    expect(await fetchLiveModelCatalog(["picker-only"])).toEqual(new Map([["picker-only", null]]));
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

  test("maps a timed-out live catalog to null", async () => {
    registerProvider({
      id: "hanging",
      displayName: "Hanging",
      factory: () => new HangingCatalogProvider([]),
      capabilities: CAPABILITIES,
      builtIn: false,
    });

    const watchdog = Promise.withResolvers<never>();
    const watchdogTimer = setTimeout(
      () => watchdog.reject(new Error("live catalog did not settle")),
      1_000,
    );
    try {
      expect(
        await Promise.race([
          fetchLiveModelCatalog(["hanging"], { timeoutMs: 1 }),
          watchdog.promise,
        ]),
      ).toEqual(new Map([["hanging", null]]));
    } finally {
      clearTimeout(watchdogTimer);
    }
  });

  test("maps an unregistered provider to null", async () => {
    expect(await fetchLiveModelCatalog(["missing"])).toEqual(new Map([["missing", null]]));
  });
});

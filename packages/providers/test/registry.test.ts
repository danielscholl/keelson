import { beforeEach, describe, expect, it } from "bun:test";
import type { IAgentProvider, ProviderCapabilities } from "../src/index.ts";
import {
  clearRegistry,
  getAgentProvider,
  getProviderInfoList,
  getRegistration,
  isRegisteredProvider,
  registerProvider,
  registerStubProvider,
  UnknownProviderError,
} from "../src/index.ts";

const FAKE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  streaming: false,
  tools: false,
  models: [],
  defaultModel: "",
};

class FakeProvider implements IAgentProvider {
  getType() {
    return "fake";
  }
  getCapabilities() {
    return FAKE_CAPABILITIES;
  }
  async *sendQuery() {
    yield { type: "done" as const };
  }
  async listModels() {
    return FAKE_CAPABILITIES.models.map((id) => ({ id }));
  }
}

beforeEach(() => {
  clearRegistry();
});

describe("registerProvider", () => {
  it("registers a provider", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    });
    expect(isRegisteredProvider("fake")).toBe(true);
  });

  it("throws on duplicate registration", () => {
    const entry = {
      id: "fake",
      displayName: "Fake",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    };
    registerProvider(entry);
    expect(() => registerProvider(entry)).toThrow("already registered");
  });
});

describe("getAgentProvider", () => {
  it("returns provider instance", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    });
    const provider = getAgentProvider("fake");
    expect(provider.getType()).toBe("fake");
  });

  it("throws UnknownProviderError for unregistered id", () => {
    expect(() => getAgentProvider("nope")).toThrow(UnknownProviderError);
  });

  it("UnknownProviderError message lists available providers", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    });
    try {
      getAgentProvider("nope");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownProviderError);
      expect((e as UnknownProviderError).message).toContain("fake");
    }
  });
});

describe("getProviderInfoList", () => {
  it("returns projected info without factory", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake Provider",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: true,
    });
    const list = getProviderInfoList();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("fake");
    expect(list[0]!.displayName).toBe("Fake Provider");
    expect(list[0]!.builtIn).toBe(true);
    expect("factory" in list[0]!).toBe(false);
  });

  it("preserves credentialServiceId when set", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake Provider",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
      credentialServiceId: "test-service",
    });
    const list = getProviderInfoList();
    expect(list[0]!.credentialServiceId).toBe("test-service");
  });

  it("omits credentialServiceId key entirely when unset", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake Provider",
      factory: () => new FakeProvider(),
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    });
    const list = getProviderInfoList();
    // providerInfoSchema is .strict() + .optional() — an explicit undefined
    // would fail validation; the key must be absent.
    expect("credentialServiceId" in list[0]!).toBe(false);
  });

  it("projects capabilities.models through to the info list", () => {
    registerProvider({
      id: "fake",
      displayName: "Fake Provider",
      factory: () => new FakeProvider(),
      capabilities: {
        sessionResume: false,
        streaming: false,
        tools: false,
        models: ["alpha", "beta"],
        defaultModel: "alpha",
      },
      builtIn: false,
    });
    const list = getProviderInfoList();
    expect(list[0]!.capabilities.models).toEqual(["alpha", "beta"]);
    expect(list[0]!.capabilities.defaultModel).toBe("alpha");
  });
});

describe("registerStubProvider", () => {
  it("registers stub provider", () => {
    registerStubProvider();
    expect(isRegisteredProvider("stub")).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    registerStubProvider();
    expect(() => registerStubProvider()).not.toThrow();
  });

  it("stub provider getType returns 'stub'", () => {
    registerStubProvider();
    const provider = getAgentProvider("stub");
    expect(provider.getType()).toBe("stub");
  });

  it("stub sendQuery yields system → text chunks → done", async () => {
    registerStubProvider();
    const provider = getAgentProvider("stub");
    const chunks = [];
    for await (const chunk of provider.sendQuery("hello world", "/tmp")) {
      chunks.push(chunk);
    }
    expect(chunks[0]!.type).toBe("system");
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[chunks.length - 1]!.type).toBe("done");
  });

  it("stub streams one text chunk per token", async () => {
    registerStubProvider();
    const provider = getAgentProvider("stub");
    const chunks = [];
    for await (const chunk of provider.sendQuery("hello world", "/tmp")) {
      chunks.push(chunk);
    }
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks).toHaveLength(2);
  });
});

describe("getRegistration", () => {
  it("returns full registration including factory", () => {
    const factory = () => new FakeProvider();
    registerProvider({
      id: "fake",
      displayName: "Fake",
      factory,
      capabilities: FAKE_CAPABILITIES,
      builtIn: false,
    });
    const reg = getRegistration("fake");
    expect(reg.factory).toBe(factory);
  });

  it("throws UnknownProviderError for unregistered id", () => {
    expect(() => getRegistration("nope")).toThrow(UnknownProviderError);
  });
});

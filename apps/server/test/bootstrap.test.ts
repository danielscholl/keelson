// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearRegistry as clearProviderRegistry,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  registerProvider,
} from "@keelson/providers";
import type { Rib } from "@keelson/shared";
import { DEFAULT_TOOL_DENYLIST } from "@keelson/workflows";
import {
  bootstrapPromptHandler,
  bootstrapRibs,
  parsePromptTimeoutMs,
  parseProviderList,
  parseToolDenylist,
} from "../src/bootstrap.ts";
import { parseRibList } from "../src/ribs.ts";

describe("parseRibList", () => {
  test("unset returns an empty list (no ribs loaded by default)", () => {
    expect(parseRibList(undefined)).toEqual([]);
  });

  test("empty or whitespace-only string returns an empty list", () => {
    expect(parseRibList("")).toEqual([]);
    expect(parseRibList("   ")).toEqual([]);
  });

  test("single id returns a one-element list", () => {
    expect(parseRibList("osdu")).toEqual(["osdu"]);
  });

  test("comma-separated ids return the parsed order", () => {
    expect(parseRibList("cimpl,osdu")).toEqual(["cimpl", "osdu"]);
    expect(parseRibList("osdu,cimpl")).toEqual(["osdu", "cimpl"]);
  });

  test("trims whitespace around each entry", () => {
    expect(parseRibList(" cimpl ,  osdu  ")).toEqual(["cimpl", "osdu"]);
  });

  test("drops empty entries between commas", () => {
    expect(parseRibList("cimpl,,osdu")).toEqual(["cimpl", "osdu"]);
    expect(parseRibList(",cimpl,")).toEqual(["cimpl"]);
  });
});

describe("bootstrapRibs", () => {
  const envBefore = process.env.KEELSON_RIBS;
  afterEach(() => {
    if (envBefore === undefined) delete process.env.KEELSON_RIBS;
    else process.env.KEELSON_RIBS = envBefore;
  });

  function fakeRib(id: string, tools: string[] = []): Rib {
    return {
      id,
      displayName: id,
      registerTools: () => ({ registered: tools }),
    };
  }

  test("returns empty manifest when no ribs are available", () => {
    delete process.env.KEELSON_RIBS;
    expect(bootstrapRibs({ available: {} }).manifests).toEqual([]);
  });

  test("when KEELSON_RIBS is unset, every available rib registers", () => {
    delete process.env.KEELSON_RIBS;
    const { manifests } = bootstrapRibs({
      available: {
        alpha: fakeRib("alpha", ["alpha_one"]),
        beta: fakeRib("beta", ["beta_one", "beta_two"]),
      },
    });
    expect(manifests.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("KEELSON_RIBS restricts to listed ids", () => {
    process.env.KEELSON_RIBS = "alpha";
    const { manifests } = bootstrapRibs({
      available: {
        alpha: fakeRib("alpha", ["alpha_one"]),
        beta: fakeRib("beta", ["beta_one"]),
      },
    });
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
    expect(manifests[0]?.registered).toEqual(["alpha_one"]);
  });

  test("unknown ids in KEELSON_RIBS are skipped (warn-and-continue)", () => {
    process.env.KEELSON_RIBS = "alpha,missing";
    const { manifests } = bootstrapRibs({
      available: { alpha: fakeRib("alpha") },
    });
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
  });

  test("malformed ids in KEELSON_RIBS are rejected by the schema", () => {
    process.env.KEELSON_RIBS = "Alpha,al_pha,alpha";
    const { manifests } = bootstrapRibs({
      available: { alpha: fakeRib("alpha") },
    });
    // Only 'alpha' survives — 'Alpha' (uppercase) and 'al_pha' (underscore)
    // both fail ribIdSchema's lowercase-kebab regex.
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
  });

  test("rib whose self-id diverges from its manifest key throws", () => {
    process.env.KEELSON_RIBS = "alpha";
    expect(() =>
      bootstrapRibs({
        available: { alpha: fakeRib("beta") },
      }),
    ).toThrow(/manifest key 'alpha' declares id 'beta'/);
  });

  test("malformed manifest key throws (embedder bug, not operator typo)", () => {
    // Unset KEELSON_RIBS — active list comes from Object.keys(available),
    // so a bad key would otherwise be silently skipped. Throwing surfaces
    // the embedder's typo at boot instead of leaving the rib inactive.
    delete process.env.KEELSON_RIBS;
    expect(() =>
      bootstrapRibs({
        available: { Alpha: fakeRib("Alpha") },
      }),
    ).toThrow(/manifest key 'Alpha' is invalid/);
  });

  test("disposeAll awaits async disposers in order", async () => {
    delete process.env.KEELSON_RIBS;
    const calls: string[] = [];
    const asyncRib = (id: string, delayMs: number): Rib => ({
      id,
      displayName: id,
      registerTools: () => ({ registered: [] }),
      dispose: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        calls.push(id);
      },
    });
    const { disposeAll } = bootstrapRibs({
      available: {
        // alpha sleeps longer; sequential await means alpha lands first
        // even though beta's wait is shorter.
        alpha: asyncRib("alpha", 30),
        beta: asyncRib("beta", 5),
      },
    });
    await disposeAll();
    expect(calls).toEqual(["alpha", "beta"]);
  });

  test("disposeAll invokes each rib's dispose hook in order", async () => {
    delete process.env.KEELSON_RIBS;
    const calls: string[] = [];
    const ribWithDispose = (id: string): Rib => ({
      id,
      displayName: id,
      registerTools: () => ({ registered: [] }),
      dispose: () => {
        calls.push(id);
      },
    });
    const { disposeAll } = bootstrapRibs({
      available: {
        alpha: ribWithDispose("alpha"),
        beta: ribWithDispose("beta"),
      },
    });
    await disposeAll();
    expect(calls.sort()).toEqual(["alpha", "beta"]);
  });

  test("disposeAll continues past a throwing disposer", async () => {
    delete process.env.KEELSON_RIBS;
    const survived: string[] = [];
    const { disposeAll } = bootstrapRibs({
      available: {
        alpha: {
          id: "alpha",
          displayName: "alpha",
          dispose: () => {
            throw new Error("boom");
          },
        },
        beta: {
          id: "beta",
          displayName: "beta",
          dispose: () => {
            survived.push("beta");
          },
        },
      },
    });
    // Should not reject even though alpha's disposer threw.
    await disposeAll();
    expect(survived).toEqual(["beta"]);
  });
});

describe("parseProviderList", () => {
  const ALL_BUILT_INS = ["stub", "copilot", "claude"];

  test("unset / empty returns all built-ins", () => {
    expect(parseProviderList(undefined)).toEqual(ALL_BUILT_INS);
    expect(parseProviderList("")).toEqual(ALL_BUILT_INS);
    expect(parseProviderList("   ")).toEqual(ALL_BUILT_INS);
  });

  test("single id returns just that provider", () => {
    expect(parseProviderList("stub")).toEqual(["stub"]);
    expect(parseProviderList("claude")).toEqual(["claude"]);
  });

  test("multiple ids preserve order", () => {
    expect(parseProviderList("copilot,claude")).toEqual(["copilot", "claude"]);
  });

  test("unknown id is dropped with a warning, valid ones survive", () => {
    expect(parseProviderList("stub,nope")).toEqual(["stub"]);
  });

  test("case-insensitive match", () => {
    expect(parseProviderList("STUB,Copilot")).toEqual(["stub", "copilot"]);
  });

  test("duplicates collapse to one entry", () => {
    expect(parseProviderList("stub,stub")).toEqual(["stub"]);
  });
});

describe("parseToolDenylist", () => {
  test("unset returns the default denylist (empty in v0)", () => {
    expect(parseToolDenylist(undefined)).toEqual(DEFAULT_TOOL_DENYLIST);
  });

  test("explicit empty string returns an empty array (allow everything)", () => {
    expect(parseToolDenylist("")).toEqual([]);
    expect(parseToolDenylist("   ")).toEqual([]);
  });

  test("comma-separated names are parsed and trimmed", () => {
    expect(parseToolDenylist("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("parsePromptTimeoutMs", () => {
  test("unset returns undefined (handler uses its own default)", () => {
    expect(parsePromptTimeoutMs(undefined)).toBeUndefined();
    expect(parsePromptTimeoutMs("")).toBeUndefined();
  });

  test("positive seconds → milliseconds", () => {
    expect(parsePromptTimeoutMs("60")).toBe(60_000);
    expect(parsePromptTimeoutMs("0.5")).toBe(500);
  });

  test("non-number / zero / negative falls back to undefined", () => {
    expect(parsePromptTimeoutMs("nope")).toBeUndefined();
    expect(parsePromptTimeoutMs("0")).toBeUndefined();
    expect(parsePromptTimeoutMs("-5")).toBeUndefined();
  });
});

describe("bootstrapPromptHandler", () => {
  const envSnapshot = {
    provider: process.env.KEELSON_WORKFLOW_PROVIDER,
    denylist: process.env.KEELSON_WORKFLOW_TOOL_DENYLIST,
    timeout: process.env.KEELSON_WORKFLOW_PROMPT_TIMEOUT_S,
  };

  beforeEach(() => {
    clearProviderRegistry();
  });

  afterEach(() => {
    clearProviderRegistry();
    if (envSnapshot.provider === undefined) delete process.env.KEELSON_WORKFLOW_PROVIDER;
    else process.env.KEELSON_WORKFLOW_PROVIDER = envSnapshot.provider;
    if (envSnapshot.denylist === undefined) delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
    else process.env.KEELSON_WORKFLOW_TOOL_DENYLIST = envSnapshot.denylist;
    if (envSnapshot.timeout === undefined) delete process.env.KEELSON_WORKFLOW_PROMPT_TIMEOUT_S;
    else process.env.KEELSON_WORKFLOW_PROMPT_TIMEOUT_S = envSnapshot.timeout;
  });

  function registerFakeProvider(id: string): void {
    const provider: IAgentProvider = {
      // biome-ignore lint/correctness/useYield: stub returns no chunks
      async *sendQuery(): AsyncGenerator<MessageChunk> {},
    };
    const capabilities: ProviderCapabilities = {
      supportsTools: false,
      supportsImages: false,
      supportsResume: false,
      supportsThinking: false,
      supportsReasoningEffort: false,
    };
    registerProvider({
      id,
      displayName: id,
      builtIn: true,
      capabilities,
      factory: () => provider,
    });
  }

  test("returns undefined when no providers are registered", () => {
    expect(bootstrapPromptHandler()).toBeUndefined();
  });

  test("registered provider yields a usable handler", () => {
    registerFakeProvider("stub");
    const handler = bootstrapPromptHandler();
    expect(handler).toBeDefined();
    expect(handler?.type).toBe("prompt");
  });
});

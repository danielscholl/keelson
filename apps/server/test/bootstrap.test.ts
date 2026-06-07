// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegistry as clearProviderRegistry,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  registerProvider,
} from "@keelson/providers";
import type { Rib, ToolDefinition } from "@keelson/shared";
import { clearRegistry, getRegisteredTools } from "@keelson/skills";
import { DEFAULT_TOOL_DENYLIST } from "@keelson/workflows";
import { z } from "zod";
import {
  bootstrapPromptHandler,
  bootstrapRibs,
  parsePromptTimeoutMs,
  parseProviderList,
  parseToolDenylist,
  registerRibTools,
} from "../src/bootstrap.ts";
import { discoverRibs } from "../src/rib-discovery.ts";
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

  function fakeTool(name: string): ToolDefinition {
    return { name, description: name, inputSchema: z.object({}), execute: async () => {} };
  }

  function fakeRib(id: string, tools: string[] = []): Rib {
    return {
      id,
      displayName: id,
      registerTools: () => tools.map(fakeTool),
    };
  }

  test("returns empty manifest when no ribs are available", async () => {
    delete process.env.KEELSON_RIBS;
    expect((await bootstrapRibs({ available: {} })).manifests).toEqual([]);
  });

  test("when KEELSON_RIBS is unset, every available rib registers", async () => {
    delete process.env.KEELSON_RIBS;
    const { manifests } = await bootstrapRibs({
      available: {
        alpha: fakeRib("alpha", ["alpha_one"]),
        beta: fakeRib("beta", ["beta_one", "beta_two"]),
      },
    });
    expect(manifests.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("KEELSON_RIBS restricts to listed ids", async () => {
    process.env.KEELSON_RIBS = "alpha";
    const { manifests } = await bootstrapRibs({
      available: {
        alpha: fakeRib("alpha", ["alpha_one"]),
        beta: fakeRib("beta", ["beta_one"]),
      },
    });
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
    expect(manifests[0]?.registered).toEqual(["alpha_one"]);
  });

  test("unknown ids in KEELSON_RIBS are skipped (warn-and-continue)", async () => {
    process.env.KEELSON_RIBS = "alpha,missing";
    const { manifests } = await bootstrapRibs({
      available: { alpha: fakeRib("alpha") },
    });
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
  });

  test("malformed tool entries are dropped so GET /api/ribs can't 500", async () => {
    delete process.env.KEELSON_RIBS;
    const ribBadTools = {
      id: "alpha",
      displayName: "alpha",
      // A JS rib could return non-tool entries among valid ones; they must not
      // reach the manifest (listRibsResponseSchema.parse would blank the panel)
      // nor the tool registry.
      registerTools: () => [fakeTool("ok_tool"), 42, null],
    } as unknown as Rib;
    const { manifests, tools } = await bootstrapRibs({ available: { alpha: ribBadTools } });
    expect(manifests[0]?.registered).toEqual(["ok_tool"]);
    expect(tools.map((t) => t.name)).toEqual(["ok_tool"]);
  });

  test("drops a tool whose inputSchema is not a zod schema (would crash the provider adapter)", async () => {
    delete process.env.KEELSON_RIBS;
    const ribBadSchema = {
      id: "alpha",
      displayName: "alpha",
      // inputSchema is a plain object, not a zod schema — the provider adapter
      // would throw on z.toJSONSchema(); it must be skipped at the boundary.
      registerTools: () => [
        { name: "alpha_bad", description: "d", inputSchema: {}, execute: async () => {} },
        fakeTool("alpha_ok"),
      ],
    } as unknown as Rib;
    const { manifests, tools } = await bootstrapRibs({ available: { alpha: ribBadSchema } });
    expect(manifests[0]?.registered).toEqual(["alpha_ok"]);
    expect(tools.map((t) => t.name)).toEqual(["alpha_ok"]);
  });

  test("drops a tool with a non-boolean advisory flag (would 500 /api/tools)", async () => {
    delete process.env.KEELSON_RIBS;
    const ribBadFlag = {
      id: "alpha",
      displayName: "alpha",
      registerTools: () => [
        {
          name: "alpha_flag",
          description: "d",
          inputSchema: z.object({}),
          execute: async () => {},
          state_changing: "true",
        },
      ],
    } as unknown as Rib;
    const { tools } = await bootstrapRibs({ available: { alpha: ribBadFlag } });
    expect(tools).toEqual([]);
  });

  test("a non-array registerTools result doesn't crash bootstrap", async () => {
    delete process.env.KEELSON_RIBS;
    const ribNonArray = {
      id: "alpha",
      displayName: "alpha",
      // A JS rib could return a non-array; the boundary must coerce to [] rather
      // than throw and prevent the server from starting.
      registerTools: () => "tool",
    } as unknown as Rib;
    const { manifests, tools } = await bootstrapRibs({ available: { alpha: ribNonArray } });
    expect(manifests[0]?.registered).toEqual([]);
    expect(tools).toEqual([]);
  });

  test("malformed ids in KEELSON_RIBS are rejected by the schema", async () => {
    process.env.KEELSON_RIBS = "Alpha,al_pha,alpha";
    const { manifests } = await bootstrapRibs({
      available: { alpha: fakeRib("alpha") },
    });
    // Only 'alpha' survives — 'Alpha' (uppercase) and 'al_pha' (underscore)
    // both fail ribIdSchema's lowercase-kebab regex.
    expect(manifests.map((m) => m.id)).toEqual(["alpha"]);
  });

  test("rib whose self-id diverges from its manifest key throws", async () => {
    process.env.KEELSON_RIBS = "alpha";
    await expect(
      bootstrapRibs({
        available: { alpha: fakeRib("beta") },
      }),
    ).rejects.toThrow(/manifest key 'alpha' declares id 'beta'/);
  });

  test("malformed manifest key throws (embedder bug, not operator typo)", async () => {
    // Unset KEELSON_RIBS — active list comes from Object.keys(available),
    // so a bad key would otherwise be silently skipped. Throwing surfaces
    // the embedder's typo at boot instead of leaving the rib inactive.
    delete process.env.KEELSON_RIBS;
    await expect(
      bootstrapRibs({
        available: { Alpha: fakeRib("Alpha") },
      }),
    ).rejects.toThrow(/manifest key 'Alpha' is invalid/);
  });

  test("disposeAll awaits async disposers in order", async () => {
    delete process.env.KEELSON_RIBS;
    const calls: string[] = [];
    const asyncRib = (id: string, delayMs: number): Rib => ({
      id,
      displayName: id,
      registerTools: () => [],
      dispose: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        calls.push(id);
      },
    });
    const { disposeAll } = await bootstrapRibs({
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
      registerTools: () => [],
      dispose: () => {
        calls.push(id);
      },
    });
    const { disposeAll } = await bootstrapRibs({
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
    const { disposeAll } = await bootstrapRibs({
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

  test("rib with composeBundle is auto-registered under the namespaced rib:<id> key", async () => {
    delete process.env.KEELSON_RIBS;
    const { createSnapshotManager } = await import("../src/snapshot-manager.ts");
    const snapshotManager = createSnapshotManager();
    let composeCalls = 0;
    const ribWithBundle: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: () => [],
      composeBundle: async () => {
        composeCalls++;
        return { generation: composeCalls };
      },
    };
    await bootstrapRibs({ available: { alpha: ribWithBundle }, snapshotManager });
    // The composeBundle key is namespaced under rib:<id> (M8), not the bare id.
    expect(snapshotManager.keys()).toEqual(["rib:alpha"]);
    const frame = await snapshotManager.recompose<{ generation: number }>("rib:alpha");
    expect(frame?.data).toEqual({ generation: 1 });
    expect(composeCalls).toBe(1);
  });

  test("ribs without composeBundle are not registered in the snapshot manager", async () => {
    delete process.env.KEELSON_RIBS;
    const { createSnapshotManager } = await import("../src/snapshot-manager.ts");
    const snapshotManager = createSnapshotManager();
    await bootstrapRibs({ available: { alpha: fakeRib("alpha") }, snapshotManager });
    expect(snapshotManager.keys()).toEqual([]);
  });

  test("rib can imperatively register namespaced snapshots from registerTools via RibContext.getSnapshotManager", async () => {
    delete process.env.KEELSON_RIBS;
    const { createSnapshotManager } = await import("../src/snapshot-manager.ts");
    const snapshotManager = createSnapshotManager();
    const multiSnapshotRib: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        const mgr = ctx.getSnapshotManager?.();
        mgr?.register("rib:alpha:partitions", () => ({ count: 3 }));
        mgr?.register("rib:alpha:users", () => ({ count: 12 }));
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: multiSnapshotRib }, snapshotManager });
    expect(snapshotManager.keys().sort()).toEqual(["rib:alpha:partitions", "rib:alpha:users"]);
  });

  test("a rib registering a snapshot key outside its namespace throws at activation", async () => {
    delete process.env.KEELSON_RIBS;
    const { createSnapshotManager } = await import("../src/snapshot-manager.ts");
    const snapshotManager = createSnapshotManager();
    const rogue: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        ctx.getSnapshotManager?.().register("other:key", () => ({}));
        return [];
      },
    };
    await expect(bootstrapRibs({ available: { alpha: rogue }, snapshotManager })).rejects.toThrow(
      /may only register/,
    );
  });

  test("a rib declaring a view key outside its namespace throws at activation", async () => {
    delete process.env.KEELSON_RIBS;
    const ribBadView: Rib = {
      id: "alpha",
      displayName: "alpha",
      views: [{ key: "rib:other:graph", canvasKind: "view" }],
    };
    await expect(bootstrapRibs({ available: { alpha: ribBadView } })).rejects.toThrow(
      /view key .* must be under/,
    );
  });

  test("a rib declaring a malformed action descriptor throws at activation", async () => {
    delete process.env.KEELSON_RIBS;
    const ribBadAction = {
      id: "alpha",
      displayName: "alpha",
      // Missing `label` — would otherwise corrupt the GET /api/ribs response.
      actions: [{ type: "go" }],
    } as unknown as Rib;
    await expect(bootstrapRibs({ available: { alpha: ribBadAction } })).rejects.toThrow();
  });

  test("manifest carries views, actions, and hasOnAction; probes/handlers are returned", async () => {
    delete process.env.KEELSON_RIBS;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      views: [{ key: "rib:alpha:v", canvasKind: "view", title: "V" }],
      actions: [{ type: "go", label: "Go" }],
      onAction: () => ({ ok: true }),
      authStatus: () => ({ authenticated: true }),
    };
    const { manifests, probes, actionHandlers } = await bootstrapRibs({
      available: { alpha: rib },
    });
    expect(manifests[0]?.views).toEqual([{ key: "rib:alpha:v", canvasKind: "view", title: "V" }]);
    expect(manifests[0]?.actions).toEqual([{ type: "go", label: "Go" }]);
    expect(manifests[0]?.hasOnAction).toBe(true);
    expect(await probes.get("alpha")?.()).toEqual({ authenticated: true });
    expect(await actionHandlers.get("alpha")?.({ type: "go" })).toEqual({ ok: true });
  });

  describe("tool registration", () => {
    beforeEach(() => clearRegistry());
    afterEach(() => clearRegistry());

    test("collects tools across ribs and skips a cross-rib name collision", async () => {
      delete process.env.KEELSON_RIBS;
      const { tools, manifests } = await bootstrapRibs({
        available: {
          alpha: fakeRib("alpha", ["alpha_one", "shared_tool"]),
          beta: fakeRib("beta", ["beta_one", "shared_tool"]),
        },
      });
      // alpha activates first and claims shared_tool; beta's copy is skipped.
      expect(tools.map((t) => t.name)).toEqual(["alpha_one", "shared_tool", "beta_one"]);
      expect(manifests.find((m) => m.id === "beta")?.registered).toEqual(["beta_one"]);
    });

    test("registerRibTools exposes a rib's tools through getRegisteredTools", async () => {
      delete process.env.KEELSON_RIBS;
      const { tools } = await bootstrapRibs({
        available: { alpha: fakeRib("alpha", ["alpha_one", "alpha_two"]) },
      });
      registerRibTools(tools);
      expect(
        getRegisteredTools()
          .map((t) => t.name)
          .sort(),
      ).toEqual(["alpha_one", "alpha_two"]);
    });

    test("registerRibTools skips an already-registered name", () => {
      registerRibTools([fakeTool("dup")]);
      registerRibTools([fakeTool("dup")]);
      expect(getRegisteredTools().map((t) => t.name)).toEqual(["dup"]);
    });
  });

  describe("discovery", () => {
    const fixtureRoot = join(import.meta.dir, "fixtures", "rib-discovery");

    test("walks the discovery root and activates a healthy fixture rib", async () => {
      process.env.KEELSON_RIBS = "test";
      const available = await discoverRibs({ root: fixtureRoot });
      const { manifests } = await bootstrapRibs({ available });
      expect(manifests.map((m) => m.id)).toEqual(["test"]);
      expect(manifests[0]?.registered).toEqual(["test.tool"]);
    });

    test("a throwing import warns and skips; healthy ribs still activate", async () => {
      process.env.KEELSON_RIBS = "test,broken";
      const available = await discoverRibs({ root: fixtureRoot });
      const { manifests } = await bootstrapRibs({ available });
      expect(manifests.map((m) => m.id)).toEqual(["test"]);
    });

    test("a non-object default export is skipped", async () => {
      process.env.KEELSON_RIBS = "bad-default";
      const available = await discoverRibs({ root: fixtureRoot });
      const { manifests } = await bootstrapRibs({ available });
      expect(manifests).toEqual([]);
    });

    test("a rib whose declared id doesn't match its package suffix is skipped", async () => {
      // Filter to both candidate ids so neither suffix nor declared id can
      // route past the divergence check.
      process.env.KEELSON_RIBS = "id-mismatch,other";
      const available = await discoverRibs({ root: fixtureRoot });
      const { manifests } = await bootstrapRibs({ available });
      expect(manifests).toEqual([]);
    });

    test("a missing discovery root returns no ribs without throwing", async () => {
      const available = await discoverRibs({ root: join(fixtureRoot, "does-not-exist") });
      expect(available).toEqual({});
    });

    test("a rib whose declared hook is not a function is skipped", async () => {
      process.env.KEELSON_RIBS = "bad-hook";
      const available = await discoverRibs({ root: fixtureRoot });
      const { manifests } = await bootstrapRibs({ available });
      expect(manifests).toEqual([]);
    });

    test("a symlinked rib directory is followed and activated", async () => {
      process.env.KEELSON_RIBS = "test";
      const tempRoot = await mkdtemp(join(tmpdir(), "keelson-discovery-"));
      try {
        await symlink(join(fixtureRoot, "rib-test"), join(tempRoot, "rib-test"), "dir");
        const available = await discoverRibs({ root: tempRoot });
        const { manifests } = await bootstrapRibs({ available });
        expect(manifests.map((m) => m.id)).toEqual(["test"]);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
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

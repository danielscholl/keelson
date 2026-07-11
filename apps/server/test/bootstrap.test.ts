// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegistry as clearProviderRegistry,
  getProviderInfoList,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  registerProvider,
} from "@keelson/providers";
import type {
  MemoryTools,
  OpHandle,
  Project,
  RecallRequest,
  RecallResponse,
  RegisterOpRequest,
  Rib,
  ToolDefinition,
  WritebackRequest,
  WritebackResponse,
} from "@keelson/shared";
import {
  RECALL_REQUEST_SCHEMA_VERSION,
  RECALL_RESPONSE_SCHEMA_VERSION,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
  WRITEBACK_RESPONSE_SCHEMA_VERSION,
} from "@keelson/shared";
import { clearRegistry, getRegisteredTools } from "@keelson/skills";
import { DEFAULT_TOOL_DENYLIST } from "@keelson/workflows";
import { z } from "zod";
import {
  bootstrapPolicyEngine,
  bootstrapPromptHandler,
  bootstrapProviders,
  bootstrapRibs,
  isCrossRibGrantAllowed,
  parseCrossRibGrants,
  parsePromptTimeoutMs,
  parseToolDenylist,
  registerRibTools,
} from "../src/bootstrap.ts";
import type { MemoryStore } from "../src/memory-store.ts";
import { discoverRibs } from "../src/rib-discovery.ts";
import { applyRibs, parseRibList } from "../src/ribs.ts";

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

describe("parseCrossRibGrants", () => {
  function entries(raw: string | undefined) {
    return Array.from(parseCrossRibGrants(raw), ([caller, targets]) => [
      caller,
      Array.from(targets, ([target, tools]) => [target, [...tools].sort()]),
    ]);
  }

  test("unset or empty grants no cross-rib access", () => {
    expect(entries(undefined)).toEqual([]);
    expect(entries("")).toEqual([]);
    expect(entries("   ")).toEqual([]);
  });

  test("parses caller target tool triples", () => {
    expect(entries("caller:provider:probe_tool,other_tool;caller2:target:third_tool")).toEqual([
      ["caller", [["provider", ["other_tool", "probe_tool"]]]],
      ["caller2", [["target", ["third_tool"]]]],
    ]);
  });

  test("trims whitespace and ignores empty or malformed segments", () => {
    expect(entries(" caller : provider : probe_tool , ; ; bad ; a:b:c:d ")).toEqual([
      ["caller", [["provider", ["probe_tool"]]]],
    ]);
  });

  test("supports target-wide wildcard sugar", () => {
    const grants = parseCrossRibGrants("caller:provider:*");

    expect(isCrossRibGrantAllowed(grants, "caller", "provider", "probe_tool")).toBe(true);
    expect(isCrossRibGrantAllowed(grants, "caller", "other", "probe_tool")).toBe(false);
    expect(isCrossRibGrantAllowed(grants, "other", "provider", "probe_tool")).toBe(false);
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

  test("contributeDocs sources are collected and stamped with the owning rib id", async () => {
    delete process.env.KEELSON_RIBS;
    const docsRib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      contributeDocs: () => [
        { title: "Chamber", summary: "generative rooms", llmsFullUrl: "https://example/full.txt" },
      ],
    };
    const { docsContributions } = await bootstrapRibs({ available: { chamber: docsRib } });
    expect(docsContributions).toEqual([
      {
        ribId: "chamber",
        source: {
          title: "Chamber",
          summary: "generative rooms",
          llmsFullUrl: "https://example/full.txt",
        },
      },
    ]);
  });

  test("a docs source with neither a URL nor content is dropped (schema-gated)", async () => {
    delete process.env.KEELSON_RIBS;
    const badRib = {
      id: "alpha",
      displayName: "alpha",
      contributeDocs: () => [{ title: "Alpha", summary: "no corpus" }],
    } as unknown as Rib;
    const { docsContributions } = await bootstrapRibs({ available: { alpha: badRib } });
    expect(docsContributions).toEqual([]);
  });

  test("a non-array contributeDocs return is ignored", async () => {
    delete process.env.KEELSON_RIBS;
    const badRib = {
      id: "alpha",
      displayName: "alpha",
      contributeDocs: () => ({ title: "Alpha", summary: "x", content: "# T\n\nbody" }),
    } as unknown as Rib;
    const { docsContributions } = await bootstrapRibs({ available: { alpha: badRib } });
    expect(docsContributions).toEqual([]);
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
    // The composeBundle key is namespaced under rib:<id>, not the bare id.
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

  test("getProjects forwards to the rib and, like the composition root's late-bound store, reads it at call time", async () => {
    delete process.env.KEELSON_RIBS;
    // Mirror index.ts: `getProjects: () => projectsStoreRef?.list() ?? []`, where the
    // store ref is assigned AFTER bootstrapRibs. So a rib reading projects
    // synchronously in registerTools (before the store is wired) sees [], while a
    // turn-time read sees the live list — project selection is a runtime concern.
    let storeRef: { list: () => readonly Project[] } | undefined;
    const projects: Project[] = [
      {
        id: "p1",
        name: "alpha-app",
        rootPath: "/repos/alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    let seenAtActivation: readonly Project[] | undefined;
    let accessor: (() => readonly Project[]) | undefined;
    const reader: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        seenAtActivation = ctx.getProjects?.();
        accessor = ctx.getProjects;
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: reader },
      getProjects: () => storeRef?.list() ?? [],
    });
    expect(seenAtActivation).toEqual([]); // store not yet wired during activation
    storeRef = { list: () => projects };
    expect(accessor?.()).toEqual(projects); // turn-time read sees the live store
  });

  test("getProjects reflects the source at call time, not activation time", async () => {
    delete process.env.KEELSON_RIBS;
    // The composition root backs this with a late-bound store read, so a rib that
    // calls it at convene/turn time (long after registerTools) must see the live
    // list, not a snapshot frozen at activation.
    const live: Project[] = [];
    let accessor: (() => readonly Project[]) | undefined;
    const reader: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        accessor = ctx.getProjects;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: reader }, getProjects: () => live });
    expect(accessor?.()).toEqual([]);
    live.push({
      id: "p1",
      name: "later",
      rootPath: "/repos/later",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    expect(accessor?.()).toEqual(live);
  });

  test("acquireWorkspace forwards to the late-bound manager with a rib-scoped owner", async () => {
    delete process.env.KEELSON_RIBS;
    let managerRef:
      | { acquire: (req: Record<string, unknown>) => Promise<Record<string, unknown>> }
      | undefined;
    const acquireCalls: Record<string, unknown>[] = [];
    let released = 0;
    let accessor:
      | ((req: { projectId: string; purpose: string; branch?: string }) => Promise<{
          id: string;
          path: string;
          branch: string;
          release: () => Promise<void>;
        }>)
      | undefined;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        accessor = ctx.acquireWorkspace;
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: rib },
      getWorkspaceManager: () => managerRef as never,
    });
    expect(accessor).toBeDefined();
    // Manager not yet wired (late-bound): the seam fails with a clear error.
    await expect(
      accessor?.({ projectId: "p1", purpose: "test" }) ?? Promise.resolve(),
    ).rejects.toThrow("workspace manager unavailable");
    managerRef = {
      acquire: async (req) => {
        acquireCalls.push(req);
        return {
          id: "lease-1",
          path: "/tmp/wt",
          branch: "keelson/lease/test",
          release: async () => {
            released += 1;
          },
        };
      },
    };
    const lease = await accessor?.({ projectId: "p1", purpose: "test", branch: "custom" });
    expect(acquireCalls).toEqual([
      { projectId: "p1", purpose: "test", owner: "rib:alpha", branch: "custom" },
    ]);
    await lease?.release();
    expect(released).toBe(1);
  });

  test("RibContext.acquireWorkspace is absent when no manager source is supplied", async () => {
    delete process.env.KEELSON_RIBS;
    let hasSeam = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasSeam = ctx.acquireWorkspace !== undefined;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: probe } });
    expect(hasSeam).toBe(false);
  });

  test("registerOp forwards to the late-bound registry with a rib-scoped owner", async () => {
    delete process.env.KEELSON_RIBS;
    let registryRef: { register: (owner: string, req: RegisterOpRequest) => OpHandle } | undefined;
    const registerCalls: Array<{ owner: string; req: RegisterOpRequest }> = [];
    let accessor: ((req: RegisterOpRequest) => OpHandle) | undefined;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        accessor = ctx.registerOp;
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: rib },
      getOpRegistry: () => registryRef as never,
    });
    expect(accessor).toBeDefined();
    // Registry not yet wired (late-bound): the seam throws synchronously with a
    // clear error rather than returning a dead handle.
    expect(() => accessor?.({ kind: "demo" })).toThrow("op registry unavailable");

    const ac = new AbortController();
    registryRef = {
      register: (owner, req) => {
        registerCalls.push({ owner, req });
        return {
          id: "op-1",
          signal: ac.signal,
          log: () => {},
          progress: () => {},
          done: () => {},
          error: () => {},
        };
      },
    };
    const handle = accessor?.({ kind: "demo", title: "t" });
    expect(handle?.id).toBe("op-1");
    expect(registerCalls).toEqual([{ owner: "rib:alpha", req: { kind: "demo", title: "t" } }]);
  });

  test("RibContext.registerOp is absent when no registry source is supplied", async () => {
    delete process.env.KEELSON_RIBS;
    let hasSeam = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasSeam = ctx.registerOp !== undefined;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: probe } });
    expect(hasSeam).toBe(false);
  });

  test("acquireMutationLock forwards to the late-bound manager with a rib-scoped owner", async () => {
    delete process.env.KEELSON_RIBS;
    let managerRef:
      | { acquire: (req: Record<string, unknown>) => { id: string; release: () => Promise<void> } }
      | undefined;
    const acquireCalls: Record<string, unknown>[] = [];
    let released = 0;
    let accessor:
      | ((req: { projectId: string; purpose: string }) => Promise<{
          id: string;
          release: () => Promise<void>;
        }>)
      | undefined;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        accessor = ctx.acquireMutationLock;
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: rib },
      getProjects: () => [
        { id: "p1", name: "p1", rootPath: "/repos/p1", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      getMutationLockManager: () => managerRef as never,
    });
    expect(accessor).toBeDefined();
    // Manager not yet wired (late-bound): the seam fails with a clear error.
    await expect(
      accessor?.({ projectId: "p1", purpose: "test" }) ?? Promise.resolve(),
    ).rejects.toThrow("mutation lock manager unavailable");
    managerRef = {
      acquire: (req) => {
        acquireCalls.push(req);
        return {
          id: "lock-1",
          release: async () => {
            released += 1;
          },
        };
      },
    };
    const lock = await accessor?.({ projectId: "p1", purpose: "guarded" });
    // Owner is rib-scoped; a mutation lock carries no branch (unlike a workspace lease).
    expect(acquireCalls).toEqual([{ projectId: "p1", purpose: "guarded", owner: "rib:alpha" }]);
    expect(lock?.id).toBe("lock-1");
    await lock?.release();
    expect(released).toBe(1);
  });

  test("acquireMutationLock rejects a projectId that is not a known project", async () => {
    delete process.env.KEELSON_RIBS;
    let acquired = 0;
    let accessor:
      | ((req: { projectId: string; purpose: string }) => Promise<{
          id: string;
          release: () => Promise<void>;
        }>)
      | undefined;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        accessor = ctx.acquireMutationLock;
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: rib },
      getProjects: () => [
        {
          id: "known",
          name: "known",
          rootPath: "/repos/known",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      getMutationLockManager: () =>
        ({
          acquire: () => {
            acquired += 1;
            return { id: "lock-1", release: async () => {} };
          },
        }) as never,
    });
    // A phantom project is rejected before the manager is ever called.
    await expect(accessor?.({ projectId: "ghost", purpose: "x" })).rejects.toThrow(
      "unknown project 'ghost'",
    );
    expect(acquired).toBe(0);
    // A known project still acquires.
    const lock = await accessor?.({ projectId: "known", purpose: "x" });
    expect(lock?.id).toBe("lock-1");
    expect(acquired).toBe(1);
  });

  test("acquireMutationLock fails closed (no seam) when a manager is wired but no projects source", async () => {
    delete process.env.KEELSON_RIBS;
    let hasSeam = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasSeam = ctx.acquireMutationLock !== undefined;
        return [];
      },
    };
    // Without a projects source the seam cannot validate a projectId, so it is
    // withheld rather than granting unvalidated (phantom-key) locks.
    await bootstrapRibs({
      available: { alpha: probe },
      getMutationLockManager: () =>
        ({ acquire: () => ({ id: "l", release: async () => {} }) }) as never,
    });
    expect(hasSeam).toBe(false);
  });

  test("RibContext.acquireMutationLock is absent when no manager source is supplied", async () => {
    delete process.env.KEELSON_RIBS;
    let hasSeam = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasSeam = ctx.acquireMutationLock !== undefined;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: probe } });
    expect(hasSeam).toBe(false);
  });

  test("RibContext.getProjects is absent when no projects source is supplied", async () => {
    delete process.env.KEELSON_RIBS;
    let hasAccessor = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasAccessor = ctx.getProjects !== undefined;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: probe } });
    expect(hasAccessor).toBe(false);
  });

  test("getProviders forwards the injected provider list to the rib ctx", async () => {
    delete process.env.KEELSON_RIBS;
    const providers = [
      { id: "claude", displayName: "Claude" },
      { id: "copilot", displayName: "Copilot" },
    ];
    let seen: readonly { id: string; displayName: string }[] | undefined;
    const reader: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        seen = ctx.getProviders?.();
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: reader }, getProviders: () => providers });
    expect(seen).toEqual(providers);
  });

  test("getProviders defaults to the live registry and reads it at call time", async () => {
    delete process.env.KEELSON_RIBS;
    // This block doesn't otherwise manage the provider registry, so own the state for
    // this one test and restore it afterward.
    clearProviderRegistry();
    const capabilities: ProviderCapabilities = {
      supportsTools: false,
      supportsImages: false,
      supportsResume: false,
      supportsThinking: false,
      supportsReasoningEffort: false,
    };
    const fakeProvider: IAgentProvider = {
      async *sendQuery(): AsyncGenerator<MessageChunk> {},
    };
    const register = (id: string, displayName: string): void =>
      registerProvider({
        id,
        displayName,
        builtIn: true,
        capabilities,
        factory: () => fakeProvider,
      });
    try {
      register("alpha-prov", "Alpha Provider");
      let accessor: (() => readonly { id: string; displayName: string }[]) | undefined;
      const reader: Rib = {
        id: "alpha",
        displayName: "alpha",
        registerTools: (ctx) => {
          accessor = ctx.getProviders;
          return [];
        },
      };
      // No getProviders override → the seam defaults to the live registry.
      await bootstrapRibs({ available: { alpha: reader } });
      // Reflects the registry, mapped to the {id, displayName} shape — not [] or broken.
      expect(accessor?.()).toEqual([{ id: "alpha-prov", displayName: "Alpha Provider" }]);
      // Late-binding: a provider registered AFTER bootstrap appears on the next call,
      // proving the default reads at call time rather than snapshotting at activation.
      register("beta-prov", "Beta Provider");
      expect(accessor?.()).toEqual([
        { id: "alpha-prov", displayName: "Alpha Provider" },
        { id: "beta-prov", displayName: "Beta Provider" },
      ]);
    } finally {
      clearProviderRegistry();
    }
  });

  test("getMemory forwards recall/writeback to the store and, like getProjects, reads it at call time", async () => {
    delete process.env.KEELSON_RIBS;
    // Mirror index.ts: `getMemoryStore: () => memoryStoreRef`, where the store ref is
    // assigned AFTER bootstrapRibs (it needs the db). So a turn-time recall/writeback
    // reaches the live store; the seam re-parses the request at the adapter boundary.
    const recallCalls: RecallRequest[] = [];
    const writebackCalls: WritebackRequest[] = [];
    const recallResponse: RecallResponse = {
      schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
      requestId: "req-1",
      items: [],
      trace: { traceId: "trace-1", returned: 0 },
    };
    const writebackResponse: WritebackResponse = {
      schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
      written: [{ memoryId: "m1", idempotencyKey: "idem-1" }],
      blocked: [],
      deduped: [],
    };
    const fakeStore = {
      recall(req: RecallRequest): RecallResponse {
        recallCalls.push(req);
        return recallResponse;
      },
      writeback(req: WritebackRequest): WritebackResponse {
        writebackCalls.push(req);
        return writebackResponse;
      },
    };
    let storeRef: typeof fakeStore | undefined;
    let memory: MemoryTools | undefined;
    const reader: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        memory = ctx.getMemory?.();
        return [];
      },
    };
    await bootstrapRibs({
      available: { alpha: reader },
      getMemoryStore: () => storeRef as unknown as MemoryStore | undefined,
    });
    expect(memory).toBeDefined();

    // Fail-closed before the store is wired: the seam throws so the rib's wrapper can
    // fail soft. getMemoryStore() is read fresh per call, so wiring the store afterward
    // lets the same handle route a recall/writeback through and round-trip.
    const recallReq: RecallRequest = {
      schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
      scope: { visibility: "project", projectId: "p1" },
      task: { runtime: "rib:alpha" },
      query: "team decisions and lessons",
    };
    await expect(memory?.recall(recallReq)).rejects.toThrow("memory store unavailable");
    expect(recallCalls).toHaveLength(0);

    storeRef = fakeStore;
    expect(await memory?.recall(recallReq)).toEqual(recallResponse);
    expect(recallCalls).toHaveLength(1);

    const writebackReq: WritebackRequest = {
      schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
      idempotencyKey: "idem-1",
      scope: { visibility: "project", projectId: "p1" },
      task: { runtime: "rib:alpha" },
      memories: [
        { type: "decision", summary: "shipped X", content: "we decided X", contentHash: "h1" },
      ],
    };
    expect(await memory?.writeback(writebackReq)).toEqual(writebackResponse);
    expect(writebackCalls).toHaveLength(1);
    // The seam re-parses, so the store sees provenance/sourceRefs/artifacts defaulted in.
    expect(writebackCalls[0]?.memories[0]?.provenance).toBe("generated");
  });

  test("RibContext.getMemory is absent when no memory store source is supplied", async () => {
    delete process.env.KEELSON_RIBS;
    let hasAccessor = true;
    const probe: Rib = {
      id: "alpha",
      displayName: "alpha",
      registerTools: (ctx) => {
        hasAccessor = ctx.getMemory !== undefined;
        return [];
      },
    };
    await bootstrapRibs({ available: { alpha: probe } });
    expect(hasAccessor).toBe(false);
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

  test("manifest carries views and hasOnAction; probes/handlers are returned", async () => {
    delete process.env.KEELSON_RIBS;
    const rib: Rib = {
      id: "alpha",
      displayName: "alpha",
      views: [{ key: "rib:alpha:v", canvasKind: "view", title: "V" }],
      onAction: () => ({ ok: true }),
      authStatus: () => ({ authenticated: true }),
      acceptsIngest: true,
    };
    const { manifests, probes, actionHandlers } = await bootstrapRibs({
      available: { alpha: rib },
    });
    expect(manifests[0]?.views).toEqual([{ key: "rib:alpha:v", canvasKind: "view", title: "V" }]);
    expect(manifests[0]?.hasOnAction).toBe(true);
    expect(manifests[0]?.acceptsIngest).toBe(true);
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

    test("binds collected tool ownership to the registering rib id", () => {
      const result = applyRibs({
        active: ["alpha", "beta"],
        available: {
          alpha: fakeRib("alpha", ["alpha_one"]),
          beta: fakeRib("beta", ["beta_one"]),
        },
        ctx: {
          getExec: () => ({
            runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
            runText: async () => ({ ok: true as const, data: "" }),
          }),
        },
      });

      expect(Array.from(result.toolOwners.entries()).sort()).toEqual([
        ["alpha_one", "alpha"],
        ["beta_one", "beta"],
      ]);
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

describe("bootstrapProviders", () => {
  const envBeforeProviders = process.env.KEELSON_PROVIDERS;
  const envBeforeConfig = process.env.KEELSON_CONFIG;
  const noCredential = async () => undefined;
  const ids = () => getProviderInfoList().map((p) => p.id);
  let tempConfigDir: string | undefined;

  beforeEach(async () => {
    clearProviderRegistry();
    tempConfigDir = await mkdtemp(join(tmpdir(), "keelson-bootstrap-providers-"));
    process.env.KEELSON_CONFIG = join(tempConfigDir, "config.json");
  });
  afterEach(async () => {
    clearProviderRegistry();
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = undefined;
    }
    if (envBeforeProviders === undefined) delete process.env.KEELSON_PROVIDERS;
    else process.env.KEELSON_PROVIDERS = envBeforeProviders;
    if (envBeforeConfig === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBeforeConfig;
  });

  test("default set registers copilot only (stub, claude opt-in) and defaults to copilot", () => {
    delete process.env.KEELSON_PROVIDERS;
    const res = bootstrapProviders({ getCredential: noCredential });
    expect(ids()).toContain("copilot");
    expect(ids()).not.toContain("stub");
    expect(ids()).not.toContain("claude");
    expect(res.defaultProvider).toBe("copilot");
  });

  test("KEELSON_PROVIDERS overrides to exactly the listed set", () => {
    process.env.KEELSON_PROVIDERS = "claude";
    const res = bootstrapProviders({ getCredential: noCredential });
    // 'workflow' is the always-on synthetic provider; ignore it for the set check.
    expect(ids().filter((id) => id !== "workflow")).toEqual(["claude"]);
    expect(res.defaultProvider).toBe("claude");
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

describe("bootstrapPolicyEngine", () => {
  const envBefore = process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
  afterEach(() => {
    if (envBefore === undefined) delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
    else process.env.KEELSON_WORKFLOW_TOOL_DENYLIST = envBefore;
  });

  test("folds KEELSON_WORKFLOW_TOOL_DENYLIST into the engine's tool_denylist builtin", async () => {
    process.env.KEELSON_WORKFLOW_TOOL_DENYLIST = "kube_delete_cluster, secrets_reveal";
    const engine = bootstrapPolicyEngine();
    const { allowed, denied } = await engine.projectTools(
      [{ name: "kube_delete_cluster" }, { name: "repo_get_state" }, { name: "secrets_reveal" }],
      { surface: "workflow" },
    );
    expect(allowed.map((t) => t.name)).toEqual(["repo_get_state"]);
    expect(denied.map((d) => d.tool).sort()).toEqual(["kube_delete_cluster", "secrets_reveal"]);
  });

  test("unset env still applies the DEFAULT_TOOL_DENYLIST floor (empty today → passthrough)", async () => {
    delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
    const engine = bootstrapPolicyEngine();
    const { allowed } = await engine.projectTools([{ name: "a" }, { name: "b" }], {
      surface: "workflow",
    });
    // The floor is exactly DEFAULT_TOOL_DENYLIST (empty), so nothing is dropped —
    // the union in bootstrapPolicyEngine must not invent denials.
    expect(allowed.map((t) => t.name)).toEqual(["a", "b"]);
    expect(DEFAULT_TOOL_DENYLIST).toEqual([]);
  });

  test("rib-contributed policies are folded in alongside the denylist floor", async () => {
    delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
    const engine = bootstrapPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "no-genesis",
            on: [{ phase: "tool_call" }],
            evaluate: (e) =>
              e.phase === "tool_call" && e.tool === "genesis"
                ? { outcome: "deny", reason: "gated" }
                : { outcome: "allow" },
          },
        },
      ],
    });
    const { allowed } = await engine.projectTools([{ name: "lens" }, { name: "genesis" }], {
      surface: "rib",
      ribId: "chamber",
    });
    expect(allowed.map((t) => t.name)).toEqual(["lens"]);
  });
});

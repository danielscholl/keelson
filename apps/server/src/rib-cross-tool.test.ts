// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallToolResult, Rib, RibContext, ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { bootstrapRibs, resolveCrossRibGrants } from "./bootstrap.ts";
import type { PolicyEngine } from "./policy-engine.ts";

type CapturedCallTool = NonNullable<RibContext["callTool"]>;

let originalGrants: string | undefined;

beforeEach(() => {
  originalGrants = process.env.KEELSON_CROSS_RIB_GRANTS;
  delete process.env.KEELSON_CROSS_RIB_GRANTS;
});

afterEach(() => {
  if (originalGrants === undefined) delete process.env.KEELSON_CROSS_RIB_GRANTS;
  else process.env.KEELSON_CROSS_RIB_GRANTS = originalGrants;
});

function policyEngine(
  evaluateToolCall: PolicyEngine["evaluateToolCall"] = async () => ({ outcome: "allow" }),
): PolicyEngine {
  return {
    projectTools: async (candidates) => ({ allowed: [...candidates], denied: [] }),
    evaluateToolCall,
    evaluateRequest: async () => ({ outcome: "allow" }),
    evaluateToolResult: async () => ({ outcome: "allow" }),
    evaluateResponse: async () => ({ outcome: "allow" }),
    requestPhaseActive: false,
    resultPhaseActive: false,
    responsePhaseActive: false,
  };
}

function tool(
  name: string,
  onExecute: (ctx: Pick<ToolContext, "abortSignal" | "emit">) => unknown | Promise<unknown>,
) {
  return {
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    execute: async (_input, ctx) => {
      await onExecute(ctx);
    },
  } satisfies ToolDefinition;
}

function providerRib(id: string, tools: readonly ToolDefinition[]): Rib {
  return {
    id,
    displayName: id,
    registerTools: () => [...tools],
  };
}

async function bootWithCaller(
  available: Record<string, Rib>,
  getPolicyEngine = () => policyEngine(),
) {
  let callTool: CapturedCallTool | undefined;
  const caller: Rib = {
    id: "caller",
    displayName: "caller",
    registerTools: (ctx) => {
      callTool = ctx.callTool;
      return [];
    },
  };
  await bootstrapRibs({
    available: { ...available, caller },
    getPolicyEngine,
    // Grants from this test's own env and nothing else. Left to resolve on its
    // own, bootstrapRibs would read the developer's real config.json, where a
    // durable grant could turn the default-deny assertions below green.
    crossRibGrants: resolveCrossRibGrants({}, process.env),
  });
  if (!callTool) throw new Error("callTool was not captured");
  return callTool;
}

describe("cross-rib callTool", () => {
  test("denies by default and does not execute the provider tool", async () => {
    let executed = 0;
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [tool("probe_tool", () => executed++)]),
    });

    const result = await callTool("provider", "probe_tool", {});

    expect(result.ok).toBe(false);
    expect(executed).toBe(0);
  });

  test("runs an owned tool when the caller has a matching per-tool grant and policy allows", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let executed = 0;
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [
        tool("probe_tool", (ctx) => {
          executed++;
          ctx.emit({ type: "tool_result", toolUseId: "", content: "ok" });
        }),
      ]),
    });

    const result = await callTool("provider", "probe_tool", {});

    expect(result).toEqual({
      ok: true,
      chunks: [{ type: "tool_result", toolUseId: "", content: "ok" }],
    } satisfies CallToolResult);
    expect(executed).toBe(1);
  });

  test("includes caller and target rib ids in policy evaluation", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    const seen: unknown[] = [];
    const callTool = await bootWithCaller(
      {
        provider: providerRib("provider", [tool("probe_tool", () => {})]),
      },
      () =>
        policyEngine(async (call, base) => {
          seen.push({ call, base });
          return { outcome: "allow" };
        }),
    );

    await callTool("provider", "probe_tool", {});

    expect(seen).toEqual([
      {
        call: { tool: "probe_tool", args: {} },
        base: {
          surface: "rib",
          ribId: "caller",
          targetRibId: "provider",
          cwd: process.cwd(),
          signal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  test("target wildcard grants only tools owned by that target", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:*";
    let providerExecuted = 0;
    let thirdExecuted = 0;
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [tool("provider_tool", () => providerExecuted++)]),
      third: providerRib("third", [tool("third_tool", () => thirdExecuted++)]),
    });

    const allowed = await callTool("provider", "provider_tool", {});
    const denied = await callTool("third", "third_tool", {});

    expect(allowed.ok).toBe(true);
    expect(denied.ok).toBe(false);
    expect(providerExecuted).toBe(1);
    expect(thirdExecuted).toBe(0);
  });

  test("unknown tools resolve to denial without throwing", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:missing_tool";
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [tool("probe_tool", () => {})]),
    });

    await expect(callTool("provider", "missing_tool", {})).resolves.toMatchObject({ ok: false });
  });

  test("does not call a tool owned by a different rib through the requested target", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:*";
    let executed = 0;
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [tool("provider_tool", () => {})]),
      third: providerRib("third", [tool("third_tool", () => executed++)]),
    });

    const result = await callTool("provider", "third_tool", {});

    expect(result.ok).toBe(false);
    expect(executed).toBe(0);
  });

  test("policy gate faults fail closed", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let executed = 0;
    const callTool = await bootWithCaller(
      {
        provider: providerRib("provider", [tool("probe_tool", () => executed++)]),
      },
      () =>
        policyEngine(async () => {
          throw new Error("gate failed");
        }),
    );

    const result = await callTool("provider", "probe_tool", {});

    expect(result.ok).toBe(false);
    expect(executed).toBe(0);
  });

  test("times out a never-resolving target tool", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [
        tool("probe_tool", async () => {
          await new Promise(() => {});
        }),
      ]),
    });

    const result = await callTool("provider", "probe_tool", {}, { timeoutMs: 5 });

    expect(result).toMatchObject({
      ok: false,
      error: "cross-rib call 'caller' -> 'provider:probe_tool' timed out after 5ms",
    });
  });

  test("aborts the target tool context on timeout", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let observedAbort = false;
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [
        tool("probe_tool", async (ctx) => {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          await new Promise(() => {});
        }),
      ]),
    });

    const result = await callTool("provider", "probe_tool", {}, { timeoutMs: 5 });

    expect(result.ok).toBe(false);
    expect(observedAbort).toBe(true);
  });

  test("forwards a caller abort signal into the target tool context", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let observedAbort = false;
    const caller = new AbortController();
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [
        tool("probe_tool", async (ctx) => {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          await new Promise(() => {});
        }),
      ]),
    });
    const timer = setTimeout(() => caller.abort(), 5);

    const result = await callTool("provider", "probe_tool", {}, { signal: caller.signal });
    clearTimeout(timer);

    expect(result).toMatchObject({
      ok: false,
      error: "cross-rib call 'caller' -> 'provider:probe_tool' aborted by caller",
    });
    expect(observedAbort).toBe(true);
  });

  test("bounds a hanging policy ASK by the call timeout", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let executed = 0;
    const callTool = await bootWithCaller(
      {
        provider: providerRib("provider", [tool("probe_tool", () => executed++)]),
      },
      () =>
        policyEngine(async (_call, base) => {
          await new Promise<void>((resolve) => {
            if (base.signal?.aborted) return resolve();
            base.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { outcome: "deny", reason: "ask expired" };
        }),
    );

    const result = await callTool("provider", "probe_tool", {}, { timeoutMs: 5 });

    expect(result).toMatchObject({
      ok: false,
      error: "cross-rib call 'caller' -> 'provider:probe_tool' timed out after 5ms",
    });
    expect(executed).toBe(0);
  });

  test("cancels a pending policy ASK on caller abort", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    let executed = 0;
    const caller = new AbortController();
    const callTool = await bootWithCaller(
      {
        provider: providerRib("provider", [tool("probe_tool", () => executed++)]),
      },
      () =>
        policyEngine(async (_call, base) => {
          await new Promise<void>((resolve) => {
            if (base.signal?.aborted) return resolve();
            base.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { outcome: "allow" };
        }),
    );
    const timer = setTimeout(() => caller.abort(), 5);

    const result = await callTool("provider", "probe_tool", {}, { signal: caller.signal });
    clearTimeout(timer);

    expect(result).toMatchObject({
      ok: false,
      error: "cross-rib call 'caller' -> 'provider:probe_tool' aborted by caller",
    });
    expect(executed).toBe(0);
  });

  test("runs a fast tool when timeout opts are present", async () => {
    process.env.KEELSON_CROSS_RIB_GRANTS = "caller:provider:probe_tool";
    const callTool = await bootWithCaller({
      provider: providerRib("provider", [
        tool("probe_tool", (ctx) => {
          ctx.emit({ type: "tool_result", toolUseId: "", content: "fast" });
        }),
      ]),
    });

    const result = await callTool("provider", "probe_tool", {}, { timeoutMs: 1_000 });

    expect(result).toEqual({
      ok: true,
      chunks: [{ type: "tool_result", toolUseId: "", content: "fast" }],
    } satisfies CallToolResult);
  });
});

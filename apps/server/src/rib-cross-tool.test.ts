// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallToolResult, MessageChunk, Rib, RibContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { bootstrapRibs } from "./bootstrap.ts";
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

function tool(name: string, onExecute: (ctx: { emit: (chunk: MessageChunk) => void }) => void) {
  return {
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    execute: async (_input, ctx) => {
      onExecute(ctx);
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

async function bootWithCaller(available: Record<string, Rib>, getPolicyEngine = () => policyEngine()) {
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
        base: { surface: "rib", ribId: "caller", targetRibId: "provider", cwd: process.cwd() },
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
});

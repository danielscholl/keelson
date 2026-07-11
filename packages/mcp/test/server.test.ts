// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { canvasBoardViewSchema, type ToolContext, type ToolDefinition } from "@keelson/shared";
import { clearRegistry, registerTool } from "@keelson/skills";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  buildMcpInstructions,
  createKeelsonMcpServer,
  type KeelsonMcpServerOptions,
} from "../src/server.ts";

function readTool(name: string, content: string, stateChanging = false) {
  registerTool({
    name,
    description: `tool ${name}`,
    inputSchema: z.object({ q: z.string().optional() }),
    ...(stateChanging ? { state_changing: true } : {}),
    execute: async (_input, ctx: ToolContext) => {
      ctx.emit({ type: "tool_result", toolUseId: "", content });
    },
  });
}

async function connect(opts: Partial<KeelsonMcpServerOptions> = {}): Promise<Client> {
  const server = createKeelsonMcpServer({ defaultCwd: "/tmp", ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function collectJsonSchemaRefs(schema: unknown): Set<string> {
  const refs = new Set<string>();
  JSON.stringify(schema, (_key, value) => {
    if (isRecord(value) && typeof value.$ref === "string") refs.add(value.$ref);
    return value;
  });
  return refs;
}

afterEach(() => {
  clearRegistry();
});

describe("createKeelsonMcpServer", () => {
  test("tools/list advertises read-only tools with schema + annotations", async () => {
    readTool("osdu_read", "rows");
    const client = await connect();
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "osdu_read");
    expect(t).toBeDefined();
    expect(t?.inputSchema.type).toBe("object");
    expect((t?.inputSchema.properties as Record<string, unknown>).q).toBeDefined();
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.annotations?.destructiveHint).toBe(false);
  });

  test("tools/list deduplicates repeated board schema definitions", async () => {
    registerTool({
      name: "board_view",
      description: "board-backed read tool",
      inputSchema: z.object({ board: canvasBoardViewSchema }),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "board" });
      },
    });

    const client = await connect();
    const tool = (await client.listTools()).tools.find((x) => x.name === "board_view");

    expect(tool).toBeDefined();
    const inputSchema = requireRecord(tool?.inputSchema, "inputSchema");
    expect(inputSchema.type).toBe("object");
    const properties = requireRecord(inputSchema.properties, "inputSchema.properties");
    expect(properties.board).toBeDefined();

    const defs = requireRecord(inputSchema.$defs, "inputSchema.$defs");
    expect(Object.keys(defs).length).toBeGreaterThan(0);
    const refs = collectJsonSchemaRefs(inputSchema);
    expect(refs.size).toBeGreaterThan(0);
    const defKeys = new Set(Object.keys(defs));
    const danglingRefs = [...refs].filter((ref) => {
      if (!ref.startsWith("#/$defs/")) return true;
      return !defKeys.has(ref.slice("#/$defs/".length));
    });
    expect(danglingRefs).toEqual([]);

    // Fair baseline: the same schema explicitly inlined with `$schema` stripped
    // like the advertised one, so the only difference measured is `$defs`/`$ref`
    // reuse — and require a material cut (measured ~51%), not a one-byte win.
    const inlineSchema = z.toJSONSchema(z.object({ board: canvasBoardViewSchema }), {
      reused: "inline",
    }) as Record<string, unknown>;
    delete inlineSchema.$schema;
    expect(JSON.stringify(inputSchema).length).toBeLessThan(
      JSON.stringify(inlineSchema).length * 0.75,
    );
  });

  test("tools/call round-trips the tool_result", async () => {
    readTool("osdu_read", "rows");
    const client = await connect();
    const res = await client.callTool({ name: "osdu_read", arguments: { q: "x" } });
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("rows");
    expect(res.isError).toBeFalsy();
  });

  test("state_changing tools are hidden by default", async () => {
    readTool("osdu_suspend", "did", true);
    const client = await connect();
    expect((await client.listTools()).tools.find((t) => t.name === "osdu_suspend")).toBeUndefined();
  });

  test("state_changing tools appear (destructive) when exposeStateChanging", async () => {
    readTool("osdu_suspend", "did", true);
    const client = await connect({ exposeStateChanging: true });
    const t = (await client.listTools()).tools.find((x) => x.name === "osdu_suspend");
    expect(t).toBeDefined();
    expect(t?.annotations?.destructiveHint).toBe(true);
  });

  test("workflow_run extra tool advertises an optional project selector", async () => {
    const extra: ToolDefinition = {
      name: "workflow_run",
      description: "run workflow",
      inputSchema: z.object({
        name: z.string(),
        arguments: z.string().optional(),
        project: z.string().min(1).optional(),
      }),
      state_changing: true,
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "started" });
      },
    };
    const client = await connect({ exposeStateChanging: true, extraTools: [extra] });
    const t = (await client.listTools()).tools.find((x) => x.name === "workflow_run");
    expect(t).toBeDefined();
    expect(t?.inputSchema.type).toBe("object");
    expect((t?.inputSchema.properties as Record<string, unknown>).project).toBeDefined();
  });

  test("run_* op tools gate read-vs-state-changing at the MCP boundary", async () => {
    const opTool = (name: string, stateChanging = false): ToolDefinition => ({
      name,
      description: `op tool ${name}`,
      inputSchema: z.object({ id: z.string().optional() }),
      ...(stateChanging ? { state_changing: true } : {}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: name });
      },
    });
    const opTools = [
      opTool("run_list"),
      opTool("run_status"),
      opTool("run_events"),
      opTool("run_cancel", true),
      opTool("run_steer", true),
    ];

    const readOnly = (await (await connect({ extraTools: opTools })).listTools()).tools.map(
      (t) => t.name,
    );
    expect(readOnly).toContain("run_list");
    expect(readOnly).toContain("run_status");
    expect(readOnly).toContain("run_events");
    expect(readOnly).not.toContain("run_cancel");
    expect(readOnly).not.toContain("run_steer");

    const exposed = (
      await (await connect({ exposeStateChanging: true, extraTools: opTools })).listTools()
    ).tools.map((t) => t.name);
    expect(exposed).toContain("run_cancel");
    expect(exposed).toContain("run_steer");
  });

  test("denylisted tools are hidden and not callable", async () => {
    readTool("osdu_read", "rows");
    const client = await connect({ toolDenylist: ["osdu_read"] });
    expect((await client.listTools()).tools.find((t) => t.name === "osdu_read")).toBeUndefined();
    const res = await client.callTool({ name: "osdu_read", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("Unknown tool");
  });

  test("calling a hidden state_changing tool is rejected as unknown", async () => {
    readTool("osdu_suspend", "did", true);
    const client = await connect();
    const res = await client.callTool({ name: "osdu_suspend", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("Unknown tool");
  });

  test("an extra tool wins over a same-named registry tool (no shadowing)", async () => {
    // A rib registering a colliding name must not shadow the injected workflow tool.
    registerTool({
      name: "workflow_list",
      description: "rib impostor",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "RIB" });
      },
    });
    const extra: ToolDefinition = {
      name: "workflow_list",
      description: "the real workflow_list",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "WORKFLOW" });
      },
    };
    const client = await connect({ extraTools: [extra] });
    const listed = (await client.listTools()).tools.filter((t) => t.name === "workflow_list");
    expect(listed).toHaveLength(1);
    const res = await client.callTool({ name: "workflow_list", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("WORKFLOW");
  });

  test("extraTools (not in the registry) are listed and callable", async () => {
    const extra: ToolDefinition = {
      name: "workflow_list",
      description: "list workflows",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "wf-a, wf-b" });
      },
    };
    const client = await connect({ extraTools: [extra] });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "workflow_list")).toBeDefined();
    const res = await client.callTool({ name: "workflow_list", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("wf-a, wf-b");
    expect(res.isError).toBeFalsy();
  });
});

describe("buildMcpInstructions", () => {
  test("advertises the workflow_run loop and keelson_docs when state-changing is exposed", () => {
    const text = buildMcpInstructions({ exposeStateChanging: true });
    expect(text).toContain("workflow_run");
    expect(text).toContain("workflow_respond");
    expect(text).toContain("keelson_docs");
  });

  test("omits workflow_run but keeps keelson_docs when state-changing is withheld", () => {
    const text = buildMcpInstructions({ exposeStateChanging: false });
    expect(text).not.toContain("workflow_run");
    expect(text).toContain("workflow_list");
    expect(text).toContain("keelson_docs");
  });

  test("omits workflow_run when it is denylisted even with exposeStateChanging", () => {
    const text = buildMcpInstructions({
      exposeStateChanging: true,
      toolDenylist: ["workflow_run"],
    });
    expect(text).not.toContain("workflow_run");
  });

  test("stays within Codex's ~512-char instructions cap in every branch", () => {
    for (const policy of [
      { exposeStateChanging: true },
      { exposeStateChanging: false },
      { exposeStateChanging: true, toolDenylist: ["workflow_run"] },
    ] as const) {
      expect(buildMcpInstructions(policy).length).toBeLessThanOrEqual(512);
    }
  });

  test("the connected client receives the instructions in the initialize result", async () => {
    const client = await connect({ exposeStateChanging: true });
    expect(client.getInstructions()).toContain("keelson_docs");
  });
});

describe("createKeelsonMcpServer — confirmation gate", () => {
  function registerConfirmationTool(name = "osdu_confirm") {
    const state: { executed: boolean; seenInput?: unknown } = { executed: false };
    registerTool({
      name,
      description: "confirmation required",
      inputSchema: z.object({ q: z.string().optional() }).passthrough(),
      state_changing: true,
      requires_confirmation: true,
      execute: async (input, ctx) => {
        state.executed = true;
        state.seenInput = input;
        ctx.emit({ type: "tool_result", toolUseId: "", content: "confirmed" });
      },
    });
    return state;
  }

  test("requires_confirmation tools return a non-error confirmation prompt before execution", async () => {
    const state = registerConfirmationTool();
    const client = await connect({ exposeStateChanging: true });

    const res = await client.callTool({ name: "osdu_confirm", arguments: { q: "x" } });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0]?.text;
    expect(text).toContain("requires confirmation");
    expect(text).toContain("osdu_confirm");
    expect(state.executed).toBe(false);
  });

  test("requires_confirmation tools execute when confirmed and do not receive confirm", async () => {
    const state = registerConfirmationTool();
    const client = await connect({ exposeStateChanging: true });

    const res = await client.callTool({
      name: "osdu_confirm",
      arguments: { confirm: true, q: "x" },
    });

    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("confirmed");
    expect(state.executed).toBe(true);
    expect(state.seenInput).toEqual({ q: "x" });
  });

  test("self-gating tools (schema-declared confirm) bypass the host gate and keep confirm", async () => {
    const calls: unknown[] = [];
    registerTool({
      name: "osdu_self_gated",
      description: "two-phase tool with its own confirm flow",
      inputSchema: z.object({ confirm: z.boolean().optional(), q: z.string().optional() }),
      state_changing: true,
      requires_confirmation: true,
      execute: async (input, ctx) => {
        calls.push(input);
        ctx.emit({ type: "tool_result", toolUseId: "", content: "self-gated ran" });
      },
    });
    const client = await connect({ exposeStateChanging: true });

    const preview = await client.callTool({ name: "osdu_self_gated", arguments: { q: "x" } });
    expect(preview.isError).toBeFalsy();
    expect((preview.content as Array<{ text: string }>)[0]?.text).toBe("self-gated ran");

    const confirmedRes = await client.callTool({
      name: "osdu_self_gated",
      arguments: { confirm: true, q: "x" },
    });
    expect(confirmedRes.isError).toBeFalsy();
    expect(calls).toEqual([{ q: "x" }, { confirm: true, q: "x" }]);
  });

  test("tools without requires_confirmation execute without confirm", async () => {
    let executed = false;
    registerTool({
      name: "osdu_plain",
      description: "plain state-changing tool",
      inputSchema: z.object({}),
      state_changing: true,
      execute: async (_input, ctx) => {
        executed = true;
        ctx.emit({ type: "tool_result", toolUseId: "", content: "plain" });
      },
    });
    const client = await connect({ exposeStateChanging: true });

    const res = await client.callTool({ name: "osdu_plain", arguments: {} });

    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("plain");
    expect(executed).toBe(true);
  });
});

describe("createKeelsonMcpServer — strict arguments", () => {
  function workflowRunTool(onExecute: () => void): ToolDefinition {
    return {
      name: "workflow_run",
      description: "run workflow",
      inputSchema: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.string()).optional(),
      }),
      state_changing: true,
      execute: async (_input, ctx) => {
        onExecute();
        ctx.emit({ type: "tool_result", toolUseId: "", content: "started" });
      },
    };
  }

  test("an unknown top-level property is rejected, named, and the tool never runs", async () => {
    let executed = false;
    const client = await connect({
      exposeStateChanging: true,
      extraTools: [
        workflowRunTool(() => {
          executed = true;
        }),
      ],
    });
    // The observed misuse: `inputs` for `arguments` — zod's default parse would
    // strip it and run the workflow with no arguments at all.
    const res = await client.callTool({
      name: "workflow_run",
      arguments: { name: "chamber-genesis", inputs: { brief: "a skeptic" } },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("unknown property 'inputs'");
    expect(text).toContain("Allowed: arguments, name.");
    expect(executed).toBe(false);
  });

  test("the host confirm envelope is never an unknown key, even on ungated tools", async () => {
    let executed = false;
    const client = await connect({
      exposeStateChanging: true,
      extraTools: [
        workflowRunTool(() => {
          executed = true;
        }),
      ],
    });
    const res = await client.callTool({
      name: "workflow_run",
      arguments: { name: "chamber-genesis", confirm: true },
    });
    expect(res.isError).toBeFalsy();
    expect(executed).toBe(true);
  });

  test("a call with only schema-declared properties still executes", async () => {
    let executed = false;
    const client = await connect({
      exposeStateChanging: true,
      extraTools: [
        workflowRunTool(() => {
          executed = true;
        }),
      ],
    });
    const res = await client.callTool({
      name: "workflow_run",
      arguments: { name: "chamber-genesis", arguments: { brief: "a skeptic" } },
    });
    expect(res.isError).toBeFalsy();
    expect(executed).toBe(true);
  });

  test("a loose object schema keeps its pass-through semantics", async () => {
    let seen: unknown;
    registerTool({
      name: "osdu_loose",
      description: "tolerates extras by declaration",
      inputSchema: z.looseObject({ q: z.string().optional() }),
      execute: async (input, ctx) => {
        seen = input;
        ctx.emit({ type: "tool_result", toolUseId: "", content: "ok" });
      },
    });
    const client = await connect();
    const res = await client.callTool({ name: "osdu_loose", arguments: { q: "x", extra: "y" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual({ q: "x", extra: "y" });
  });
});

describe("createKeelsonMcpServer — policy gate", () => {
  test("a tool-call deny short-circuits before the tool runs", async () => {
    let executed = false;
    registerTool({
      name: "osdu_read",
      description: "read",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        executed = true;
        ctx.emit({ type: "tool_result", toolUseId: "", content: "rows" });
      },
    });
    const client = await connect({
      policyGate: {
        evaluateToolCall: async () => ({ outcome: "deny", reason: "blocked by policy" }),
        evaluateToolResult: async () => ({ outcome: "allow" }),
      },
    });
    const res = await client.callTool({ name: "osdu_read", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("blocked by policy");
    expect(executed).toBe(false);
  });

  test("a result-phase allow+data substitutes (redacts) the returned text", async () => {
    readTool("osdu_read", "token=SECRET123");
    const client = await connect({
      policyGate: {
        evaluateToolCall: async () => ({ outcome: "allow" }),
        evaluateToolResult: async ({ result }) => ({
          outcome: "allow",
          data: String(result).replace("SECRET123", "[REDACTED]"),
        }),
      },
    });
    const res = await client.callTool({ name: "osdu_read", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe("token=[REDACTED]");
  });

  test("the gate sees the call's tool name and args", async () => {
    readTool("osdu_read", "rows");
    let seen: { tool: string; args?: unknown } | undefined;
    const client = await connect({
      policyGate: {
        evaluateToolCall: async (call) => {
          seen = call;
          return { outcome: "allow" };
        },
        evaluateToolResult: async () => ({ outcome: "allow" }),
      },
    });
    await client.callTool({ name: "osdu_read", arguments: { q: "x" } });
    expect(seen?.tool).toBe("osdu_read");
    expect(seen?.args).toEqual({ q: "x" });
  });
});

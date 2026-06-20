// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { clearRegistry, registerTool } from "@keelson/skills";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createKeelsonMcpServer, type KeelsonMcpServerOptions } from "../src/server.ts";

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

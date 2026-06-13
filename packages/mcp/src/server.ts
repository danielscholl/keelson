// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ToolDefinition, z } from "@keelson/shared";
import { getRegisteredTools } from "@keelson/skills";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeToolDefinition } from "./execute.ts";

export interface KeelsonMcpServerOptions {
  // cwd handed to every tool execution. Server-resolved (the default project
  // root); deliberately NOT a per-request param so a client can't direct
  // server-side execution at an arbitrary path.
  defaultCwd: string;
  // Expose state_changing tools (e.g. OSDU cluster suspend/reconcile). Default
  // false — a fresh endpoint serves only read-only tools.
  exposeStateChanging?: boolean;
  // Tool names never exposed over MCP, regardless of the above.
  toolDenylist?: readonly string[];
  // Reported to clients in the initialize response.
  version?: string;
  // Tools exposed in addition to the global skills registry — the workflow
  // chat tools live on the chat path, not the registry, so the host injects
  // them here to reach MCP clients.
  extraTools?: readonly ToolDefinition[];
}

type ExposurePolicy = Pick<KeelsonMcpServerOptions, "exposeStateChanging" | "toolDenylist">;

// A denied or hidden tool is reported as unknown (same shape as a nonexistent
// one) so the endpoint never reveals which tools it is withholding.
function isExposed(tool: ToolDefinition, policy: ExposurePolicy): boolean {
  if (policy.toolDenylist?.includes(tool.name)) return false;
  if (tool.state_changing === true && policy.exposeStateChanging !== true) return false;
  return true;
}

// Derive the JSON Schema MCP advertises for a tool's params. Mirrors
// @keelson/providers' deriveToolParametersJsonSchema, kept local so this
// package doesn't pull the provider SDKs. Always returns an object schema —
// MCP's Tool.inputSchema is required and must be type "object".
function toInputJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const def = (tool.inputSchema as { _def?: { type?: string } })._def;
  if (def?.type !== "object") return { type: "object", additionalProperties: true };
  try {
    const json = z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<string, unknown>;
    delete json.$schema;
    if (json.type === undefined) json.type = "object";
    return json;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

// Build a low-level MCP Server over keelson's tool registry (plus injected
// extras). The tool list is read lazily on each tools/list, so ribs registered
// at boot are reflected without re-wiring. Tool execution runs server-side via
// executeToolDefinition, where each rib tool keeps its real RibContext.
export function createKeelsonMcpServer(opts: KeelsonMcpServerOptions): Server {
  const server = new Server(
    { name: "keelson", version: opts.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  // The exposed universe = global registry (rib tools) + injected extras
  // (workflow tools). Read lazily per request so ribs registered at boot are
  // reflected without re-wiring. Extras win over a same-named registry tool
  // (mirrors the chat path's harness-name filter) — otherwise a rib registering
  // e.g. `workflow_list` would shadow the injected workflow tool at call time.
  const exposedTools = (): ToolDefinition[] => {
    const extras = opts.extraTools ?? [];
    const extraNames = new Set(extras.map((t) => t.name));
    const registry = getRegisteredTools().filter((t) => !extraNames.has(t.name));
    return [...registry, ...extras].filter((tool) => isExposed(tool, opts));
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: exposedTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputJsonSchema(tool),
      annotations: {
        readOnlyHint: tool.state_changing !== true,
        destructiveHint: tool.state_changing === true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = exposedTools().find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool '${name}'.` }],
        isError: true,
      };
    }
    const res = await executeToolDefinition(tool, args, {
      cwd: opts.defaultCwd,
      abortSignal: extra.signal,
    });
    return { content: [{ type: "text" as const, text: res.content }], isError: res.isError };
  });

  return server;
}

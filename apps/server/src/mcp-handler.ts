// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createKeelsonMcpHttp, type KeelsonMcpHttp, type McpPolicyGate } from "@keelson/mcp";
import type { ToolDefinition } from "@keelson/shared";
import type { McpSettings } from "@keelson/shared/config";
import type { Hono } from "hono";
import type { PolicyEngine } from "./policy-engine.ts";
import { constantTimeTokenEqual } from "./token-compare.ts";

// The MCP gateway lives under /api so it's excluded from the SPA static-asset
// fallback (which only serves non-/api GETs) and picks up the same CORS headers.
// CORS is browser-only and does not gate non-browser clients — the real access
// controls are the loopback bind and the optional bearer token.
const MCP_ROUTE_PATH = "/api/mcp";

export interface McpRoutesOptions {
  settings: McpSettings;
  // cwd handed to every tool execution — the server's default project root.
  defaultCwd: string;
  // Reported to MCP clients in the initialize response.
  version: string;
  // Expected bearer token; consulted only when settings.requireToken.
  token?: string;
  // Tools exposed in addition to the global registry (the workflow chat tools).
  extraTools?: readonly ToolDefinition[];
  // Unified policy engine. When supplied, MCP-invoked tools run the same
  // denylist / ask / redact stack as the chat and workflow surfaces instead of
  // the static exposure filter alone.
  policyEngine?: PolicyEngine;
}

// Adapt the host PolicyEngine to the gateway's narrow gate, binding the `mcp`
// surface. The result phase is wired only when a policy reads it, so the default
// path runs no per-result evaluation — matching the chat/workflow seams.
function toMcpGate(engine: PolicyEngine): McpPolicyGate {
  return {
    evaluateToolCall: (call) => engine.evaluateToolCall(call, { surface: "mcp" }),
    evaluateToolResult: engine.resultPhaseActive
      ? (call) => engine.evaluateToolResult(call, { surface: "mcp" })
      : async () => ({ outcome: "allow" as const }),
  };
}

export interface McpRoutesHandle {
  mount(app: Hono): void;
  dispose(): Promise<void>;
}

// Build the MCP gateway over the registered tool registry and return a handle
// that mounts the route and tears it down on shutdown.
export function createMcpRoutes(opts: McpRoutesOptions): McpRoutesHandle {
  const http: KeelsonMcpHttp = createKeelsonMcpHttp({
    defaultCwd: opts.defaultCwd,
    exposeStateChanging: opts.settings.exposeStateChanging,
    toolDenylist: opts.settings.toolDenylist,
    version: opts.version,
    ...(opts.extraTools !== undefined ? { extraTools: opts.extraTools } : {}),
    ...(opts.policyEngine !== undefined ? { policyGate: toMcpGate(opts.policyEngine) } : {}),
  });
  // Gate on `requireToken`, not on a non-undefined token: a routes object built
  // with requireToken set but no (or an empty) token must reject every request,
  // not serve unauthenticated. The expected token is "" in that case, which no
  // presented bearer can match, so the gate fails closed.
  const requireToken = opts.settings.requireToken === true;
  const gateToken = opts.token ?? "";
  return {
    mount(app) {
      app.all(MCP_ROUTE_PATH, async (c) => {
        if (requireToken) {
          // The auth scheme is case-insensitive per RFC 6750.
          const header = c.req.header("authorization") ?? "";
          const match = /^bearer\s+(.+)$/i.exec(header.trim());
          const presented = match?.[1] ?? "";
          if (
            presented.length === 0 ||
            gateToken.length === 0 ||
            !constantTimeTokenEqual(presented, gateToken)
          ) {
            return c.json({ error: "invalid mcp token" }, 401);
          }
        }
        // Stateless JSON-only mode offers neither a server→client SSE stream (GET)
        // nor a session lifecycle (DELETE). Per the Streamable-HTTP spec, answer
        // GET with 405 so clients treat SSE as unsupported and proceed — rather
        // than opening an SSE stream that the per-request transport tears down,
        // which surfaces as a client transport error.
        if (c.req.method !== "POST") {
          return c.json({ error: "method not allowed" }, 405);
        }
        try {
          return await http.handleRequest(c.req.raw);
        } catch (err) {
          // Surface a transport failure as a typed JSON envelope rather than a
          // bare 500 from the framework.
          return c.json({ error: "mcp transport error", message: String(err) }, 500);
        }
      });
    },
    dispose: () => http.close(),
  };
}

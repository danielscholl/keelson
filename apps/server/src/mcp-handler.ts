// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createKeelsonMcpHttp, type KeelsonMcpHttp } from "@keelson/mcp";
import type { ToolDefinition } from "@keelson/shared";
import type { McpSettings } from "@keelson/shared/config";
import type { Hono } from "hono";
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
  });
  const gateToken = opts.settings.requireToken ? opts.token : undefined;
  return {
    mount(app) {
      app.all(MCP_ROUTE_PATH, (c) => {
        if (gateToken !== undefined) {
          const header = c.req.header("authorization") ?? "";
          const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
          if (presented.length === 0 || !constantTimeTokenEqual(presented, gateToken)) {
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
        return http.handleRequest(c.req.raw);
      });
    },
    dispose: () => http.close(),
  };
}

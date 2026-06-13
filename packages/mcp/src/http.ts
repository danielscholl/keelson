// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKeelsonMcpServer, type KeelsonMcpServerOptions } from "./server.ts";

export interface KeelsonMcpHttp {
  // Hand a Web Request to the MCP gateway; returns the Web Response to send
  // back. Mount as `app.all("/api/mcp", (c) => mcp.handleRequest(c.req.raw))`.
  handleRequest(req: Request): Promise<Response>;
  close(): Promise<void>;
}

// Serve keelson's MCP gateway over the Web-standard Streamable-HTTP transport in
// stateless + JSON-response mode (no SSE). A fresh Server+transport is built per
// request: the SDK forbids reusing a stateless transport (it would collide
// message ids across clients), and statelessly each request is self-contained —
// validateSession skips the session/initialize checks and the Protocol layer
// has no initialization gate, so tools/list and tools/call work without a prior
// handshake on that transport. Tool execution runs server-side regardless,
// where each rib tool keeps its RibContext.
export function createKeelsonMcpHttp(opts: KeelsonMcpServerOptions): KeelsonMcpHttp {
  return {
    handleRequest: async (req: Request): Promise<Response> => {
      const server = createKeelsonMcpServer(opts);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        // connect inside the try so a connect-time throw still hits finally and
        // closes the request-scoped server (no leaked resources).
        await server.connect(transport);
        // JSON-response mode resolves the Response only after the handler runs,
        // so the result is fully materialized before we tear the server down.
        return await transport.handleRequest(req);
      } finally {
        await server.close();
      }
    },
    close: async () => {},
  };
}

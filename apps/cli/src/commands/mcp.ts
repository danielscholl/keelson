// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isLoopbackUrl, readServerState } from "@keelson/shared/server-state";
import { EXIT_NO_SERVER, EXIT_OK } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { probeServer, type ServerInfo } from "../server-probe.ts";

export interface McpBridgeOptions {
  baseUrl?: string;
}

// Bridge a stdio-only MCP client (e.g. some Codex CLI configs) to the running
// server's HTTP MCP endpoint. Reads newline-delimited JSON-RPC from stdin,
// forwards each message to POST /api/mcp, and writes the JSON-RPC response to
// stdout. Tool execution stays server-side (where rib RibContext lives) — this
// process is a dumb pump, so all diagnostics go to stderr to keep stdout a
// clean MCP channel.
export async function runMcpBridge(opts: McpBridgeOptions = {}): Promise<void> {
  // Resolve the target the same way `status`/`stop` do: an explicit
  // --base-url wins; otherwise follow the URL the running service recorded in
  // server.json (which may be a non-default port), falling back to the default.
  // The stored MCP token is paired ONLY with that recorded server — never sent
  // to an explicit --base-url target (a possibly different host the operator
  // owns) nor to the default fallback (which may be a different server).
  let probe: ServerInfo | null;
  let token: string | undefined;
  if (opts.baseUrl) {
    probe = await probeServer({ baseUrl: opts.baseUrl });
  } else {
    const state = readServerState(resolveKeelsonHome());
    probe = state && isLoopbackUrl(state.url) ? await probeServer({ baseUrl: state.url }) : null;
    if (probe) {
      token = state?.mcpToken;
    } else {
      probe = await probeServer();
    }
  }
  if (!probe) {
    process.stderr.write("keelson mcp: server not reachable; start it with `keelson start`\n");
    process.exit(EXIT_NO_SERVER);
  }
  const endpoint = `${probe.baseUrl}/api/mcp`;

  const writeLine = (text: string): void => {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  // Synthesize a JSON-RPC error so a failed request doesn't leave the client
  // hanging on an id that never gets answered. Notifications (no id) get only a
  // stderr note — there is nothing to reply to.
  const replyError = (rawLine: string, message: string): void => {
    let id: unknown;
    try {
      id = (JSON.parse(rawLine) as { id?: unknown }).id;
    } catch {
      return;
    }
    if (id === undefined || id === null) return;
    writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  };

  const forward = async (line: string): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        body: line,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`keelson mcp: request to ${endpoint} failed: ${msg}\n`);
      replyError(line, `keelson mcp bridge: ${msg}`);
      return;
    }
    const text = await res.text();
    if (!res.ok) {
      // A non-2xx body (e.g. the 401 token-gate response) is not a JSON-RPC
      // message; writing it to stdout would corrupt the channel. Report on
      // stderr and answer the request id (if any) with a clean JSON-RPC error.
      process.stderr.write(
        `keelson mcp: ${endpoint} returned HTTP ${res.status}: ${text.trim()}\n`,
      );
      replyError(line, `keelson mcp bridge: server returned HTTP ${res.status}`);
      return;
    }
    // 2xx: a request yields a single-line JSON-RPC response (enableJsonResponse,
    // never SSE); a notification yields 202 with an empty body.
    if (text.length > 0) writeLine(text);
  };

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) await forward(line);
      nl = buf.indexOf("\n");
    }
  }
  // Flush any bytes the streaming decoder is holding (a trailing multi-byte
  // codepoint at EOF) before handling the final unterminated line.
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail.length > 0) await forward(tail);
  process.exit(EXIT_OK);
}

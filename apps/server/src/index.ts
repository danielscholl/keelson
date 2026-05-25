// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { join, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Server } from "bun";
import { SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import {
  bootstrapProviders,
  bootstrapPromptHandler,
  bootstrapRibs,
  bootstrapWorkflows,
} from "./bootstrap.ts";
import {
  chatRoutes,
  chatWebSocketHandlers,
  handleChatUpgrade,
  isAllowedOrigin,
  type WsData,
} from "./chat-handler.ts";
import { createConversationStore } from "./conversation-store.ts";
import { createKeyringStore, getCredential } from "./credentials.ts";
import { credentialsRoutes } from "./credentials-handler.ts";
import { openDatabase } from "./db/init.ts";
import { installRedactedConsole } from "./redact.ts";
import { createWorkflowStore } from "./workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowSubscribers,
  handleWorkflowRunUpgrade,
  workflowRunWebSocketHandlers,
  workflowsRoutes,
} from "./workflows-handler.ts";

// apps/server/src/index.ts → repo root is three levels up.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

// Hoist before bootstrapProviders — those code paths emit console.warn on
// env-parse failures and the redaction wrapper must already be in place
// when the reveal route later opens its scope.
installRedactedConsole();

const bootstrap = bootstrapProviders({ getCredential });

// v0.1: no built-in ribs. Operators wire their own ribs by importing the
// rib packages here and adding them to the `available` map; `KEELSON_RIBS`
// (when set) filters that map to a subset. Until something is wired up,
// the tool registry stays empty and only the SDK's built-ins (Read/Write/
// Bash on Claude) are available to chat and workflow `prompt` nodes.
const ribs = bootstrapRibs({ available: {} });

const PORT = Number(process.env.PORT ?? 7878);
const HOSTNAME = "127.0.0.1";
// Bun.serve's default idleTimeout (10s) is below a workflow prompt-node's
// typical latency. 60s gives a per-request budget that's tolerant of slow
// SDK turns without holding sockets open forever.
const IDLE_TIMEOUT_S = 60;
const DB_PATH =
  process.env.KEELSON_DB ?? join(REPO_ROOT, ".keelson", "keelson.db");
const db = openDatabase({ path: DB_PATH });
const store = createConversationStore(db);
const workflowStore = createWorkflowStore(db);
const workflowCatalog = bootstrapWorkflows({
  workflowDir: join(REPO_ROOT, ".keelson", "workflows"),
});
// Composition-root ownership of in-flight runs — the shutdown handler
// drains via this same handle so a SIGINT can abort active executions and
// let their terminal-state writes land before db.close().
const activeWorkflowRuns = createActiveRuns();
// Per-run WS subscriber registry. Shared between workflowsRoutes (which
// fans onEvent frames into it) and the WS upgrade handler / WebSocketHandlers
// (which subscribe/unsubscribe sockets). Constructed once so the POST handler
// and the WS upgrade route see the same map.
const workflowSubscribers = createWorkflowSubscribers();
// Constructed AFTER bootstrapProviders/bootstrapRibs so the prompt handler's
// getProvider/getRegisteredTools closures resolve against populated registries.
// Undefined when no providers are registered — workflowsRoutes falls back to
// the placeholder handler in that case.
const promptHandler = bootstrapPromptHandler();
const credentialStore = createKeyringStore();

// Async shutdown: drain workflow runs first (the executor's onEvent run_done
// branch writes terminal state to SQLite, and that must happen before
// db.close()), then dispose any activated ribs (which may hold sockets or
// child processes), then close the database.
const shutdown = async (): Promise<void> => {
  try {
    await activeWorkflowRuns.abortAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[keelson] workflow run drain during shutdown failed: ${msg}`);
  }
  await ribs.disposeAll();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

export const app = new Hono();

// Reflect any loopback origin so Vite port shifts (5174/5175/…) don't break
// CORS preflight. The per-route gates use the same predicate.
app.use(
  "/api/*",
  cors({ origin: (o) => (isAllowedOrigin(o) ? o : "") }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    name: "keelson",
    schema_version: SCHEMA_VERSION,
  }),
);

app.get("/api/config", (c) =>
  c.json({
    schemaVersion: SCHEMA_VERSION,
    wireProtocolVersion: WIRE_PROTOCOL_VERSION,
  }),
);

chatRoutes(app, store, {
  workflowStore,
  activeRuns: activeWorkflowRuns,
});
workflowsRoutes(
  app,
  {
    catalog: workflowCatalog,
    store: workflowStore,
    conversationStore: store,
    cwd: REPO_ROOT,
    ...(promptHandler ? { promptHandler } : {}),
  },
  activeWorkflowRuns,
  workflowSubscribers,
);
credentialsRoutes(app, credentialStore, {
  copilotAuthProbe: bootstrap.copilotAuthProbe,
  claudeAuthProbe: bootstrap.claudeAuthProbe,
});

app.get("/", (c) =>
  c.text(
    "keelson server is running. The web UI lives at http://127.0.0.1:5173 in dev (run `bun --filter @keelson/web dev`).",
  ),
);

if (import.meta.main) {
  console.log(`keelson server listening on http://${HOSTNAME}:${PORT}`);
}

const chatHandlers = chatWebSocketHandlers(store);
const workflowRunHandlers = workflowRunWebSocketHandlers({
  subscribers: workflowSubscribers,
  store: workflowStore,
});

// Single WebSocketHandler that dispatches by `ws.data.kind`. Both per-kind
// handler sets carry the same Bun.serve types so the union flows through
// without casts.
const wsHandlers = {
  open(ws: Parameters<NonNullable<typeof chatHandlers.open>>[0]) {
    if (ws.data.kind === "workflowRun") workflowRunHandlers.open?.(ws);
    else chatHandlers.open?.(ws);
  },
  message(
    ws: Parameters<NonNullable<typeof chatHandlers.message>>[0],
    raw: Parameters<NonNullable<typeof chatHandlers.message>>[1],
  ) {
    if (ws.data.kind === "workflowRun")
      return workflowRunHandlers.message?.(ws, raw);
    return chatHandlers.message?.(ws, raw);
  },
  close(
    ws: Parameters<NonNullable<typeof chatHandlers.close>>[0],
    code: number,
    reason: string,
  ) {
    if (ws.data.kind === "workflowRun")
      return workflowRunHandlers.close?.(ws, code, reason);
    return chatHandlers.close?.(ws, code, reason);
  },
};

const WORKFLOW_RUN_WS_RE = /^\/api\/workflows\/runs\/([^/]+)\/ws$/;

export default {
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: IDLE_TIMEOUT_S,
  fetch(req: Request, srv: Server<WsData>) {
    const url = new URL(req.url);
    if (url.pathname === "/api/chat/ws") {
      return handleChatUpgrade(req, srv);
    }
    const runMatch = WORKFLOW_RUN_WS_RE.exec(url.pathname);
    if (runMatch) {
      return handleWorkflowRunUpgrade(
        req,
        srv,
        decodeURIComponent(runMatch[1]!),
      );
    }
    return app.fetch(req);
  },
  websocket: wsHandlers,
};

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PROJECT_NAME, SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import type { Server } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  bootstrapPromptHandler,
  bootstrapProviders,
  bootstrapRibs,
  bootstrapWorkflows,
  prepareRibWorkflows,
} from "./bootstrap.ts";
import { chatRoutes, chatWebSocketHandlers, handleChatUpgrade } from "./chat-handler.ts";
import { chatRememberRoutes } from "./chat-remember-handler.ts";
import { createConversationStore } from "./conversation-store.ts";
import { createKeyringStore, createRibCredentialAccessor, getCredential } from "./credentials.ts";
import { credentialsRoutes } from "./credentials-handler.ts";
import { openDatabase } from "./db/init.ts";
import { memoryRoutes } from "./memory-handler.ts";
import { createMemoryStore } from "./memory-store.ts";
import { projectNotebookRoutes } from "./project-notebook-handler.ts";
import { createProjectNotebookStore } from "./project-notebook-store.ts";
import { projectsRoutes } from "./projects-handler.ts";
import { createProjectsStore } from "./projects-store.ts";
import { installRedactedConsole } from "./redact.ts";
import { ribsRoutes } from "./ribs-handler.ts";
import { createScheduler, deriveSurfaceSchedules, makeBoundKeyResolver } from "./scheduler.ts";
import { isAllowedOrigin, type WsData } from "./server-context.ts";
import { createSnapshotManager } from "./snapshot-manager.ts";
import { createSnapshotSubscribers } from "./snapshot-subscribers.ts";
import {
  handleSnapshotUpgrade,
  snapshotsRoutes,
  snapshotWebSocketHandlers,
} from "./snapshots-handler.ts";
import { createWorkflowStore } from "./workflow-store.ts";
import { createWorkflowChatTools } from "./workflow-tools.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  handleWorkflowRunUpgrade,
  type WorkflowsHandlerOptions,
  workflowRunWebSocketHandlers,
  workflowsRoutes,
} from "./workflows-handler.ts";
import { migrateLegacyProjectsLayout } from "./workspace-migration.ts";

// apps/server/src/index.ts → repo root is three levels up.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

// Hoist before bootstrapProviders — those code paths emit console.warn on
// env-parse failures and the redaction wrapper must already be in place
// when the reveal route later opens its scope.
installRedactedConsole();

const bootstrap = bootstrapProviders({ getCredential });

// Generic snapshot infrastructure — owned at the composition root alongside
// the workflow subscriber registry. Ribs declaring `composeBundle` are
// auto-registered under their `rib.id` by `applyRibs`. Constructed BEFORE
// bootstrapRibs so the rib's RibContext.getSnapshotManager resolver is
// already bindable.
const snapshotSubscribers = createSnapshotSubscribers();
const snapshotManager = createSnapshotManager(snapshotSubscribers);

// Keyring store is needed before ribs so each rib gets a namespaced, read-only
// credential reader scoped to its own keys.
const credentialStore = createKeyringStore();

const ribs = await bootstrapRibs({
  snapshotManager,
  getRibCredential: (ribId, serviceId) =>
    createRibCredentialAccessor(credentialStore, ribId)(serviceId),
});
// Narrow rib-contributed workflow definitions and collect the run-path bindings
// that republish a bound run's structured output to the rib's snapshot key.
const ribWorkflows = prepareRibWorkflows(ribs.workflowContributions);

const PORT = Number(process.env.PORT ?? 7878);
const HOSTNAME = "127.0.0.1";
// Bun.serve's default idleTimeout (10s) is below a workflow prompt-node's
// typical latency. 60s gives a per-request budget that's tolerant of slow
// SDK turns without holding sockets open forever.
const IDLE_TIMEOUT_S = 60;
const DB_PATH = process.env.KEELSON_DB ?? join(REPO_ROOT, ".keelson", "keelson.db");
const WORKSPACE_ROOT = resolve(process.env.KEELSON_WORKSPACE?.trim() || join(homedir(), "keelson"));
// The workspace root is the default project's cwd and the clone destination
// for /api/projects/clone; make sure it exists before seeding or cloning.
mkdirSync(WORKSPACE_ROOT, { recursive: true });
const db = openDatabase({ path: DB_PATH });
const store = createConversationStore(db);
const workflowStore = createWorkflowStore(db);
const memoryStore = createMemoryStore(db);
const projectsStore = createProjectsStore(db);
const projectNotebookStore = createProjectNotebookStore(db);
migrateLegacyProjectsLayout({ db, projectsStore, workspaceRoot: WORKSPACE_ROOT });
const existingDefault = projectsStore.getByName(DEFAULT_PROJECT_NAME);
const defaultProject =
  existingDefault ??
  projectsStore.create({
    name: DEFAULT_PROJECT_NAME,
    rootPath: WORKSPACE_ROOT,
  });
// Idempotent backfills — safe to re-run because the WHERE clauses match
// only legacy NULL rows that pre-date project scoping. Without these,
// chat recall (now project-scoped) silently stops returning them and
// projectless conversations would leak memories across all projects.
db.prepare(
  "UPDATE memories SET scope_project_id = ? WHERE scope_project_id IS NULL AND scope_visibility = 'project'",
).run(defaultProject.id);
db.prepare("UPDATE conversations SET project_id = ? WHERE project_id IS NULL").run(
  defaultProject.id,
);
const workflowCatalog = bootstrapWorkflows({
  workflowDir: join(REPO_ROOT, ".keelson", "workflows"),
  extra: ribWorkflows.definitions,
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

// Shared handler options so the HTTP routes and the in-process WorkflowController
// drive runs through the identical wiring. The controller + chat tools are built
// here (after the workflow subsystem exists, and NOT via the rib path which
// bootstraps earlier) and injected only on the chat path.
const workflowHandlerOptions: WorkflowsHandlerOptions = {
  catalog: workflowCatalog,
  store: workflowStore,
  conversationStore: store,
  projectsStore,
  ...(promptHandler ? { promptHandler } : {}),
  memoryStore,
  projectNotebookStore,
  snapshotManager,
  ribWorkflowBindings: ribWorkflows.bindings,
  // Working dir for surface-panel refreshes (POST /:name/refresh) re-running a
  // rib collector — its node uses absolute paths, so the cwd is nominal. Kept
  // off `defaultCwd` so the generic /runs path still rejects target-less starts.
  refreshCwd: REPO_ROOT,
};
const workflowController = createWorkflowController(
  workflowHandlerOptions,
  activeWorkflowRuns,
  workflowSubscribers,
);
const workflowTools = createWorkflowChatTools({
  controller: workflowController,
  catalog: workflowCatalog,
});

// Server-side heartbeat: keep snapshot-backed surface regions fresh on their
// declared cadence even when no client tab is mounted (and warm them after a
// cold boot). Client SWR covers the tab-open case; this covers the rest. The
// derivation also surfaces any cadence region whose workflow can't refresh it.
const { schedules: surfaceSchedules, warnings: scheduleWarnings } = deriveSurfaceSchedules(
  ribs.manifests,
  makeBoundKeyResolver(workflowCatalog, ribWorkflows.bindings, ribWorkflows.boundKeys),
);
for (const warning of scheduleWarnings) {
  console.warn(`[keelson] ${warning}`);
}
const scheduler = createScheduler({
  schedules: surfaceSchedules,
  controller: workflowController,
  snapshotManager,
  repoRoot: REPO_ROOT,
  disabled: process.env.KEELSON_DISABLE_SCHEDULER === "1",
});
scheduler.start();

// Async shutdown: drain workflow runs first (the executor's onEvent run_done
// branch writes terminal state to SQLite, and that must happen before
// db.close()), then dispose any activated ribs (which may hold sockets or
// child processes), close the snapshot manager (closes lingering WS
// subscribers and drains in-flight composes), then close the database.
const shutdown = async (): Promise<void> => {
  // Stop the heartbeat first so no tick enqueues a fresh run mid-drain.
  scheduler.stop();
  try {
    await activeWorkflowRuns.abortAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[keelson] workflow run drain during shutdown failed: ${msg}`);
  }
  await ribs.disposeAll();
  await snapshotManager.dispose();
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
app.use("/api/*", cors({ origin: (o) => (isAllowedOrigin(o) ? o : "") }));

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

chatRoutes(
  app,
  store,
  {
    workflowStore,
    activeRuns: activeWorkflowRuns,
  },
  { projectsStore },
);
workflowsRoutes(app, workflowHandlerOptions, activeWorkflowRuns, workflowSubscribers);
snapshotsRoutes(app, { manager: snapshotManager, subscribers: snapshotSubscribers });
ribsRoutes(app, {
  manifests: ribs.manifests,
  probes: ribs.probes,
  actionHandlers: ribs.actionHandlers,
});
projectsRoutes(app, { store: projectsStore, projectsRoot: WORKSPACE_ROOT });
memoryRoutes(app, { memoryStore });
projectNotebookRoutes(app, { store: projectNotebookStore, projectsStore });
chatRememberRoutes(app, { conversationStore: store, memoryStore });
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

const chatHandlers = chatWebSocketHandlers(store, {
  memoryStore,
  projectsStore,
  projectNotebookStore,
  workflowTools,
  workflowCatalog,
});
const workflowRunHandlers = workflowRunWebSocketHandlers({
  subscribers: workflowSubscribers,
  store: workflowStore,
  activeRuns: activeWorkflowRuns,
});
const snapshotHandlers = snapshotWebSocketHandlers({
  subscribers: snapshotSubscribers,
});

// Single WebSocketHandler that dispatches by `ws.data.kind`. All per-kind
// handler sets carry the same Bun.serve types so the union flows through
// without casts.
const wsHandlers = {
  open(ws: Parameters<NonNullable<typeof chatHandlers.open>>[0]) {
    if (ws.data.kind === "workflowRun") workflowRunHandlers.open?.(ws);
    else if (ws.data.kind === "snapshot") snapshotHandlers.open?.(ws);
    else chatHandlers.open?.(ws);
  },
  message(
    ws: Parameters<NonNullable<typeof chatHandlers.message>>[0],
    raw: Parameters<NonNullable<typeof chatHandlers.message>>[1],
  ) {
    if (ws.data.kind === "workflowRun") return workflowRunHandlers.message?.(ws, raw);
    if (ws.data.kind === "snapshot") return snapshotHandlers.message?.(ws, raw);
    return chatHandlers.message?.(ws, raw);
  },
  close(ws: Parameters<NonNullable<typeof chatHandlers.close>>[0], code: number, reason: string) {
    if (ws.data.kind === "workflowRun") return workflowRunHandlers.close?.(ws, code, reason);
    if (ws.data.kind === "snapshot") return snapshotHandlers.close?.(ws, code, reason);
    return chatHandlers.close?.(ws, code, reason);
  },
};

const WORKFLOW_RUN_WS_RE = /^\/api\/workflows\/runs\/([^/]+)\/ws$/;
const SNAPSHOT_WS_RE = /^\/api\/snapshots\/([^/]+)\/ws$/;

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
      return handleWorkflowRunUpgrade(req, srv, decodeURIComponent(runMatch[1]!));
    }
    const snapMatch = SNAPSHOT_WS_RE.exec(url.pathname);
    if (snapMatch) {
      let snapshotKey: string;
      try {
        snapshotKey = decodeURIComponent(snapMatch[1]!);
      } catch {
        return new Response("invalid snapshot key", { status: 400 });
      }
      return handleSnapshotUpgrade(req, srv, snapshotKey);
    }
    return app.fetch(req);
  },
  websocket: wsHandlers,
};

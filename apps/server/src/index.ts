// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_PROJECT_NAME, SCHEMA_VERSION, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { keelsonPaths, resolveKeelsonHome } from "@keelson/shared/paths";
import { clearServerState, readServerState, writeServerState } from "@keelson/shared/server-state";
import type { Server } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pkg from "../package.json" with { type: "json" };
import {
  bootstrapPromptHandler,
  bootstrapProviders,
  bootstrapRibs,
  bootstrapWorkflows,
  prepareRibWorkflows,
  registerRibTools,
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

const WORKFLOW_RUN_WS_RE = /^\/api\/workflows\/runs\/([^/]+)\/ws$/;
const SNAPSHOT_WS_RE = /^\/api\/snapshots\/([^/]+)\/ws$/;

export interface StartServerConfig {
  // Overrides the keelson-home-derived SQLite path (CLI `--db`).
  dbPath?: string;
  // Overrides PORT (defaults to env PORT or 7878).
  port?: number;
  // Directory of the built web SPA to serve at the root. Defaults to the
  // installed cli tarball's sibling `web/` (resolved from the bundle location);
  // unset/missing in a source checkout → API only, and the Vite dev server
  // on :5173 owns the UI.
  webDir?: string;
  // When set, registers POST /api/server/shutdown gated by the bearer token.
  // The token never travels over the network unprompted — it lives in the
  // home's server.json, so only a caller that can read the operator's disk
  // (keelson serve stop) can present it. onShutdown is invoked after the
  // response is sent; the caller owns process exit.
  shutdown?: { token: string; onShutdown: () => void };
  // Operator-facing version recorded in server.json (`keelson serve status`
  // reports it). The CLI passes its release version; the private @keelson/server
  // package's own version is meaningless to an operator.
  version?: string;
}

// Hash both sides so timingSafeEqual gets equal-length buffers regardless of
// what the caller presented.
function shutdownTokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Serve a file from the built SPA, with a single-page-app fallback: an
// extensionless path that doesn't map to a file (a client-side route) returns
// index.html. Returns null for a missing asset (let the API 404 it) and guards
// against path traversal escaping webDir.
export async function serveSpaAsset(webDir: string, pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = join(webDir, rel);
  // Stay within webDir: the resolved path must be the root itself or strictly
  // under it. A bare `startsWith(root)` would also match a sibling whose name
  // shares the prefix (e.g. `/var/www` vs `/var/www-evil`), so anchor on `sep`.
  const root = resolve(webDir);
  const full = resolve(filePath);
  if (full !== root && !full.startsWith(root + sep)) return null;
  const file = Bun.file(filePath);
  if (await file.exists()) {
    const res = new Response(file);
    // Vite emits content-hashed asset names, so they're safe to cache forever;
    // index.html must revalidate so a new build is picked up.
    res.headers.set(
      "Cache-Control",
      rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return res;
  }
  if (!extname(rel)) {
    const index = Bun.file(join(webDir, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "Cache-Control": "no-cache" } });
    }
  }
  return null;
}

export interface ServerHandle {
  readonly server: Server<WsData>;
  readonly url: string;
  // Drain runs, dispose ribs, close the snapshot manager + database. Does NOT
  // call process.exit — the signal handlers installed by startServer do that.
  shutdown(): Promise<void>;
}

// Build the database, ribs, workflow subsystem, and HTTP/WS routes, then serve.
// Runs the same bootstrap whether invoked as the `bun src/index.ts` entrypoint
// or imported in-process by `keelson serve`. Reads its data home via
// resolveKeelsonHome (KEELSON_HOME → project .keelson/ → ~/.keelson).
export async function startServer(config: StartServerConfig = {}): Promise<ServerHandle> {
  // The managed keelson home: KEELSON_HOME → an existing .keelson/ walking up
  // from cwd (the monorepo dev case) → ~/.keelson. Holds keelson.db + workflows/.
  const KEELSON_HOME = resolveKeelsonHome();
  const paths = keelsonPaths(KEELSON_HOME);
  mkdirSync(KEELSON_HOME, { recursive: true });

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
    ribsRoot: paths.ribsRoot,
    snapshotManager,
    getRibCredential: (ribId, serviceId) =>
      createRibCredentialAccessor(credentialStore, ribId)(serviceId),
  });
  // Register rib-contributed tools into the shared registry so the chat agent,
  // /api/tools, and workflow prompt nodes all pick them up via getRegisteredTools.
  registerRibTools(ribs.tools);
  // Narrow rib-contributed workflow definitions and collect the run-path bindings
  // that republish a bound run's structured output to the rib's snapshot key.
  const ribWorkflows = prepareRibWorkflows(ribs.workflowContributions);

  const PORT = config.port ?? Number(process.env.PORT ?? 7878);
  const HOSTNAME = "127.0.0.1";
  // Bun.serve's default idleTimeout (10s) is below a workflow prompt-node's
  // typical latency. 60s gives a per-request budget that's tolerant of slow
  // SDK turns without holding sockets open forever.
  const IDLE_TIMEOUT_S = 60;
  const DB_PATH = config.dbPath ?? paths.dbPath;
  const WORKSPACE_ROOT = resolve(
    process.env.KEELSON_WORKSPACE?.trim() || join(homedir(), "keelson"),
  );
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
    workflowDir: paths.workflowsDir,
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
  // the placeholder handler in that case. Rib tools are passed as default-off so
  // a workflow prompt node only sees a rib tool it explicitly `allowed_tools`.
  const promptHandler = bootstrapPromptHandler({
    defaultOffTools: ribs.tools.map((t) => t.name),
  });

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
    refreshCwd: KEELSON_HOME,
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
    repoRoot: KEELSON_HOME,
    disabled: process.env.KEELSON_DISABLE_SCHEDULER === "1",
  });
  scheduler.start();

  // Drain workflow runs first (the executor's onEvent run_done branch writes
  // terminal state to SQLite, and that must happen before db.close()), then
  // dispose any activated ribs (which may hold sockets or child processes),
  // close the snapshot manager (closes lingering WS subscribers and drains
  // in-flight composes), then close the database. Process-signal handling lives
  // in serveUntilSignal so the factory installs no global handlers (tests and
  // embedders call startServer + handle.shutdown() without leaking listeners).
  const drain = async (): Promise<void> => {
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
  };

  // The built SPA to serve at the root. config.webDir → KEELSON_WEB_DIR → the
  // cli tarball's sibling `web/` (the bundle lives at <cli>/dist, the build at
  // <cli>/web). Null when the resolved dir has no index.html (a source checkout),
  // so dev stays API-only and the Vite server on :5173 owns the UI.
  const webDirCandidate =
    config.webDir ?? (process.env.KEELSON_WEB_DIR?.trim() || join(import.meta.dir, "..", "web"));
  const WEB_DIR = existsSync(join(webDirCandidate, "index.html")) ? webDirCandidate : null;

  const app = new Hono();

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

  if (config.shutdown) {
    const { token, onShutdown } = config.shutdown;
    app.post("/api/server/shutdown", (c) => {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (presented.length === 0 || !shutdownTokenMatches(presented, token)) {
        return c.json({ ok: false, error: "invalid shutdown token" }, 401);
      }
      // Let the response flush before the listener is torn down.
      setTimeout(onShutdown, 50);
      return c.json({ ok: true });
    });
  }

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

  // Only reached when no built SPA is present (a source checkout) — the static
  // handler below serves index.html for `/` when WEB_DIR is set.
  app.get("/", (c) =>
    c.text(
      "keelson server is running. The web UI lives at http://127.0.0.1:5173 in dev (run `bun --filter @keelson/web dev`).",
    ),
  );

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

  const server = Bun.serve({
    port: PORT,
    hostname: HOSTNAME,
    idleTimeout: IDLE_TIMEOUT_S,
    async fetch(req: Request, srv: Server<WsData>) {
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
      // Serve the built SPA (and its client-side routes) for non-API GETs. The
      // API still owns /api/*; everything else falls through to Hono (the dev `/`
      // hint, 404s) when no asset matches.
      if (WEB_DIR && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const asset = await serveSpaAsset(WEB_DIR, url.pathname);
        if (asset) return asset;
      }
      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  console.log(`keelson server listening on ${server.url.href}`);
  if (WEB_DIR) console.log(`serving web UI from ${WEB_DIR}`);
  return {
    server,
    url: server.url.href,
    // Stop accepting connections (freeing the port) before draining + closing
    // the database, so a programmatic shutdown leaves no listener behind.
    async shutdown() {
      server.stop(true);
      await drain();
    },
  };
}

// Run the server and block until a termination signal (or an authorized
// POST /api/server/shutdown), then shut down once and exit. This is the
// process-owning entry both `bun src/index.ts` (dev) and `keelson serve`
// (in-process) use; startServer itself installs no signal handlers. It also
// owns the home's server.json record so `keelson serve status`/`stop` can
// find the pid, URL, and shutdown token. SIGHUP (SSH/terminal close) is a
// graceful stop in the foreground; a `keelson serve start` child sets
// KEELSON_SERVE_BACKGROUND=1 and ignores it so the server outlives the
// terminal that launched it.
export async function serveUntilSignal(config: StartServerConfig = {}): Promise<never> {
  const home = resolveKeelsonHome();
  const shutdownToken = randomBytes(32).toString("hex");
  let handle: ServerHandle | null = null;
  let shuttingDown = false;
  const stopOnce = () => {
    if (shuttingDown || !handle) return;
    shuttingDown = true;
    // Only remove the record we own — a newer server in the same home may
    // have overwritten it.
    if (readServerState(home)?.pid === process.pid) clearServerState(home);
    void handle.shutdown().finally(() => process.exit(0));
  };
  handle = await startServer({
    ...config,
    shutdown: { token: shutdownToken, onShutdown: stopOnce },
  });
  try {
    writeServerState(
      {
        pid: process.pid,
        url: handle.url.replace(/\/+$/, ""),
        startedAt: new Date().toISOString(),
        version: config.version ?? pkg.version,
        schemaVersion: SCHEMA_VERSION,
        shutdownToken,
      },
      home,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[keelson] could not write ${home}/server.json: ${msg}`);
  }
  process.on("SIGINT", stopOnce);
  process.on("SIGTERM", stopOnce);
  // SIGHUP (terminal hangup) is POSIX-only — Bun/Node don't deliver it on
  // Windows and registering a listener there can throw.
  if (process.platform !== "win32") {
    if (process.env.KEELSON_SERVE_BACKGROUND === "1") {
      // A no-op listener overrides the default terminate-on-SIGHUP.
      process.on("SIGHUP", () => {});
    } else {
      process.on("SIGHUP", stopOnce);
    }
  }
  // Park forever; stopOnce owns process exit. Bun.serve already keeps the loop alive.
  return await new Promise<never>(() => {});
}

if (import.meta.main) {
  await serveUntilSignal();
}

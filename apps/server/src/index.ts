// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import {
  disposeAllProviders,
  getAgentProvider,
  isRegisteredProvider,
  registerGatewayProvider,
  unregisterProvider,
} from "@keelson/providers";
import {
  DEFAULT_PROJECT_NAME,
  POLICY_APPROVALS_SNAPSHOT_KEY,
  policyApprovalsSnapshotSchema,
  RIBS_VERSION_SNAPSHOT_KEY,
  SCHEMA_VERSION,
  USAGE_PULSE_SNAPSHOT_KEY,
  usagePulseSnapshotSchema,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import {
  gatewayCredentialServiceId,
  loadKeelsonConfig,
  resolveMcpSettings,
} from "@keelson/shared/config";
import { keelsonPaths, resolveKeelsonHome, ribDataDir } from "@keelson/shared/paths";
import { clearServerState, readServerState, writeServerState } from "@keelson/shared/server-state";
import { bundledWorkflowsDir, seedStarterAssets } from "@keelson/workflows";
import type { Server } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pkg from "../package.json" with { type: "json" };
import { agentsRoutes } from "./agents-handler.ts";
import { createApprovalRegistry } from "./approval-registry.ts";
import { approvalsRoutes } from "./approvals-handler.ts";
import { createArtifactStore } from "./artifact-store.ts";
import {
  bootstrapPolicyEngine,
  bootstrapPromptHandler,
  bootstrapProviders,
  bootstrapRibs,
  bootstrapWorkflows,
  prepareRibWorkflows,
  registerRibTools,
} from "./bootstrap.ts";
import { createCanvasTools } from "./canvas-tools.ts";
import { chatRoutes, chatWebSocketHandlers, handleChatUpgrade } from "./chat-handler.ts";
import { chatRememberRoutes } from "./chat-remember-handler.ts";
import { commandsRoutes } from "./commands-handler.ts";
import { createConversationStore } from "./conversation-store.ts";
import { createKeyringStore, createRibCredentialAccessor, getCredential } from "./credentials.ts";
import { credentialsRoutes } from "./credentials-handler.ts";
import { openDatabase } from "./db/init.ts";
import {
  DocsCatalog,
  type DocsSource,
  KEELSON_CORE_DOCS_SOURCE,
  stampRibDocsSources,
} from "./docs-catalog.ts";
import { createDocsTool } from "./docs-tool.ts";
import { createDynamicRegionStore } from "./dynamic-region-store.ts";
import { gatewaysRoutes } from "./gateways-handler.ts";
import { createMcpRoutes, type McpRoutesHandle } from "./mcp-handler.ts";
import { memoryRoutes } from "./memory-handler.ts";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { resolveModelCostHint } from "./model-cost-hint.ts";
import type { PolicyEngine } from "./policy-engine.ts";
import { projectNotebookRoutes } from "./project-notebook-handler.ts";
import { createProjectNotebookStore } from "./project-notebook-store.ts";
import { projectsRoutes } from "./projects-handler.ts";
import { createProjectsStore, type ProjectsStore } from "./projects-store.ts";
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
import { constantTimeTokenEqual } from "./token-compare.ts";
import { usageRoutes } from "./usage-handler.ts";
import { withUsagePulseDebounce } from "./usage-pulse-debounce.ts";
import { createUsageStore, type UsageStore } from "./usage-store.ts";
import { createWorkflowAuthoringTools } from "./workflow-authoring-tools.ts";
import { createWorkflowStore } from "./workflow-store.ts";
import { createWorkflowChatTools } from "./workflow-tools.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  handleWorkflowRunUpgrade,
  type WorkflowController,
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
  // (keelson stop) can present it. onShutdown is invoked after the
  // response is sent; the caller owns process exit.
  shutdown?: { token: string; onShutdown: () => void };
  // Bearer token the MCP endpoint requires when config.mcp.requireToken is set
  // (recorded in server.json by serveUntilSignal). Ignored when MCP runs
  // tokenless (the default). Separate from the shutdown token by design.
  mcpToken?: string;
  // Operator-facing version recorded in server.json (`keelson status`
  // reports it). The CLI passes its release version; the private @keelson/server
  // package's own version is meaningless to an operator.
  version?: string;
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
  // The MCP bearer token actually being enforced (undefined when the endpoint
  // is tokenless or disabled). serveUntilSignal persists exactly this to
  // server.json, so the on-disk token never disagrees with what the handler
  // enforces — startServer is the single authority on the requireToken decision.
  readonly mcpToken?: string;
  // Drain runs, dispose ribs, close the snapshot manager + database. Does NOT
  // call process.exit — the signal handlers installed by startServer do that.
  shutdown(): Promise<void>;
}

// Build the database, ribs, workflow subsystem, and HTTP/WS routes, then serve.
// Runs the same bootstrap whether invoked as the `bun src/index.ts` entrypoint
// or imported in-process by `keelson start`. Reads its data home via
// resolveKeelsonHome (KEELSON_HOME → project .keelson/ → ~/.keelson).
export async function startServer(config: StartServerConfig = {}): Promise<ServerHandle> {
  // The managed keelson home: KEELSON_HOME → an existing .keelson/ walking up
  // from cwd (the monorepo dev case) → ~/.keelson. Holds keelson.db + workflows/.
  const KEELSON_HOME = resolveKeelsonHome();
  const paths = keelsonPaths(KEELSON_HOME);
  mkdirSync(KEELSON_HOME, { recursive: true });
  // A seed failure must not block boot — the server is fully usable with an
  // empty workflows dir.
  try {
    seedStarterAssets(paths.home, paths.workflowsDir);
  } catch (err) {
    console.warn(`failed to seed starter assets: ${err}`);
  }

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

  // Holds regions ribs add at runtime (RibContext.registerRegion); feeds both the
  // per-rib seam and the GET /api/ribs merge. Each change recomposes the
  // manifest-revision beacon below so subscribed SPAs re-fetch the manifest.
  const dynamicRegionStore = createDynamicRegionStore({
    onChange: () => void snapshotManager.recompose(RIBS_VERSION_SNAPSHOT_KEY),
  });
  // Registered once on the base manager and never unregistered: a re-register
  // would reset the frame version and the client's version guard would then drop
  // subsequent bumps. The payload is a debug aid; clients react to the version.
  snapshotManager.register(RIBS_VERSION_SNAPSHOT_KEY, () => ({
    revision: dynamicRegionStore.revision,
  }));
  void snapshotManager.recompose(RIBS_VERSION_SNAPSHOT_KEY);

  // The ASK approval round-trip: a policy `ask` opens a pause here; the snapshot
  // key republishes the open set (redacted) so the SPA/CLI can render and resolve
  // it via POST /api/approvals/:id. Created before the policy engine so its
  // `request` callback can be wired in as the engine's approval channel.
  const approvals = createApprovalRegistry({
    onChange: () => void snapshotManager.recompose(POLICY_APPROVALS_SNAPSHOT_KEY),
  });
  snapshotManager.register(POLICY_APPROVALS_SNAPSHOT_KEY, () => approvals.list(), {
    validate: (d) => policyApprovalsSnapshotSchema.parse(d),
  });
  void snapshotManager.recompose(POLICY_APPROVALS_SNAPSHOT_KEY);

  // Canvas artifacts: file-backed pages under <home>/artifacts, each driving a
  // `canvas:artifact:<slug>` key on the base snapshot manager. Tools register
  // into the shared registry BEFORE registerRibTools below, so the harness
  // owns the canvas_* names and a colliding rib tool is skipped, mirroring the
  // workflow_* authority rule in chat-handler.
  const artifactStore = createArtifactStore(paths.artifactsDir);
  const canvasTools = createCanvasTools({ store: artifactStore, snapshotManager });
  registerRibTools(canvasTools.tools);
  canvasTools.registerExisting();

  // Keyring store is needed before ribs so each rib gets a namespaced, read-only
  // credential reader scoped to its own keys.
  const credentialStore = createKeyringStore();

  // Late-bound: assigned from the ribs' contributed policies AFTER bootstrapRibs
  // returns. The rib-agent-turn seam (constructed inside bootstrapRibs) reads it
  // lazily through this getter at turn time, by which point it's set.
  let policyEngine: PolicyEngine | undefined;
  // Late-bound like policyEngine: the controller is created further down (after
  // the store/catalog are up), but RibContext.refreshWorkflow needs it. The
  // resolver reads it lazily through this ref, set right after the controller is
  // built — by which point any rib refresh call has boot complete.
  let workflowControllerRef: WorkflowController | undefined;
  // Late-bound like the refs above: the projects store is created further down
  // (it needs the database), but RibContext.getProjects reads it lazily at turn
  // time — a rib lists projects to pin a turn's cwd to a project root. A rib that
  // (unusually) reads projects during registerTools, before the store is wired,
  // sees an empty list: project selection is a runtime concern, not an activation one.
  let projectsStoreRef: ProjectsStore | undefined;
  // Late-bound like the refs above: the memory store needs the database (created below),
  // but RibContext.getMemory reads it lazily at recall/writeback time, by which point boot
  // is done. A rib's coordinator uses it to fold prior decisions into a run and write
  // learnings back to the governed ledger.
  let memoryStoreRef: MemoryStore | undefined;
  // Late-bound like the refs above: the usage store needs the database (created
  // below), but the default runAgentTurn seam records a rib usage event lazily
  // at turn-settle time, by which point boot is done.
  let usageStoreRef: UsageStore | undefined;
  const ribs = await bootstrapRibs({
    ribsRoot: paths.ribsRoot,
    snapshotManager,
    dynamicRegionStore,
    getRibCredential: (ribId, serviceId) =>
      createRibCredentialAccessor(credentialStore, ribId)(serviceId),
    getRibDataDir: (ribId) => ribDataDir(ribId, KEELSON_HOME),
    getProjects: () => projectsStoreRef?.list() ?? [],
    getPolicyEngine: () => policyEngine,
    getWorkflowController: () => workflowControllerRef,
    getMemoryStore: () => memoryStoreRef,
    getUsageStore: () => usageStoreRef,
    // Same cwd the heartbeat scheduler uses (repoRoot below), so a rib refresh
    // collapses onto an in-flight heartbeat run instead of racing it.
    refreshCwd: KEELSON_HOME,
  });
  // Docs catalog behind keelson_docs: keelson's own published corpus plus any
  // docs a rib contributed. Registered BEFORE ribs.tools so the harness owns the
  // keelson_docs name and a colliding rib tool is skipped — the same authority
  // rule canvas_* / workflow_* follow. Core lists its own docs but never names a
  // rib; installed ribs extend the catalog through their contributions.
  const docsSources: DocsSource[] = [
    KEELSON_CORE_DOCS_SOURCE,
    ...stampRibDocsSources(ribs.docsContributions),
  ];
  const docsCatalog = new DocsCatalog({
    sources: docsSources,
    cacheDir: join(paths.home, "docs-cache"),
  });
  registerRibTools([createDocsTool({ catalog: docsCatalog })]);
  // Register rib-contributed tools into the shared registry so the chat agent,
  // /api/tools, and workflow prompt nodes all pick them up via getRegisteredTools.
  registerRibTools(ribs.tools);
  // Narrow rib-contributed workflow definitions and collect the run-path bindings
  // that republish a bound run's structured output to the rib's snapshot key.
  const ribWorkflows = prepareRibWorkflows(ribs.workflowContributions);
  // Unified governance: operator denylist floor + rib-contributed policies. The
  // three turn seams (chat, workflow prompt nodes, rib agent turns) gate their
  // projected tools through this one engine; an `ask` rides the approval registry.
  policyEngine = bootstrapPolicyEngine({
    ribPolicies: ribs.policies,
    requestApproval: approvals.request,
  });

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
  const store = createConversationStore(db, {
    onArtifactsOrphaned: (slugs) => {
      for (const slug of slugs) {
        artifactStore.remove(slug);
        canvasTools.unregister(slug);
      }
    },
  });
  const workflowStore = createWorkflowStore(db);
  const memoryStore = createMemoryStore(db);
  // Publish to the late-bound ref so RibContext.getMemory resolves once boot completes.
  memoryStoreRef = memoryStore;
  const rawUsageStore = createUsageStore(db);
  // Registered once on the base manager, mirroring RIBS_VERSION_SNAPSHOT_KEY:
  // the live pulse widget subscribes to today's totals + trailing-60-minute
  // series without polling GET /api/usage/summary.
  snapshotManager.register(USAGE_PULSE_SNAPSHOT_KEY, () => rawUsageStore.pulse(), {
    validate: (d) => usagePulseSnapshotSchema.parse(d),
  });
  void snapshotManager.recompose(USAGE_PULSE_SNAPSHOT_KEY);
  // Debounced so a turn's burst of record() calls (chat/workflow/rib capture
  // seams) coalesces into one recompose instead of a storm of snapshot
  // broadcasts. The three capture seams keep calling record() unaware of it.
  const usageStore = withUsagePulseDebounce(
    rawUsageStore,
    () => void snapshotManager.recompose(USAGE_PULSE_SNAPSHOT_KEY),
  );
  // Publish to the late-bound ref so the default runAgentTurn seam can record
  // rib-sourced usage events once boot completes.
  usageStoreRef = usageStore;
  const projectsStore = createProjectsStore(db);
  projectsStoreRef = projectsStore;
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
    bundledDir: bundledWorkflowsDir(),
    listProjects: () => projectsStore.list(),
    extra: ribWorkflows.definitions,
    ribProvenance: ribWorkflows.provenance,
    ribNames: new Map(ribs.manifests.map((m) => [m.id, m.displayName])),
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
    // Final global gate for workflow prompt nodes — the engine owns the operator
    // denylist + rib policies here, so the handler's own floor stands down.
    projectTools: (candidates, provider) =>
      policyEngine
        ? policyEngine
            .projectTools(candidates, {
              surface: "workflow",
              ...(provider !== undefined ? { provider } : {}),
            })
            .then((r) => r.allowed)
        : Promise.resolve(candidates),
    // Per-call args-aware gate for the same nodes — runs the policy stack again
    // for each individual tool call with its args (a tool cleared into the
    // projection above can still be denied here on the strength of its args).
    // Forward the node's teardown signal so a pending `ask` cancels with the run.
    evaluateToolCall: (call, provider, signal) =>
      policyEngine
        ? policyEngine.evaluateToolCall(call, {
            surface: "workflow",
            ...(provider !== undefined ? { provider } : {}),
            ...(signal !== undefined ? { signal } : {}),
          })
        : Promise.resolve({ outcome: "allow" as const }),
    // Per-result gate for prompt nodes — runs the `tool_result` phase on each
    // tool's output before the model consumes it. Wired only when a policy reads
    // the phase, so the default path runs no per-result evaluation.
    evaluateToolResult:
      policyEngine?.resultPhaseActive === true
        ? (call, provider) =>
            policyEngine.evaluateToolResult(call, {
              surface: "workflow",
              ...(provider !== undefined ? { provider } : {}),
            })
        : undefined,
    // Response gate — runs the `response` phase on the node's complete output
    // before it propagates to dependent nodes. Wired only when a policy reads
    // the phase. A deny fails the node; an allow+data substitutes the output.
    evaluateResponse:
      policyEngine?.responsePhaseActive === true
        ? (text, provider) =>
            policyEngine.evaluateResponse({
              surface: "workflow",
              text,
              ...(provider !== undefined ? { provider } : {}),
            })
        : undefined,
    // Request-phase budget gate for prompt nodes: before a node opens its
    // provider session, check the run's accumulated spend against the budget
    // builtins. Skipped (no usage/model lookups) when no policy reads the
    // request phase, so the default no-budget path stays free.
    requestGate: async ({ runId }, model, provider) => {
      const engine = policyEngine;
      if (!engine?.requestPhaseActive) return { outcome: "allow" as const };
      const usage = workflowStore.getRunUsageTotals(runId);
      const hint =
        provider !== undefined && isRegisteredProvider(provider)
          ? await resolveModelCostHint(getAgentProvider(provider), model)
          : undefined;
      return engine.evaluateRequest({
        surface: "workflow",
        ...(provider !== undefined ? { provider } : {}),
        ...(hint !== undefined ? { model: hint } : {}),
        usage,
      });
    },
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
    usageStore,
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
  // Publish the late-bound ref the refreshWorkflow resolver reads; boot is
  // complete here, so a rib's refresh resolves the controller, not undefined.
  workflowControllerRef = workflowController;
  const workflowTools = createWorkflowChatTools({
    controller: workflowController,
    catalog: workflowCatalog,
    projectsStore,
  });
  // Built here (not in chat-handler) so the save target stays pinned to the
  // same resolved workflowsDir the catalog scans.
  const workflowAuthoringTools = (project: { id: string; rootPath: string } | null) =>
    createWorkflowAuthoringTools({
      catalog: workflowCatalog,
      globalWorkflowsDir: paths.workflowsDir,
      project,
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
  // Scheduled-run retention (keep newest few terminal producer runs per
  // workflow) is a creation-time invariant in startRunCore, so it covers the
  // heartbeat and panel /refresh uniformly — nothing to wire here.
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
  // MCP gateway over the tool registry. Resolved here (registry is populated
  // and WORKSPACE_ROOT is known); constructed + mounted alongside the other
  // routes below, and torn down in drain before ribs dispose.
  const mcpSettings = resolveMcpSettings(loadKeelsonConfig());
  let mcpRoutes: McpRoutesHandle | null = null;

  const drain = async (): Promise<void> => {
    // Stop the heartbeat first so no tick enqueues a fresh run mid-drain.
    scheduler.stop();
    try {
      await activeWorkflowRuns.abortAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[keelson] workflow run drain during shutdown failed: ${msg}`);
    }
    if (mcpRoutes) {
      try {
        await mcpRoutes.dispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[keelson] MCP transport teardown during shutdown failed: ${msg}`);
      }
    }
    // Reject any open ASK approvals so a paused turn denies and unwinds rather
    // than hanging on a pause nobody will resolve once the server is down.
    approvals.clear();
    // Stop any warm provider subprocess (Copilot's reused language-server)
    // before the rest tears down, so shutdown reaps it rather than orphaning it.
    try {
      await disposeAllProviders();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[keelson] provider drain during shutdown failed: ${msg}`);
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
      const presented = /^bearer\s+(.+)$/i.exec(header.trim())?.[1] ?? "";
      if (presented.length === 0 || !constantTimeTokenEqual(presented, token)) {
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
    {
      projectsStore,
      ...(bootstrap.defaultProvider ? { defaultProvider: bootstrap.defaultProvider } : {}),
      workflowTools,
      workflowAuthoringTools,
    },
  );
  workflowsRoutes(app, workflowHandlerOptions, activeWorkflowRuns, workflowSubscribers);
  snapshotsRoutes(app, { manager: snapshotManager, subscribers: snapshotSubscribers });
  ribsRoutes(app, {
    manifests: ribs.manifests,
    probes: ribs.probes,
    actionHandlers: ribs.actionHandlers,
    dynamicRegionStore,
  });
  agentsRoutes(app, {
    agentListers: ribs.agentListers,
    agentResolvers: ribs.agentResolvers,
  });
  commandsRoutes(app, {
    commandListers: ribs.commandListers,
    commandInvokers: ribs.commandInvokers,
    commandCompleters: ribs.commandCompleters,
  });
  projectsRoutes(app, { store: projectsStore, projectsRoot: WORKSPACE_ROOT });
  memoryRoutes(app, { memoryStore });
  usageRoutes(app, { store: usageStore });
  projectNotebookRoutes(app, { store: projectNotebookStore, projectsStore });
  chatRememberRoutes(app, { conversationStore: store, memoryStore });
  credentialsRoutes(app, credentialStore, {
    copilotAuthProbe: bootstrap.copilotAuthProbe,
    claudeAuthProbe: bootstrap.claudeAuthProbe,
  });
  gatewaysRoutes(app, credentialStore, {
    onGatewayUpserted: (gw) => {
      // Replace any prior registration so an edit (baseUrl/model/key) takes
      // effect on the next turn without a server restart.
      unregisterProvider(gw.name);
      registerGatewayProvider({
        id: gw.name,
        baseUrl: gw.baseUrl,
        getApiKey: () => getCredential(gatewayCredentialServiceId(gw.name)),
        ...(gw.model ? { model: gw.model } : {}),
      });
    },
    onGatewayRemoved: (name) => {
      unregisterProvider(name);
    },
  });
  approvalsRoutes(app, { registry: approvals });

  // The MCP token actually enforced, reported on the handle so serveUntilSignal
  // persists exactly it (single source of truth for the requireToken decision).
  let enforcedMcpToken: string | undefined;
  if (mcpSettings.enabled) {
    if (mcpSettings.requireToken && config.mcpToken === undefined) {
      // Fail closed: a gate was requested but no token is available to enforce
      // it (e.g. an embedder calling startServer without serveUntilSignal).
      console.warn(
        "[keelson] config.mcp.requireToken is set but no MCP token was provided; MCP endpoint disabled.",
      );
    } else {
      mcpRoutes = createMcpRoutes({
        settings: mcpSettings,
        defaultCwd: WORKSPACE_ROOT,
        version: config.version ?? pkg.version,
        // Workflow chat tools live on the chat path, not the registry; inject
        // them so MCP clients see workflow_list/status (and, when
        // exposeStateChanging is set, workflow_run/respond — both state-changing).
        extraTools: workflowTools,
        ...(config.mcpToken !== undefined ? { token: config.mcpToken } : {}),
        // Same policy stack the chat/workflow surfaces use, so MCP-invoked tools
        // honor the operator denylist, ask_on_shell, and redaction floor.
        ...(policyEngine ? { policyEngine } : {}),
      });
      mcpRoutes.mount(app);
      if (mcpSettings.requireToken) enforcedMcpToken = config.mcpToken;
    }
  }

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
    workflowAuthoringTools,
    usageStore,
    ...(policyEngine ? { policyEngine } : {}),
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
    ...(enforcedMcpToken !== undefined ? { mcpToken: enforcedMcpToken } : {}),
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
// process-owning entry both `bun src/index.ts` (dev) and `keelson start`
// (in-process) use; startServer itself installs no signal handlers. It also
// owns the home's server.json record so `keelson status`/`stop` can
// find the pid, URL, and shutdown token. SIGHUP (SSH/terminal close) is a
// graceful stop in the foreground; a `keelson start` child sets
// KEELSON_SERVE_BACKGROUND=1 and ignores it so the server outlives the
// terminal that launched it.
export async function serveUntilSignal(config: StartServerConfig = {}): Promise<never> {
  const home = resolveKeelsonHome();
  const shutdownToken = randomBytes(32).toString("hex");
  // Always mint a candidate MCP token and hand it to startServer; startServer
  // is the single authority on whether the gate is active and echoes back the
  // token it actually enforces (handle.mcpToken). We persist only that, so a
  // tokenless run writes no token and the on-disk value never disagrees with
  // what the handler enforces.
  const mcpToken = randomBytes(32).toString("hex");
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
    mcpToken,
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
        ...(handle.mcpToken !== undefined ? { mcpToken: handle.mcpToken } : {}),
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

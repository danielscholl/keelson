// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClaudeAuthProbe,
  type CopilotAuthProbe,
  getAgentProvider,
  getProviderInfoList,
  isRegisteredProvider,
  registerClaudeProvider,
  registerCodexProvider,
  registerConfiguredGateways,
  registerCopilotProvider,
  registerPiProvider,
  registerStubProvider,
  registerWorkflowProvider,
} from "@keelson/providers";
import type {
  AgentSummary,
  ApprovalDecision,
  ApprovalRequest,
  CommandCompletion,
  CommandInvokeResult,
  MemoryTools,
  OpenChatSeed,
  Project,
  Rib,
  RibAction,
  RibActionResult,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAuthStatus,
  RibCommandDescriptor,
  RibContext,
  RibWorkflowRunResult,
  SnapshotManager,
  ToolDefinition,
  WorkflowDiscoveryNotice,
  WorkflowSource,
} from "@keelson/shared";
import { recallRequestSchema, writebackRequestSchema } from "@keelson/shared";
import {
  BUILT_IN_PROVIDER_IDS,
  loadKeelsonConfig,
  resolveDefaultProvider,
  resolveEnabledProviders,
} from "@keelson/shared/config";
import { runJSON, runText } from "@keelson/shared/exec";
import { projectWorkflowsDir } from "@keelson/shared/paths";
import { getRegisteredTools, isRegisteredTool, registerTool } from "@keelson/skills";
import {
  DEFAULT_TOOL_DENYLIST,
  discoverWorkflows,
  makePromptHandler,
  type NodeHandler,
  type PromptHandlerProvider,
  type PromptRequestGate,
  type PromptResponseGate,
  type PromptToolCallGate,
  type PromptToolGate,
  type PromptToolResultGate,
  validateWorkflowInvariants,
  type WorkflowDefinition,
  type WorkflowLoadWarning,
  type WorkflowWithSource,
  workflowDefinitionSchema,
} from "@keelson/workflows";
import type { DynamicRegionStore } from "./dynamic-region-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import {
  createPolicyEngine,
  type PolicyEngine,
  type RibPolicyContribution,
} from "./policy-engine.ts";
import { makeRibAgentTurn } from "./rib-agent-turn.ts";
import { discoverRibs } from "./rib-discovery.ts";
import { applyRibs, parseRibList, type RibManifest, type RibWorkflowContribution } from "./ribs.ts";
// Type-only (erased at runtime) so the existing workflows-handler -> bootstrap
// import direction is not turned into a runtime cycle.
import type { WorkflowController } from "./workflows-handler.ts";

// A bound rib workflow ready to feed the run path: the workflow name plus the
// callback that republishes a structured run output to the rib's snapshot key.
export interface RibWorkflowBinding {
  publish: (value: unknown) => void;
}

export interface BootstrapProvidersOptions {
  getCredential: (serviceId: string) => Promise<string | undefined>;
}

export interface BootstrapProvidersResult {
  // Set when the matching provider is registered; absent otherwise. The
  // credentials handler uses these to render CLI-aware sign-in surfaces.
  copilotAuthProbe?: CopilotAuthProbe;
  claudeAuthProbe?: ClaudeAuthProbe;
  // The provider new chats and the workflow fallback default to. Undefined only
  // when nothing chat-capable is registered.
  defaultProvider?: string;
}

export function bootstrapProviders(options: BootstrapProvidersOptions): BootstrapProvidersResult {
  // Precedence: KEELSON_PROVIDERS env → config.json `providers` map → defaults
  // (copilot on; stub, claude, pi opt-in). Resolution lives in @keelson/shared so
  // the server and the CLI's in-process path register the identical set.
  const config = loadKeelsonConfig();
  const requested = resolveEnabledProviders({
    config,
    envProviders: process.env.KEELSON_PROVIDERS,
    known: BUILT_IN_PROVIDER_IDS,
  });
  const result: BootstrapProvidersResult = {};
  for (const id of requested) {
    switch (id) {
      case "stub":
        registerStubProvider();
        break;
      case "copilot": {
        const reg = registerCopilotProvider({
          getCredential: options.getCredential,
        });
        result.copilotAuthProbe = reg.checkAuthStatus;
        break;
      }
      case "claude": {
        const reg = registerClaudeProvider({
          getCredential: options.getCredential,
          ...(config.claude?.auth !== undefined ? { authPreference: config.claude.auth } : {}),
        });
        result.claudeAuthProbe = reg.checkAuthStatus;
        break;
      }
      case "pi":
        // Self-managed auth (pi's own ~/.pi/agent/auth.json + vendor env keys),
        // so nothing to thread through getCredential.
        registerPiProvider();
        break;
      case "codex":
        // Self-managed auth (codex's own ~/.codex/auth.json + OPENAI_API_KEY),
        // so nothing to thread through getCredential.
        registerCodexProvider({
          ...(config.codex?.sandbox !== undefined ? { sandboxMode: config.codex.sandbox } : {}),
          ...(config.codex?.network !== undefined
            ? { networkAccessEnabled: config.codex.network }
            : {}),
        });
        break;
    }
  }
  // Configured OpenAI-compatible gateways, each registered as a provider named
  // for the gateway. Registered before defaultProvider resolution so a gateway
  // can be the configured default, after the built-ins so it can't shadow one.
  registerConfiguredGateways({
    gateways: config.gateways ?? [],
    getApiKey: options.getCredential,
  });
  // Always-on, non-chat provider that backs workflow-linked conversations.
  // Registered AFTER the selectable providers so it sits at the end of
  // getProviderInfoList() and isn't picked as a chat default.
  registerWorkflowProvider();
  result.defaultProvider = resolveDefaultProvider(
    config,
    getProviderInfoList().map((p) => p.id),
  );
  return result;
}

export interface BootstrapRibsOptions {
  // Omitted runs discovery; explicit (even `{}`) bypasses it.
  available?: Readonly<Record<string, Rib>>;
  // node_modules/@keelson directory discovery scans. Defaults to the keelson
  // home's rib tree (resolveRibsRoot). Ignored when `available` is supplied.
  ribsRoot?: string;
  // Shared SnapshotManager passed into RibContext and used to auto-register
  // each rib's `composeBundle`. Optional so unit tests for parseRibList /
  // applyRibs don't need to spin up a manager.
  snapshotManager?: SnapshotManager;
  // Builds a rib's namespaced read-only credential reader. Optional so unit
  // tests without a credential store stay deterministic.
  getRibCredential?: (ribId: string, serviceId: string) => Promise<string | undefined>;
  // Resolves a rib's data directory (RibContext.getDataDir), rooted at the
  // keelson home. The composition root passes `(id) => ribDataDir(id, home)`.
  // Optional so applyRibs/parseRibList unit tests stay home-free.
  getRibDataDir?: (ribId: string) => string;
  // Backs RibContext.getProjects — a read-only project list for project-as-context
  // turn cwd. The composition root passes `() => projectsStore.list()`. Optional so
  // bootstrapRibs unit tests without a projects store stay deterministic.
  getProjects?: () => readonly Project[];
  // Agent-turn factory. Defaults to the CLI-backed makeRibAgentTurn;
  // injectable so tests pass a fake instead of shelling a provider CLI.
  runAgentTurn?: (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn;
  // Lazy resolver for the policy engine the default makeRibAgentTurn consults
  // when gating a turn's projected tools. Lazy because the engine is built from
  // these same ribs' policies AFTER bootstrapRibs returns — the getter reads the
  // composition root's late-bound binding at turn time, by which point boot is done.
  getPolicyEngine?: () => PolicyEngine | undefined;
  // Backs RibContext.registerRegion. Owned by the composition root (it also
  // feeds the GET /api/ribs merge), so it's threaded in rather than created here.
  dynamicRegionStore?: DynamicRegionStore;
  // Lazy resolver for the in-process WorkflowController backing
  // RibContext.refreshWorkflow. Lazy because the controller is built AFTER
  // bootstrapRibs returns — the getter reads the composition root's late-bound
  // binding at refresh time, by which point boot is done.
  getWorkflowController?: () => WorkflowController | undefined;
  // The working dir refreshWorkflow re-runs producers with. Must equal the
  // heartbeat scheduler's repoRoot (the keelson home) so the (name, cwd, {})
  // de-dupe key aligns and a refresh collapses onto an in-flight heartbeat run.
  refreshCwd?: string;
  // Lazy resolver for the MemoryStore backing RibContext.getMemory. Lazy because the
  // store needs the db, which is created AFTER bootstrapRibs returns — the getter reads
  // the composition root's late-bound binding at recall/writeback time, by which point
  // boot is done. Absent leaves the getMemory seam off the ctx (no governed memory).
  getMemoryStore?: () => MemoryStore | undefined;
}

export interface RibBootstrap {
  readonly manifests: RibManifest[];
  // Live auth-status probes keyed by rib id, resolved per-request by GET /api/ribs.
  readonly probes: Map<string, () => Promise<RibAuthStatus>>;
  // Inbound action handlers keyed by rib id, dispatched by POST /api/ribs/:id/action.
  readonly actionHandlers: Map<string, (action: RibAction) => Promise<RibActionResult>>;
  // Agent discovery/resolution keyed by rib id — the GET /api/agents source.
  readonly agentListers: Map<string, () => Promise<readonly AgentSummary[]>>;
  readonly agentResolvers: Map<string, (slug: string) => Promise<OpenChatSeed | null>>;
  // Slash commands keyed by rib id — the GET /api/commands source.
  readonly commandListers: Map<string, () => Promise<readonly RibCommandDescriptor[]>>;
  readonly commandInvokers: Map<
    string,
    (name: string, arg: string) => Promise<CommandInvokeResult>
  >;
  readonly commandCompleters: Map<
    string,
    (name: string, prefix: string) => Promise<readonly CommandCompletion[]>
  >;
  // Raw workflow contributions, narrowed + merged into the catalog separately.
  readonly workflowContributions: RibWorkflowContribution[];
  // Rib-contributed policies, tagged by owning rib — folded into the PolicyEngine
  // at the composition root.
  readonly policies: RibPolicyContribution[];
  // Validated, de-duplicated tools across every active rib. The composition
  // root registers these via `registerRibTools` so they reach chat + workflow
  // prompt nodes; held here (not registered in this pure function) so the many
  // tests that call bootstrapRibs don't accrue global registry state.
  readonly tools: ToolDefinition[];
  // Invoke every activated rib's optional `dispose()` hook. Errors from one
  // disposer log a warning and never block the rest — shutdown must
  // make forward progress.
  disposeAll(): Promise<void>;
}

export async function bootstrapRibs(options: BootstrapRibsOptions = {}): Promise<RibBootstrap> {
  const requested = parseRibList(process.env.KEELSON_RIBS);
  const available =
    options.available ?? (await discoverRibs(options.ribsRoot ? { root: options.ribsRoot } : {}));
  const active = requested.length > 0 ? requested : Object.keys(available);
  const snapshotManager = options.snapshotManager;
  // The template ctx carries only exec/sidecar; applyRibs layers a scoped
  // snapshot manager + namespaced credential reader on top, per rib.
  const ctx: RibContext = {
    getExec: () => ({ runJSON, runText }),
  };
  // The CLI-backed agent-turn seam (test override via options.runAgentTurn). Harmless
  // until a rib actually calls ctx.runAgentTurn — it only shells a CLI then.
  const runAgentTurn =
    options.runAgentTurn ??
    makeRibAgentTurn(options.getPolicyEngine ? { getPolicyEngine: options.getPolicyEngine } : {});
  // RibContext.refreshWorkflow resolver. Fires the EXISTING run facade with the
  // SAME (cwd, {}) the heartbeat uses so a refresh collapses onto an in-flight
  // heartbeat run; `origin: "scheduled"` forces scope=undefined so the rib's own
  // bound WorkflowDefinition object resolves and ribBinding.publish is reached.
  // Wired only when both the controller getter and the home cwd are supplied
  // (an embedder/test rig that omits either degrades to cadence-only).
  const getWorkflowController = options.getWorkflowController;
  const refreshCwd = options.refreshCwd;
  const refreshWorkflow =
    getWorkflowController && refreshCwd !== undefined
      ? async (_ribId: string, workflowName: string): Promise<void> => {
          const controller = getWorkflowController();
          if (!controller) return;
          try {
            const result = controller.startRun({
              name: workflowName,
              inputs: {},
              workingDir: refreshCwd,
              origin: "scheduled",
            });
            if (!result.ok) {
              console.warn(
                `[keelson] refreshWorkflow could not start '${workflowName}': ${result.message}`,
              );
            }
          } catch {
            // Fail-soft: a refresh must never surface to the rib.
          }
        }
      : undefined;
  // RibContext.runWorkflow resolver: hand an in-memory definition to the controller's
  // runDefinition (which validates + runs it on the shared executor and never throws).
  // cwd defaults to the home; a rib passes a project root to confine repo work. Wired
  // only when the controller getter + home cwd are present (else the seam is absent).
  const runWorkflowSeam =
    getWorkflowController && refreshCwd !== undefined
      ? async (
          _ribId: string,
          definition: unknown,
          inputs: Record<string, string>,
          opts?: { cwd?: string },
        ): Promise<RibWorkflowRunResult> => {
          try {
            const controller = getWorkflowController();
            if (!controller) {
              return { status: "failed", nodes: {}, error: "workflow controller unavailable" };
            }
            return await controller.runDefinition(definition, inputs, opts?.cwd ?? refreshCwd);
          } catch (err) {
            return {
              status: "failed",
              nodes: {},
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      : undefined;
  // RibContext.getMemory resolver: a MemoryTools handle bridging the rib to the governed
  // memory ledger. recall/writeback re-parse with the wire schemas at this adapter
  // boundary (matching the executor's memoryTools) before reaching the store; an absent
  // store at call time throws so the rib's fail-soft wrapper surfaces it. Wired only when
  // the store getter is supplied (else the seam is absent — degrades to no memory).
  const getMemoryStore = options.getMemoryStore;
  const getMemory = getMemoryStore
    ? (_ribId: string): MemoryTools => ({
        recall: async (req) => {
          const store = getMemoryStore();
          if (!store) throw new Error("memory store unavailable");
          return store.recall(recallRequestSchema.parse(req));
        },
        writeback: async (req) => {
          const store = getMemoryStore();
          if (!store) throw new Error("memory store unavailable");
          return store.writeback(writebackRequestSchema.parse(req));
        },
      })
    : undefined;
  const {
    manifests,
    disposers,
    probes,
    actionHandlers,
    agentListers,
    agentResolvers,
    commandListers,
    commandInvokers,
    commandCompleters,
    workflowContributions,
    policies,
    tools,
  } = applyRibs({
    active,
    available,
    ctx,
    runAgentTurn,
    ...(snapshotManager ? { snapshotManager } : {}),
    ...(options.getRibCredential ? { getRibCredential: options.getRibCredential } : {}),
    ...(options.getRibDataDir ? { getRibDataDir: options.getRibDataDir } : {}),
    ...(options.getProjects ? { getProjects: options.getProjects } : {}),
    ...(options.dynamicRegionStore ? { dynamicRegionStore: options.dynamicRegionStore } : {}),
    ...(refreshWorkflow ? { refreshWorkflow } : {}),
    ...(runWorkflowSeam ? { runWorkflow: runWorkflowSeam } : {}),
    ...(getMemory ? { getMemory } : {}),
  });
  return {
    manifests,
    probes,
    actionHandlers,
    agentListers,
    agentResolvers,
    commandListers,
    commandInvokers,
    commandCompleters,
    workflowContributions,
    policies,
    tools,
    async disposeAll() {
      for (const d of disposers) {
        try {
          await d.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[keelson] rib '${d.id}' dispose() threw: ${msg}`);
        }
      }
    },
  };
}

// Register a rib bootstrap's collected tools into the shared tool registry so
// they reach the chat agent (and workflow `prompt` nodes) through the provider
// tool adapters. Called once at real boot from the composition root; kept out
// of bootstrapRibs so its many tests don't mutate the process-global registry.
// Tolerant of an already-claimed name (warn + skip) so a re-boot in a
// long-lived process can't crash on a duplicate.
export function registerRibTools(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) {
    if (isRegisteredTool(tool.name)) {
      console.warn(`[keelson] tool '${tool.name}' is already registered; skipping`);
      continue;
    }
    registerTool(tool);
  }
}

// Narrow each rib workflow contribution against the workflow schema. Invalid
// definitions warn and skip (a rib-package bug shouldn't down the server).
// Returns the merge-ready definitions plus the run-path binding map, keyed by
// the parsed definition *object* — the exact object the catalog stores for that
// workflow. The run path looks a binding up by the definition it's about to run,
// so a project workflow that shadows the name (or a same-name collision between
// ribs) resolves to a different object and simply finds no binding. This stays
// correct across catalog hot-reloads without any re-pruning.
export interface RibWorkflowProvenance {
  ribId: string;
  // A bound producer (the run path republishes its output to a rib key) — the
  // heartbeat auto-refreshes it and the operator never starts it by hand.
  background: boolean;
}

export function prepareRibWorkflows(contributions: readonly RibWorkflowContribution[]): {
  definitions: WorkflowDefinition[];
  bindings: Map<WorkflowDefinition, RibWorkflowBinding>;
  // Workflow name → bound snapshot key, for boot-time surface-schedule
  // validation only. Name-keyed (not object-identity like `bindings`) because
  // its one consumer matches a region's declared `workflow` string.
  boundKeys: Map<string, string>;
  // Workflow name → owning rib id + background flag, so the catalog can stamp
  // each entry's source/origin. Name-keyed to match the catalog merge.
  provenance: Map<string, RibWorkflowProvenance>;
} {
  const definitions: WorkflowDefinition[] = [];
  const bindings = new Map<WorkflowDefinition, RibWorkflowBinding>();
  const boundKeys = new Map<string, string>();
  const provenance = new Map<string, RibWorkflowProvenance>();
  for (const contribution of contributions) {
    const parsed = workflowDefinitionSchema.safeParse(contribution.definition);
    if (!parsed.success) {
      console.warn(
        `[keelson] rib '${contribution.ribId}' contributed an invalid workflow: ${parsed.error.issues[0]?.message ?? "schema violation"}; skipping`,
      );
      continue;
    }
    const definition = parsed.data as WorkflowDefinition;
    // Apply the same structural invariants a YAML workflow gets at load —
    // reserved name (e.g. `runs` collides with /api/workflows/runs), empty
    // nodes, DAG shape, reserved node ids, output refs — so a rib can't smuggle
    // a catalog entry that the loader would have rejected.
    const invariantError = validateWorkflowInvariants(definition);
    if (invariantError) {
      console.warn(
        `[keelson] rib '${contribution.ribId}' contributed an invalid workflow: ${invariantError}; skipping`,
      );
      continue;
    }
    definitions.push(definition);
    const background = Boolean(contribution.publish);
    provenance.set(definition.name, { ribId: contribution.ribId, background });
    if (contribution.publish) {
      bindings.set(definition, { publish: contribution.publish });
      if (contribution.bindSnapshotKey !== undefined) {
        boundKeys.set(definition.name, contribution.bindSnapshotKey);
      }
    }
  }
  return { definitions, bindings, boundKeys, provenance };
}

export interface BootstrapWorkflowsOptions {
  // Directory to scan for `*.yaml` workflow files. Production callers pass
  // `${REPO_ROOT}/.keelson/workflows`; tests pass a fixture dir.
  workflowDir: string;
  // Lowest-precedence root for the shipped starter workflows, so new bundled
  // starters surface even in a home seeding skipped because it was already
  // populated (mirrors the CLI's discovery roots). Opt-in so fixture-based
  // tests don't inherit the real shipped starters; production passes
  // `bundledWorkflowsDir()`.
  bundledDir?: string;
  // Registered projects whose `<root>/.keelson/workflows` layers over the
  // global dir (project shadows global by name, visible only with that
  // project's scope). A callback rather than the store so each scan observes
  // project add/remove/rename without a rebootstrap, and tests can inject.
  listProjects?: () => readonly Pick<Project, "id" | "name" | "rootPath">[];
  // Rib-contributed definitions merged into the catalog. A filesystem workflow
  // of the same name wins (so an operator can override a rib's), and the
  // collision surfaces as a discovery notice.
  extra?: readonly WorkflowDefinition[];
  // Name → owning rib id + background flag for the `extra` definitions, used to
  // stamp each catalog entry's source. From prepareRibWorkflows().provenance.
  ribProvenance?: ReadonlyMap<string, RibWorkflowProvenance>;
  // Rib id → display name, from the activated manifests, so a rib-sourced entry
  // carries a human label for the UI badge.
  ribNames?: ReadonlyMap<string, string>;
}

// Where a catalog entry came from + whether it's a background producer. Always
// resolvable for a known name (defaults to a local, foreground workflow).
export interface WorkflowProvenance {
  source: WorkflowSource;
  background: boolean;
}

const LOCAL_PROVENANCE: WorkflowProvenance = { source: { kind: "local" }, background: false };

// Narrows catalog reads to one project's view: that project's workflows
// overlaid on the global set, project winning name collisions. No/unknown
// projectId means the global view, exactly the pre-scope behavior.
export interface WorkflowScopeContext {
  projectId?: string;
}

export interface WorkflowCatalog {
  list(scope?: WorkflowScopeContext): WorkflowDefinition[];
  get(name: string, scope?: WorkflowScopeContext): WorkflowDefinition | undefined;
  // Definition plus the file it was loaded from. Rib-contributed entries have
  // no backing file and return undefined; callers needing only the definition
  // use get().
  getWithSource(name: string, scope?: WorkflowScopeContext): WorkflowWithSource | undefined;
  // Source (local / project / which rib) + background flag for a catalog
  // entry. Returns a local default for an unknown name so callers need no
  // null guard.
  provenance(name: string, scope?: WorkflowScopeContext): WorkflowProvenance;
  // Load-errors (file dropped) + non-fatal warnings, normalized for the
  // wire schema. The SPA toasts these once on first Workflows-tab load.
  // Project-dir notices surface only under that project's scope.
  discoveryNotices(scope?: WorkflowScopeContext): WorkflowDiscoveryNotice[];
}

interface ProjectScopeSnapshot {
  byName: Map<string, WorkflowWithSource>;
  provenance: Map<string, WorkflowProvenance>;
  notices: WorkflowDiscoveryNotice[];
}

interface CatalogSnapshot {
  signature: string;
  byName: Map<string, WorkflowDefinition>;
  // Global file-backed entries only (rib extras have no path).
  withSource: Map<string, WorkflowWithSource>;
  provenance: Map<string, WorkflowProvenance>;
  byProject: Map<string, ProjectScopeSnapshot>;
  notices: WorkflowDiscoveryNotice[];
}

// Cheap fingerprint of the workflow dir: sorted name:mtime:size for each
// *.yaml/*.yml. It changes when a workflow file is edited, added, or removed,
// so the next access re-parses — without it, a static catalog would serve
// stale definitions until the server restarts. The readdir-failure and
// empty-dir sentinels are distinct from each other and from any real entry
// (which always contains a `:`): an unreadable dir surfaces a read_error
// notice while an empty/missing one doesn't, so they must not share a
// fingerprint or a stale snapshot would stick across the transition.
function catalogSignature(dir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    return `<readdir-failed:${code}>`;
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    try {
      const st = fs.statSync(path.join(dir, entry));
      if (!st.isFile()) continue;
      parts.push(`${entry}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Unreadable entry — discoverWorkflows will surface it as a load error.
    }
  }
  return parts.length === 0 ? "<empty>" : parts.join("|");
}

// Scans `workflowDir`, parses each *.yaml via the workflows loader, and
// returns a name → definition lookup. Parse errors log a warning and skip
// the file so a single broken workflow doesn't take the catalog down. Each
// accessor re-scans when the dir fingerprint changes, so YAML edits land on
// the next run without a server restart; an unchanged fingerprint is a cache
// hit (no re-parse), keeping the polling-heavy run/list reads cheap.
export function bootstrapWorkflows(opts: BootstrapWorkflowsOptions): WorkflowCatalog {
  const dir = opts.workflowDir;
  const bundledDir = opts.bundledDir;
  const extra = opts.extra ?? [];
  const ribProvenance = opts.ribProvenance;
  const ribNames = opts.ribNames;
  let cached: CatalogSnapshot | undefined;

  // In the monorepo dev layout the global dir already lives under a project
  // root, so registering that project would double-index every global
  // workflow as project-scoped; skip any project whose dir resolves there.
  // realpath, not resolve: a symlinked root (macOS /tmp → /private/tmp,
  // symlinked checkouts) must not make one physical dir look like two scopes.
  const canonicalPath = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const scopedProjects = () => {
    const resolvedGlobalDir = canonicalPath(dir);
    return (opts.listProjects?.() ?? [])
      .filter((p) => canonicalPath(projectWorkflowsDir(p.rootPath)) !== resolvedGlobalDir)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const scan = (): CatalogSnapshot => {
    const projects = scopedProjects();
    // The id:name prefix keys each fingerprint segment to the project, so
    // adding, removing, or renaming a project re-scans just like a file edit.
    const signature = [
      ...(bundledDir ? [`bundled:${catalogSignature(bundledDir)}`] : []),
      `global:${catalogSignature(dir)}`,
      ...projects.map(
        (p) =>
          `${p.id}:${p.name}:${p.rootPath}:${catalogSignature(projectWorkflowsDir(p.rootPath))}`,
      ),
    ].join("\n");
    if (cached && cached.signature === signature) return cached;
    // Bundled first so a same-named global file overrides it (later roots win).
    const result = discoverWorkflows([
      ...(bundledDir ? [{ dir: bundledDir, source: "bundled" as const }] : []),
      { dir, source: "global" },
    ]);
    const notices: WorkflowDiscoveryNotice[] = [];
    for (const error of result.errors) {
      console.warn(`[workflows] failed to load ${error.filename}: ${error.error}`);
      notices.push({
        level: "error",
        filename: error.filename,
        message: `failed to load: ${error.error}`,
      });
    }
    for (const warning of result.warnings) {
      const nodeRef = warning.nodeId ? ` (node ${warning.nodeId})` : "";
      console.warn(`[workflows] ${warning.filename}${nodeRef}: ${warning.message}`);
      notices.push(toDiscoveryNotice(warning));
    }
    const byName = new Map<string, WorkflowDefinition>();
    const withSource = new Map<string, WorkflowWithSource>();
    const provenance = new Map<string, WorkflowProvenance>();
    for (const entry of result.workflows) {
      byName.set(entry.workflow.name, entry.workflow);
      withSource.set(entry.workflow.name, entry);
      provenance.set(entry.workflow.name, LOCAL_PROVENANCE);
    }
    // Rib-contributed workflows fill in around the filesystem set; a name
    // collision keeps the filesystem definition so an operator can override.
    for (const definition of extra) {
      if (byName.has(definition.name)) {
        console.warn(
          `[workflows] rib workflow '${definition.name}' shadowed by a global workflow file of the same name`,
        );
        notices.push({
          level: "warning",
          filename: `<rib:${definition.name}>`,
          message: `rib workflow '${definition.name}' shadowed by a global workflow file of the same name`,
        });
        continue;
      }
      byName.set(definition.name, definition);
      const prov = ribProvenance?.get(definition.name);
      const ribId = prov?.ribId;
      const ribName = ribId !== undefined ? ribNames?.get(ribId) : undefined;
      provenance.set(definition.name, {
        source: {
          kind: "rib",
          ...(ribId !== undefined ? { ribId } : {}),
          ...(ribName !== undefined ? { ribName } : {}),
        },
        background: prov?.background ?? false,
      });
    }
    const byProject = new Map<string, ProjectScopeSnapshot>();
    for (const p of projects) {
      const projectDir = projectWorkflowsDir(p.rootPath);
      const projectResult = discoverWorkflows([{ dir: projectDir, source: "project" }]);
      const projectNotices: WorkflowDiscoveryNotice[] = [];
      for (const error of projectResult.errors) {
        console.warn(
          `[workflows] failed to load ${error.filename} (project ${p.name}): ${error.error}`,
        );
        projectNotices.push({
          level: "error",
          filename: error.filename,
          message: `failed to load: ${error.error}`,
        });
      }
      for (const warning of projectResult.warnings) {
        const nodeRef = warning.nodeId ? ` (node ${warning.nodeId})` : "";
        console.warn(
          `[workflows] ${warning.filename}${nodeRef} (project ${p.name}): ${warning.message}`,
        );
        projectNotices.push(toDiscoveryNotice(warning));
      }
      const projectByName = new Map<string, WorkflowWithSource>();
      const projectProvenance = new Map<string, WorkflowProvenance>();
      for (const entry of projectResult.workflows) {
        projectByName.set(entry.workflow.name, entry);
        projectProvenance.set(entry.workflow.name, {
          source: { kind: "project", projectId: p.id, projectName: p.name },
          background: false,
        });
      }
      if (projectByName.size > 0 || projectNotices.length > 0) {
        byProject.set(p.id, {
          byName: projectByName,
          provenance: projectProvenance,
          notices: projectNotices,
        });
      }
    }
    const projectCount = Array.from(byProject.values()).reduce((n, s) => n + s.byName.size, 0);
    console.log(
      `[workflows] discovered ${byName.size} workflows` +
        (projectCount > 0 ? ` (+${projectCount} project-scoped)` : ""),
    );
    cached = { signature, byName, withSource, provenance, byProject, notices };
    return cached;
  };

  // Prime once so the discovery count logs at boot and a broken dir surfaces
  // immediately, matching the previous build-at-boot behavior.
  scan();

  const projectView = (scope?: WorkflowScopeContext) => {
    const snapshot = scan();
    const project =
      scope?.projectId !== undefined ? snapshot.byProject.get(scope.projectId) : undefined;
    return { snapshot, project };
  };

  return {
    list: (scope) => {
      const { snapshot, project } = projectView(scope);
      if (!project) return Array.from(snapshot.byName.values());
      // Project entries first: downstream consumers truncate from the front
      // (the system-prompt index caps at 40 names), and the scope's own
      // workflows must never be the ones cut.
      const merged = new Map<string, WorkflowDefinition>();
      for (const [name, entry] of project.byName) merged.set(name, entry.workflow);
      for (const [name, definition] of snapshot.byName) {
        if (!merged.has(name)) merged.set(name, definition);
      }
      return Array.from(merged.values());
    },
    get: (name, scope) => {
      const { snapshot, project } = projectView(scope);
      return project?.byName.get(name)?.workflow ?? snapshot.byName.get(name);
    },
    getWithSource: (name, scope) => {
      const { snapshot, project } = projectView(scope);
      return project?.byName.get(name) ?? snapshot.withSource.get(name);
    },
    provenance: (name, scope) => {
      const { snapshot, project } = projectView(scope);
      return project?.provenance.get(name) ?? snapshot.provenance.get(name) ?? LOCAL_PROVENANCE;
    },
    discoveryNotices: (scope) => {
      const { snapshot, project } = projectView(scope);
      return project ? [...snapshot.notices, ...project.notices] : snapshot.notices;
    },
  };
}

function toDiscoveryNotice(w: WorkflowLoadWarning): WorkflowDiscoveryNotice {
  return {
    level: "warning",
    filename: w.filename,
    ...(w.nodeId ? { nodeId: w.nodeId } : {}),
    message: w.message,
  };
}

// Construct the unified policy engine: the operator denylist floor
// (DEFAULT_TOOL_DENYLIST + KEELSON_WORKFLOW_TOOL_DENYLIST) folded into the
// `tool_denylist` builtin, the opt-in `ask_on_shell` builtin (KEELSON_ASK_ON_SHELL=1),
// plus the ribs' contributed policies. Built at the composition root AFTER
// bootstrapRibs so rib-declared policies are known; `requestApproval` is the
// ApprovalRegistry's open-a-pause callback that lights up the ASK round-trip.
export function bootstrapPolicyEngine(
  opts: {
    ribPolicies?: readonly RibPolicyContribution[];
    requestApproval?: (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
  } = {},
): PolicyEngine {
  return createPolicyEngine({
    // parseToolDenylist returns DEFAULT_TOOL_DENYLIST only when the env var is
    // UNSET; once it's set, it returns just the env names. Union DEFAULT_TOOL_DENYLIST
    // in explicitly so the hard-coded floor is never lost when an operator also
    // sets the env var — matching the rib-agent-turn fallback (the engine builtin
    // dedups via a Set, so the unset double-include is harmless).
    denylist: [
      ...DEFAULT_TOOL_DENYLIST,
      ...parseToolDenylist(process.env.KEELSON_WORKFLOW_TOOL_DENYLIST),
    ],
    askOnShell: process.env.KEELSON_ASK_ON_SHELL === "1",
    ...(() => {
      const turnBudget = parsePositiveIntEnv(process.env.KEELSON_TURN_BUDGET);
      return turnBudget !== undefined ? { turnBudget } : {};
    })(),
    ...(() => {
      const costBudget = parsePositiveIntEnv(process.env.KEELSON_COST_BUDGET);
      return costBudget !== undefined ? { costBudget } : {};
    })(),
    ...(() => {
      const redactPattern = process.env.KEELSON_REDACT_PATTERN?.trim();
      return redactPattern ? { redactPattern } : {};
    })(),
    ...(opts.ribPolicies ? { ribPolicies: opts.ribPolicies } : {}),
    ...(opts.requestApproval ? { requestApproval: opts.requestApproval } : {}),
  });
}

// A budget env var enables its builtin only when set to a positive integer; a
// missing, blank, zero, negative, or non-numeric value leaves the builtin off
// (no surprise cap from a typo).
function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Workflow prompt-node handler. Env-gated:
//   KEELSON_WORKFLOW_PROVIDER         - provider id (default: first non-stub)
//   KEELSON_WORKFLOW_TOOL_DENYLIST    - comma-separated tool names. Unset →
//                                       DEFAULT_TOOL_DENYLIST (empty today).
//                                       Empty string ("") → allow all tools.
//   KEELSON_WORKFLOW_PROMPT_TIMEOUT_S - per-node timeout in seconds (default 600).
//
// Returns undefined when no providers are registered — keeps `workflowsRoutes`
// on its placeholder-fallback path so the catalog still serves bash-only
// workflows when prompt nodes can't run.
export function bootstrapPromptHandler(
  opts: {
    defaultOffTools?: readonly string[];
    projectTools?: PromptToolGate;
    evaluateToolCall?: PromptToolCallGate;
    evaluateToolResult?: PromptToolResultGate;
    evaluateResponse?: PromptResponseGate;
    requestGate?: PromptRequestGate;
  } = {},
): NodeHandler | undefined {
  const providers = getProviderInfoList();
  if (providers.length === 0) {
    console.warn(
      "[workflows] no providers registered; prompt nodes will fail with the placeholder handler",
    );
    return undefined;
  }
  // Pin precedence: KEELSON_WORKFLOW_PROVIDER → config.json defaultProvider (when
  // registered) → first non-stub. Keeps the workflow default aligned with the
  // chat default a config sets.
  const envProvider = process.env.KEELSON_WORKFLOW_PROVIDER?.trim();
  // Lowercase to match resolveDefaultProvider + the canonical lowercase ids, so
  // a config value like "Claude" resolves the same here as it does for chat.
  const configDefault = loadKeelsonConfig().defaultProvider?.trim().toLowerCase();
  const requestedId =
    envProvider && envProvider.length > 0
      ? envProvider
      : configDefault && isRegisteredProvider(configDefault)
        ? configDefault
        : undefined;
  let providerId: string;
  if (requestedId && requestedId.length > 0) {
    providerId = requestedId;
  } else {
    // Prefer the first non-stub provider; fall back to stub only if nothing
    // real is registered. Skip the synthetic 'workflow' provider — it's a
    // non-chat stamp for run-as-conversation rows and throws if sendQuery
    // is invoked.
    const real = providers.find((p) => p.id !== "stub" && p.id !== "workflow");
    if (real) {
      providerId = real.id;
    } else {
      const fallback = providers.find((p) => p.id !== "workflow");
      if (!fallback) {
        console.warn(
          "[workflows] no chat-capable provider registered; prompt nodes will fail. Set KEELSON_PROVIDERS to include stub, copilot, or claude.",
        );
        return undefined;
      }
      providerId = fallback.id;
      console.warn(
        `[workflows] no non-stub provider registered; prompt nodes will use '${providerId}' (echo-only). Set KEELSON_PROVIDERS to include copilot or claude, or pin KEELSON_WORKFLOW_PROVIDER explicitly.`,
      );
    }
  }
  const getProvider: (id?: string) => PromptHandlerProvider = (id) => {
    const target = id ?? providerId;
    if (!isRegisteredProvider(target)) {
      const available = getProviderInfoList()
        .map((p) => p.id)
        .join(", ");
      throw new Error(
        `Provider '${target}' is not registered. Available: ${available}. ` +
          `Set KEELSON_PROVIDERS to include it, or remove 'provider:' from the workflow.`,
      );
    }
    return getAgentProvider(target) as unknown as PromptHandlerProvider;
  };
  // Per-node tool rails / hooks enforcement varies by provider; signal at boot
  // so operators know what the default will be when a workflow doesn't pin
  // `provider:` itself. Per-workflow and per-node overrides surface their own
  // `node_warning` at run time.
  if (providerId === "copilot") {
    console.warn(
      `[workflows] default workflow provider is 'copilot'; per-node 'allowed_tools' / 'denied_tools' are enforced by capability and PreToolUse / PostToolUse hooks are honored — other hook events are claude-only.`,
    );
  } else if (providerId !== "claude") {
    console.warn(
      `[workflows] default workflow provider is '${providerId}'; per-node 'allowed_tools' / 'denied_tools' / 'hooks' are only honored by the claude provider.`,
    );
  }
  // When the policy engine is wired (projectTools present) it owns the operator
  // denylist via its `tool_denylist` builtin, so the handler's own floor stands
  // down to avoid double-filtering. Standalone callers keep the env floor.
  const denylist = opts.projectTools
    ? []
    : parseToolDenylist(process.env.KEELSON_WORKFLOW_TOOL_DENYLIST);
  const timeoutMs = parsePromptTimeoutMs(process.env.KEELSON_WORKFLOW_PROMPT_TIMEOUT_S);
  return makePromptHandler({
    getProvider,
    // Record the concrete provider id a node ran on: the hint (`node.provider ??
    // workflow.provider`) resolves to `providerId` (the boot default) when unset,
    // so a node that pins nothing still surfaces the real provider in the trace.
    resolveProviderId: (id) => id ?? providerId,
    getRegisteredTools: () => getRegisteredTools() as unknown as readonly { name: string }[],
    denylist,
    // Rib tools are off by default in workflow prompt nodes — a node must opt in
    // via `allowed_tools` — so a workflow inherits no rib tool it didn't ask for.
    ...(opts.defaultOffTools ? { defaultOffTools: opts.defaultOffTools } : {}),
    ...(opts.projectTools ? { projectTools: opts.projectTools } : {}),
    ...(opts.evaluateToolCall ? { evaluateToolCall: opts.evaluateToolCall } : {}),
    ...(opts.evaluateToolResult ? { evaluateToolResult: opts.evaluateToolResult } : {}),
    ...(opts.evaluateResponse ? { evaluateResponse: opts.evaluateResponse } : {}),
    ...(opts.requestGate ? { requestGate: opts.requestGate } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

// Exported for tests; not public.
export function parseToolDenylist(raw: string | undefined): readonly string[] {
  // Unset → default denylist (empty today).
  if (raw === undefined) return DEFAULT_TOOL_DENYLIST;
  // Explicit empty string is "allow everything" — same as the default today.
  if (raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Exported for tests; not public.
export function parsePromptTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[workflows] KEELSON_WORKFLOW_PROMPT_TIMEOUT_S='${raw}' is not a positive number; using default`,
    );
    return undefined;
  }
  return Math.round(n * 1000);
}

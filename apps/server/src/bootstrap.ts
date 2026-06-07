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
  registerCopilotProvider,
  registerStubProvider,
  registerWorkflowProvider,
} from "@keelson/providers";
import type {
  Rib,
  RibAction,
  RibActionResult,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAuthStatus,
  RibContext,
  SnapshotManager,
  ToolDefinition,
  WorkflowDiscoveryNotice,
} from "@keelson/shared";
import { runJSON, runText } from "@keelson/shared/exec";
import { getRegisteredTools, isRegisteredTool, registerTool } from "@keelson/skills";
import {
  DEFAULT_TOOL_DENYLIST,
  discoverWorkflows,
  makePromptHandler,
  type NodeHandler,
  type PromptHandlerProvider,
  validateWorkflowInvariants,
  type WorkflowDefinition,
  type WorkflowLoadWarning,
  workflowDefinitionSchema,
} from "@keelson/workflows";
import { makeRibAgentTurn } from "./rib-agent-turn.ts";
import { discoverRibs } from "./rib-discovery.ts";
import { applyRibs, parseRibList, type RibManifest, type RibWorkflowContribution } from "./ribs.ts";

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
}

const BUILT_IN_IDS = ["stub", "copilot", "claude"] as const;
type BuiltInId = (typeof BUILT_IN_IDS)[number];

export function bootstrapProviders(options: BootstrapProvidersOptions): BootstrapProvidersResult {
  const requested = parseProviderList(process.env.KEELSON_PROVIDERS);
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
        });
        result.claudeAuthProbe = reg.checkAuthStatus;
        break;
      }
    }
  }
  // Always-on, non-chat provider that backs workflow-linked conversations.
  // Registered AFTER the selectable providers so it sits at the end of
  // getProviderInfoList() and isn't picked as a chat default.
  registerWorkflowProvider();
  return result;
}

// Exported for tests; not public.
export function parseProviderList(raw: string | undefined): BuiltInId[] {
  // Unset / empty / whitespace-only → include all built-ins.
  if (!raw || raw.trim() === "") return [...BUILT_IN_IDS];

  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const out: BuiltInId[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (isBuiltIn(id)) {
      out.push(id);
    } else {
      console.warn(`[keelson] KEELSON_PROVIDERS contains unknown provider '${id}'; ignoring.`);
    }
  }
  return out;
}

function isBuiltIn(id: string): id is BuiltInId {
  return (BUILT_IN_IDS as readonly string[]).includes(id);
}

export interface BootstrapRibsOptions {
  // Omitted runs discovery; explicit (even `{}`) bypasses it.
  available?: Readonly<Record<string, Rib>>;
  // Shared SnapshotManager passed into RibContext and used to auto-register
  // each rib's `composeBundle`. Optional so unit tests for parseRibList /
  // applyRibs don't need to spin up a manager.
  snapshotManager?: SnapshotManager;
  // Builds a rib's namespaced read-only credential reader. Optional so unit
  // tests without a credential store stay deterministic.
  getRibCredential?: (ribId: string, serviceId: string) => Promise<string | undefined>;
  // Agent-turn factory (C1). Defaults to the CLI-backed makeRibAgentTurn;
  // injectable so tests pass a fake instead of shelling a provider CLI.
  runAgentTurn?: (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn;
}

export interface RibBootstrap {
  readonly manifests: RibManifest[];
  // Live auth-status probes keyed by rib id, resolved per-request by GET /api/ribs.
  readonly probes: Map<string, () => Promise<RibAuthStatus>>;
  // Inbound action handlers keyed by rib id, dispatched by POST /api/ribs/:id/action.
  readonly actionHandlers: Map<string, (action: RibAction) => Promise<RibActionResult>>;
  // Raw workflow contributions, narrowed + merged into the catalog separately.
  readonly workflowContributions: RibWorkflowContribution[];
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
  const available = options.available ?? (await discoverRibs());
  const active = requested.length > 0 ? requested : Object.keys(available);
  const snapshotManager = options.snapshotManager;
  // The template ctx carries only exec/sidecar; applyRibs layers a scoped
  // snapshot manager + namespaced credential reader on top, per rib.
  const ctx: RibContext = {
    getExec: () => ({ runJSON, runText }),
  };
  // The CLI-backed C1 seam (test override via options.runAgentTurn). Harmless
  // until a rib actually calls ctx.runAgentTurn — it only shells a CLI then.
  const runAgentTurn = options.runAgentTurn ?? makeRibAgentTurn();
  const { manifests, disposers, probes, actionHandlers, workflowContributions, tools } = applyRibs({
    active,
    available,
    ctx,
    runAgentTurn,
    ...(snapshotManager ? { snapshotManager } : {}),
    ...(options.getRibCredential ? { getRibCredential: options.getRibCredential } : {}),
  });
  return {
    manifests,
    probes,
    actionHandlers,
    workflowContributions,
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
export function prepareRibWorkflows(contributions: readonly RibWorkflowContribution[]): {
  definitions: WorkflowDefinition[];
  bindings: Map<WorkflowDefinition, RibWorkflowBinding>;
  // Workflow name → bound snapshot key, for boot-time surface-schedule
  // validation only. Name-keyed (not object-identity like `bindings`) because
  // its one consumer matches a region's declared `workflow` string.
  boundKeys: Map<string, string>;
} {
  const definitions: WorkflowDefinition[] = [];
  const bindings = new Map<WorkflowDefinition, RibWorkflowBinding>();
  const boundKeys = new Map<string, string>();
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
    if (contribution.publish) {
      bindings.set(definition, { publish: contribution.publish });
      if (contribution.bindSnapshotKey !== undefined) {
        boundKeys.set(definition.name, contribution.bindSnapshotKey);
      }
    }
  }
  return { definitions, bindings, boundKeys };
}

export interface BootstrapWorkflowsOptions {
  // Directory to scan for `*.yaml` workflow files. Production callers pass
  // `${REPO_ROOT}/.keelson/workflows`; tests pass a fixture dir.
  workflowDir: string;
  // Rib-contributed definitions merged into the catalog. A filesystem workflow
  // of the same name wins (so an operator can override a rib's), and the
  // collision surfaces as a discovery notice.
  extra?: readonly WorkflowDefinition[];
}

export interface WorkflowCatalog {
  list(): WorkflowDefinition[];
  get(name: string): WorkflowDefinition | undefined;
  // Load-errors (file dropped) + non-fatal warnings, normalized for the
  // wire schema. The SPA toasts these once on first Workflows-tab load.
  discoveryNotices(): WorkflowDiscoveryNotice[];
}

interface CatalogSnapshot {
  signature: string;
  byName: Map<string, WorkflowDefinition>;
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
  const extra = opts.extra ?? [];
  let cached: CatalogSnapshot | undefined;

  const scan = (): CatalogSnapshot => {
    const signature = catalogSignature(dir);
    if (cached && cached.signature === signature) return cached;
    const result = discoverWorkflows([{ dir, source: "project" }]);
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
    for (const entry of result.workflows) {
      byName.set(entry.workflow.name, entry.workflow);
    }
    // Rib-contributed workflows fill in around the filesystem set; a name
    // collision keeps the filesystem definition so an operator can override.
    for (const definition of extra) {
      if (byName.has(definition.name)) {
        console.warn(
          `[workflows] rib workflow '${definition.name}' shadowed by a project workflow of the same name`,
        );
        notices.push({
          level: "warning",
          filename: `<rib:${definition.name}>`,
          message: `rib workflow '${definition.name}' shadowed by a project workflow of the same name`,
        });
        continue;
      }
      byName.set(definition.name, definition);
    }
    console.log(`[workflows] discovered ${byName.size} workflows`);
    cached = { signature, byName, notices };
    return cached;
  };

  // Prime once so the discovery count logs at boot and a broken dir surfaces
  // immediately, matching the previous build-at-boot behavior.
  scan();

  return {
    list: () => Array.from(scan().byName.values()),
    get: (name) => scan().byName.get(name),
    discoveryNotices: () => scan().notices,
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
export function bootstrapPromptHandler(): NodeHandler | undefined {
  const providers = getProviderInfoList();
  if (providers.length === 0) {
    console.warn(
      "[workflows] no providers registered; prompt nodes will fail with the placeholder handler",
    );
    return undefined;
  }
  const requestedId = process.env.KEELSON_WORKFLOW_PROVIDER?.trim();
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
  const denylist = parseToolDenylist(process.env.KEELSON_WORKFLOW_TOOL_DENYLIST);
  const timeoutMs = parsePromptTimeoutMs(process.env.KEELSON_WORKFLOW_PROMPT_TIMEOUT_S);
  return makePromptHandler({
    getProvider,
    getRegisteredTools: () => getRegisteredTools() as unknown as readonly { name: string }[],
    denylist,
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

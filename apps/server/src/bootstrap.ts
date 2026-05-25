// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type ClaudeAuthProbe,
  type CopilotAuthProbe,
  getAgentProvider,
  getProviderInfoList,
  registerClaudeProvider,
  registerCopilotProvider,
  registerStubProvider,
  registerWorkflowProvider,
} from "@keelson/providers";
import type { Rib, RibContext, SnapshotManager, WorkflowDiscoveryNotice } from "@keelson/shared";
import { runJSON, runText } from "@keelson/shared/exec";
import { getRegisteredTools } from "@keelson/skills";
import {
  DEFAULT_TOOL_DENYLIST,
  discoverWorkflows,
  makePromptHandler,
  type NodeHandler,
  type PromptHandlerProvider,
  type WorkflowDefinition,
  type WorkflowLoadWarning,
} from "@keelson/workflows";
import { applyRibs, parseRibList, type RibManifest } from "./ribs.ts";

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
  // Operator-supplied manifest mapping rib id → Rib implementation. Typically
  // the embedder imports `@keelson/rib-<name>` packages here.
  available: Readonly<Record<string, Rib>>;
  // Shared SnapshotManager passed into RibContext and used to auto-register
  // each rib's `composeBundle`. Optional so unit tests for parseRibList /
  // applyRibs don't need to spin up a manager.
  snapshotManager?: SnapshotManager;
}

export interface RibBootstrap {
  readonly manifests: RibManifest[];
  // Invoke every activated rib's optional `dispose()` hook. Errors from one
  // disposer log a warning and never block the rest — shutdown must
  // make forward progress.
  disposeAll(): Promise<void>;
}

export function bootstrapRibs(options: BootstrapRibsOptions): RibBootstrap {
  const requested = parseRibList(process.env.KEELSON_RIBS);
  const available = options.available;
  const active = requested.length > 0 ? requested : Object.keys(available);
  const snapshotManager = options.snapshotManager;
  const ctx: RibContext = {
    getExec: () => ({ runJSON, runText }),
    ...(snapshotManager ? { getSnapshotManager: () => snapshotManager } : {}),
  };
  const { manifests, disposers } = applyRibs({
    active,
    available,
    ctx,
    ...(snapshotManager ? { snapshotManager } : {}),
  });
  return {
    manifests,
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

export interface BootstrapWorkflowsOptions {
  // Directory to scan for `*.yaml` workflow files. Production callers pass
  // `${REPO_ROOT}/.keelson/workflows`; tests pass a fixture dir.
  workflowDir: string;
}

export interface WorkflowCatalog {
  list(): WorkflowDefinition[];
  get(name: string): WorkflowDefinition | undefined;
  // Load-errors (file dropped) + non-fatal warnings, normalized for the
  // wire schema. The SPA toasts these once on first Workflows-tab load.
  discoveryNotices(): WorkflowDiscoveryNotice[];
}

// Scans `workflowDir`, parses each *.yaml via the workflows loader, and
// returns a name → definition lookup. Parse errors log a warning and skip
// the file so a single broken workflow doesn't take the catalog down.
export function bootstrapWorkflows(opts: BootstrapWorkflowsOptions): WorkflowCatalog {
  const result = discoverWorkflows([{ dir: opts.workflowDir, source: "project" }]);
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
  console.log(`[workflows] discovered ${byName.size} workflows`);
  return {
    list: () => Array.from(byName.values()),
    get: (name) => byName.get(name),
    discoveryNotices: () => notices,
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
  const getProvider: () => PromptHandlerProvider = () => {
    const p = getAgentProvider(providerId);
    return p as unknown as PromptHandlerProvider;
  };
  // Per-node `allowed_tools` / `denied_tools` / `hooks` are honored only by
  // the claude provider; signal at boot so operators know.
  if (providerId !== "claude") {
    console.warn(
      `[workflows] workflow provider is '${providerId}'; per-node 'allowed_tools' / 'denied_tools' / 'hooks' are only honored by the claude provider.`,
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

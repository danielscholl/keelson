// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  disposeAllProviders,
  getAgentProvider,
  getProviderInfoList,
  isRegisteredProvider,
  registerStubProvider,
} from "@keelson/providers";
import { loadKeelsonConfig } from "@keelson/shared/config";
import { getRegisteredTools } from "@keelson/skills";
import {
  bashHandler,
  createWorktree,
  type DiscoveryRoot,
  defaultRunUntilBashProbe,
  discoverWorkflows,
  ensureWorktreeDeps,
  gitToplevel,
  headDivergesFrom,
  isGitRepo,
  makeApprovalHandler,
  makeCancelHandler,
  makeCommandHandler,
  makeLoopHandler,
  makePromptHandler,
  makeScriptHandler,
  type NodeHandler,
  type PromptHandlerProvider,
  parseWorkflow,
  type RunStreamEvent,
  type RunSummary,
  removeWorktree,
  resolveBranchTemplate,
  resolveDefaultBranch,
  runWorkflow,
  type WorkflowDefinition,
  worktreePathForRepoLocal,
} from "@keelson/workflows";

import { workflowDiscoveryRoots } from "../paths.ts";
import { bootstrapCliProviders } from "./providers.ts";

export interface RunHeadlessOptions {
  name: string;
  inputs: Record<string, string>;
  cwd: string;
  provider?: string;
  workflowsDir?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: RunStreamEvent) => void;
  // Per-run isolation override; mirrors the wire schema. `"auto"` defers to
  // the workflow's YAML `worktree.enabled`. Without this, `--worktree`
  // requests sent through the server-down fallback would silently downgrade
  // to in-place runs.
  isolation?: "worktree" | "none" | "auto";
}

export interface RunHeadlessResult {
  summary: RunSummary;
  runId: string;
}

export class WorkflowNotFoundError extends Error {
  constructor(
    public readonly name: string,
    public readonly searched: string,
  ) {
    super(
      `no workflow named '${name}' under ${searched} (project-scoped workflows need the server — run \`keelson start\`)`,
    );
    this.name = "WorkflowNotFoundError";
  }
}

/**
 * Thrown by `runHeadless` when the loaded workflow declares one or more
 * `memory:` blocks. The headless path has no MemoryStore wired (single-DB
 * invariant; the server owns the connection), so memory-bearing workflows
 * route through `keelson start`. The CLI command translates this to exit
 * code 3 (server required).
 */
export class MemoryRequiresServerError extends Error {
  constructor(
    public readonly workflowName: string,
    public readonly memoryNodeIds: readonly string[],
  ) {
    super(
      `workflow '${workflowName}' declares 'memory:' on ${memoryNodeIds.length} node(s) (${memoryNodeIds.join(", ")}). Memory requires the server. Run \`keelson start\` first.`,
    );
    this.name = "MemoryRequiresServerError";
  }
}

// Default-provider pin for headless prompt nodes, mirroring the server's
// bootstrapPromptHandler precedence so the same invocation resolves to the
// same provider whether or not the run routes through `keelson start`:
// --provider → KEELSON_WORKFLOW_PROVIDER → config defaultProvider (when
// registered) → first non-stub → stub.
// Exported for tests; not public.
export function resolveHeadlessProviderId(explicit?: string): string {
  const flag = explicit?.trim();
  if (flag) return flag;
  const envPin = process.env.KEELSON_WORKFLOW_PROVIDER?.trim();
  if (envPin) return envPin;
  const registered = getProviderInfoList().map((p) => p.id);
  const configDefault = loadKeelsonConfig().defaultProvider?.trim().toLowerCase();
  if (configDefault && configDefault !== "workflow" && registered.includes(configDefault)) {
    return configDefault;
  }
  return registered.find((id) => id !== "stub" && id !== "workflow") ?? "stub";
}

// Find a workflow definition by name across the CLI's discovery roots —
// bundled code artifacts, the user-global home, and the project-local home
// (later overrides earlier; discoverWorkflows dedupes by name). Registered-
// project overlays still live behind the server, so the in-process fallback
// cannot see those.
function loadWorkflowByName(roots: DiscoveryRoot[], name: string): WorkflowDefinition | null {
  const result = discoverWorkflows(roots);
  for (const wf of result.workflows) {
    if (wf.workflow.name === name) return wf.workflow;
  }
  return null;
}

// Headless run: no SQLite, no server, no conversation row. The caller owns
// event streaming via opts.onEvent — same shape the server's executor
// emits, so a CLI consumer doesn't branch on transport.
export async function runHeadless(opts: RunHeadlessOptions): Promise<RunHeadlessResult> {
  const roots: DiscoveryRoot[] = opts.workflowsDir
    ? [{ dir: opts.workflowsDir, source: "global" }]
    : workflowDiscoveryRoots();
  const workflow = loadWorkflowByName(roots, opts.name);
  if (!workflow) {
    throw new WorkflowNotFoundError(opts.name, roots.map((r) => r.dir).join(", "));
  }

  // Reject memory-bearing workflows up front — the headless path has no MemoryStore,
  // so let the operator see one clear error rather than per-node "missing adapter" warnings.
  const memoryNodes = workflow.nodes
    .filter((n) => (n as { memory?: unknown }).memory !== undefined)
    .map((n) => n.id);
  if (memoryNodes.length > 0) {
    throw new MemoryRequiresServerError(opts.name, memoryNodes);
  }

  // Register the same provider set the in-process chat path uses
  // (KEELSON_PROVIDERS / config.json), so headless runs drive real providers
  // with no server. Stub stays registered unconditionally — the documented
  // offline escape hatch (--provider stub) and the fallback when nothing real
  // is enabled.
  bootstrapCliProviders();
  registerStubProvider();
  const providerId = resolveHeadlessProviderId(opts.provider);
  // Fail fast only on an explicit --provider; an unregistered default pin
  // (env/config) surfaces lazily when a prompt node first needs it, so
  // bash-only workflows still run.
  if (opts.provider !== undefined && !isRegisteredProvider(providerId)) {
    const available = getProviderInfoList()
      .map((p) => p.id)
      .join(", ");
    throw new Error(
      `provider '${providerId}' is not registered. Available: ${available}. ` +
        `Set KEELSON_PROVIDERS (or config.json providers) to include it.`,
    );
  }

  const abort = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abort.abort();
    else opts.abortSignal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  // Approval / cancel handlers in headless mode: there's no UI to receive
  // a pause callout and no second client to resume the run, so an approval
  // node fails immediately with a clear message. Operators who need
  // approval should route through `keelson start` + the SPA.
  const promptHandler = makePromptHandler({
    getProvider: (id) => {
      const target = id ?? providerId;
      if (!isRegisteredProvider(target)) {
        const available = getProviderInfoList()
          .map((p) => p.id)
          .join(", ");
        throw new Error(
          `provider '${target}' is not registered. Available: ${available}. ` +
            `Set KEELSON_PROVIDERS to include it, or remove 'provider:' from the workflow.`,
        );
      }
      // @keelson/workflows declares `PromptHandlerProvider` structurally to
      // keep its dep graph free of @keelson/providers + @keelson/shared. Cast
      // at the boundary — the same cast happens server-side. Resolving here
      // (not eagerly) keeps bash-only workflows from instantiating an SDK.
      return getAgentProvider(target) as unknown as PromptHandlerProvider;
    },
    // Record the concrete provider id a node ran on, even when the workflow
    // pins nothing — the headless default resolves the same way getProvider does.
    resolveProviderId: (id) => id ?? providerId,
    // Tools from `@keelson/skills` are `ToolDefinition` (typed name + schema);
    // `PromptHandlerProvider` accepts the structural `{ name; [k]: unknown }`
    // shape. Same boundary cast as the provider above.
    getRegisteredTools: () =>
      getRegisteredTools() as unknown as readonly { name: string; [k: string]: unknown }[],
  });
  const approvalHandler = makeApprovalHandler({
    awaitApproval: async (_runId, nodeId, message) => {
      throw new Error(
        `approval node '${nodeId}' cannot resolve in headless mode (message: "${message}"). Run via \`keelson start\` for interactive approval.`,
      );
    },
  });
  const cancelHandler = makeCancelHandler({
    requestCancel: async () => {
      abort.abort();
    },
  });

  const handlers = new Map<string, NodeHandler>([
    ["bash", bashHandler],
    ["prompt", promptHandler],
    ["approval", approvalHandler],
    ["cancel", cancelHandler],
    ["command", makeCommandHandler({ promptHandler })],
    // Headless fallback has no UI to pause on, so `loop.interactive: true`
    // fails fast (no awaitInteraction wired). `loop.until_bash` is supported
    // because it's an autonomous completion probe, not human-in-the-loop.
    ["loop", makeLoopHandler({ promptHandler, runUntilBashProbe: defaultRunUntilBashProbe })],
    ["script", makeScriptHandler()],
  ]);

  const runId = crypto.randomUUID();

  let capturedSummary: RunSummary | null = null;
  // Mirrored boolean so the worktree-cleanup finally can read terminal-status
  // intent without tripping TS's closure-narrowing on `capturedSummary` (it
  // can't trace the onEvent assignment, so the property read narrows to
  // `never` at the finally site).
  let runSucceeded = false;
  const onEvent = (event: RunStreamEvent): void => {
    if (event.type === "run_done") {
      capturedSummary = event.summary;
      runSucceeded = event.status === "succeeded";
    }
    opts.onEvent?.(event);
  };

  // Per-run scratch dir. The server's executor wires this up via
  // RunArtifactsDir; in headless mode we own lifecycle ourselves so
  // bash/script/command/prompt nodes see $ARTIFACTS_DIR identically to
  // the server-routed path. Cleanup is best-effort: even if a node
  // crashed the executor, leaving a stray /tmp dir is preferable to
  // throwing from the finally and masking the original error.
  const artifactsDir = mkdtempSync(join(tmpdir(), "keelson-cli-run-"));

  // Worktree isolation mirrors the server's lifecycle: opt in via override
  // OR YAML `worktree.enabled`; create before the first node; prune on
  // success, keep on failure for inspection. The headless path skips memory
  // already (see MemoryRequiresServerError above), but worktree-bearing
  // workflows are the common headless ask (run `architect` against any local
  // checkout from the shell), so honoring this here is what closes the
  // server-down isolation gap.
  const isolationMode = opts.isolation ?? "auto";
  const isolationOn =
    isolationMode === "worktree" ||
    (isolationMode === "auto" && workflow.worktree?.enabled === true);
  // `worktree` is the operator's explicit flag — fail closed so a typo / non-git
  // dir doesn't silently mutate the live checkout. `auto` means "honor the YAML
  // default" — best-effort, fall back to in-place with a warning if the target
  // isn't a git repo.
  const isolationRequired = isolationMode === "worktree";
  let effectiveCwd = opts.cwd;
  let cleanupWorktree: { repoPath: string; dest: string } | null = null;
  if (isolationOn) {
    if (!(await isGitRepo(opts.cwd))) {
      const msg = `worktree isolation requested but ${opts.cwd} is not a git repo`;
      if (isolationRequired) {
        throw new Error(`${msg}. Initialize the directory with \`git init\` or drop --worktree.`);
      }
      console.warn(`[keelson] ${msg}; running in place`);
    } else {
      const branch = resolveBranchTemplate(workflow.worktree?.branch, {
        workflow: workflow.name,
        runId,
      });
      // Anchor at the repo top-level, not opts.cwd: a run started from a
      // subdirectory must still place its worktree at `<repo>/.worktrees/` so a
      // kept-on-failure worktree lands where it's discoverable, not orphaned
      // under the subdir.
      const repoRoot = (await gitToplevel(opts.cwd)) ?? opts.cwd;
      const dest = worktreePathForRepoLocal({
        projectRootPath: repoRoot,
        branch,
      });
      const base = workflow.worktree?.base ?? (await resolveDefaultBranch(repoRoot));
      if (base !== null && (await headDivergesFrom(repoRoot, base))) {
        console.warn(
          `[keelson] current HEAD is not contained in ${base}; creating isolated worktree branch from ${base}`,
        );
      }
      try {
        const created = await createWorktree({
          repoPath: repoRoot,
          branch,
          dest,
          base: base ?? undefined,
        });
        effectiveCwd = created.worktreePath;
        cleanupWorktree = { repoPath: repoRoot, dest: created.worktreePath };
        const deps = await ensureWorktreeDeps({
          worktreePath: created.worktreePath,
          abortSignal: abort.signal,
        });
        if (deps.error !== null) {
          console.warn(`[keelson] worktree dependency install failed; continuing: ${deps.error}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isolationRequired) {
          throw new Error(`worktree creation failed: ${message}`);
        }
        console.warn(`[keelson] worktree creation failed; running in place: ${message}`);
      }
    }
  }

  try {
    await runWorkflow({
      workflow,
      runId,
      inputs: opts.inputs,
      handlers,
      cwd: effectiveCwd,
      abortSignal: abort.signal,
      artifactsDir,
      onEvent,
    });
  } finally {
    // A Copilot `prompt` node leaves the language-server warm; with no server
    // outliving this run, reap it here before the CLI exits rather than
    // orphaning the subprocess.
    await disposeAllProviders();
    if (cleanupWorktree !== null && runSucceeded) {
      // Force-remove on success: same semantics as the server path — the
      // worktree is ephemeral, and any intentional artifacts should have
      // been committed elsewhere.
      try {
        await removeWorktree({
          repoPath: cleanupWorktree.repoPath,
          dest: cleanupWorktree.dest,
          force: true,
        });
      } catch (err) {
        console.warn(
          `[keelson] worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      rmSync(artifactsDir, { recursive: true, force: true });
    } catch {
      // ignore — see note above
    }
  }

  if (!capturedSummary) {
    // The executor always emits run_done on its happy and unhappy paths
    // (succeeded / failed / cancelled). If we got here without a summary
    // something invariant-breaking happened upstream.
    throw new Error("workflow executor returned without emitting run_done");
  }

  return { summary: capturedSummary, runId };
}

// One-shot validation entry used by run-command before dispatching: parse
// the YAML and surface the error/warnings to the caller without touching
// the executor. Returns the definition on success.
export function loadWorkflowFromFile(filename: string): {
  workflow: WorkflowDefinition;
  warnings: { kind: string; message: string }[];
} {
  const content = readFileSync(filename, "utf-8");
  const result = parseWorkflow(content, filename);
  if (result.error) {
    throw new Error(`failed to parse ${filename}: ${result.error.error}`);
  }
  return {
    workflow: result.workflow,
    warnings: result.warnings.map((w) => ({ kind: w.kind, message: w.message })),
  };
}

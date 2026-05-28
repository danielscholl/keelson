// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { getAgentProvider, isRegisteredProvider, registerStubProvider } from "@keelson/providers";
import { getRegisteredTools } from "@keelson/skills";
import {
  bashHandler,
  createWorktree,
  defaultRunUntilBashProbe,
  defaultWorktreeRoot,
  discoverWorkflows,
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
  runWorkflow,
  type WorkflowDefinition,
  worktreePathFor,
} from "@keelson/workflows";

import { defaultWorkflowsDir } from "../paths.ts";

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
    super(`no workflow named '${name}' under ${searched}`);
    this.name = "WorkflowNotFoundError";
  }
}

/**
 * Thrown by `runHeadless` when the loaded workflow declares one or more
 * `memory:` blocks. The headless path has no MemoryStore wired (single-DB
 * invariant; the server owns the connection), so memory-bearing workflows
 * route through `keelson serve`. The CLI command translates this to exit
 * code 3 (server required).
 */
export class MemoryRequiresServerError extends Error {
  constructor(
    public readonly workflowName: string,
    public readonly memoryNodeIds: readonly string[],
  ) {
    super(
      `workflow '${workflowName}' declares 'memory:' on ${memoryNodeIds.length} node(s) (${memoryNodeIds.join(", ")}). Memory requires the server. Run \`keelson serve\` first.`,
    );
    this.name = "MemoryRequiresServerError";
  }
}

// Mirrors the slugify helper the server uses to pick the
// `~/.keelson/worktrees/<slug>/` bucket when there's no named project. Kept
// identical so the same headless run reuses the same worktree home across
// invocations (otherwise prune would see two near-identical orphans).
function slugifyForPath(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "workspace"
  );
}

// Find a workflow definition by name. Discovery walks the project's
// workflow directory only — global / home-scoped roots are out of scope
// for the CLI's in-process path (mirrors the server's discovery surface).
function loadWorkflowByName(dir: string, name: string): WorkflowDefinition | null {
  const result = discoverWorkflows([{ dir, source: "project" }]);
  for (const wf of result.workflows) {
    if (wf.workflow.name === name) return wf.workflow;
  }
  return null;
}

// Headless run: no SQLite, no server, no conversation row. The caller owns
// event streaming via opts.onEvent — same shape the server's executor
// emits, so a CLI consumer doesn't branch on transport.
export async function runHeadless(opts: RunHeadlessOptions): Promise<RunHeadlessResult> {
  const workflowsDir = opts.workflowsDir ?? defaultWorkflowsDir();
  const workflow = loadWorkflowByName(workflowsDir, opts.name);
  if (!workflow) throw new WorkflowNotFoundError(opts.name, workflowsDir);

  // Reject memory-bearing workflows up front — the headless path has no MemoryStore,
  // so let the operator see one clear error rather than per-node "missing adapter" warnings.
  const memoryNodes = workflow.nodes
    .filter((n) => (n as { memory?: unknown }).memory !== undefined)
    .map((n) => n.id);
  if (memoryNodes.length > 0) {
    throw new MemoryRequiresServerError(opts.name, memoryNodes);
  }

  // Stub provider is the deterministic fallback when nothing else is
  // registered. Real providers (claude / copilot) would need keytar
  // bootstrap and are out of scope for C3's headless path — operators who
  // want them up should `keelson serve` first so the run routes via HTTP.
  registerStubProvider();
  const providerId = opts.provider ?? "stub";
  if (!isRegisteredProvider(providerId)) {
    throw new Error(
      `provider '${providerId}' is not registered. Use --provider stub for headless runs, or ` +
        `start the server with credentials configured (\`keelson serve\`) and route this run through it.`,
    );
  }
  // @keelson/workflows declares `PromptHandlerProvider` structurally to keep
  // its dep graph free of @keelson/providers + @keelson/shared (see the
  // comment block above PromptHandlerProvider). Cast at the boundary — the
  // structural shape matches; the same cast happens server-side.
  const provider = getAgentProvider(providerId) as unknown as PromptHandlerProvider;

  const abort = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abort.abort();
    else opts.abortSignal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  // Approval / cancel handlers in headless mode: there's no UI to receive
  // a pause callout and no second client to resume the run, so an approval
  // node fails immediately with a clear message. Operators who need
  // approval should route through `keelson serve` + the SPA.
  const promptHandler = makePromptHandler({
    getProvider: (id) => {
      // Headless runs register exactly one provider (stub by default; the
      // claude/copilot bootstrap path requires keytar + credentials and only
      // wires under `keelson serve`). If the workflow's `provider:` (or a
      // node's override) names a different id, fail loudly rather than
      // silently substituting — `keelson serve` is the only path that can
      // dispatch to the full provider set.
      if (id !== undefined && id !== providerId) {
        throw new Error(
          `workflow declares 'provider: ${id}' but headless mode only has '${providerId}'. ` +
            `Run \`keelson serve\` and route this workflow through the server to use ${id}.`,
        );
      }
      return provider;
    },
    // Tools from `@keelson/skills` are `ToolDefinition` (typed name + schema);
    // `PromptHandlerProvider` accepts the structural `{ name; [k]: unknown }`
    // shape. Same boundary cast as the provider above.
    getRegisteredTools: () =>
      getRegisteredTools() as unknown as readonly { name: string; [k: string]: unknown }[],
  });
  const approvalHandler = makeApprovalHandler({
    awaitApproval: async (_runId, nodeId, message) => {
      throw new Error(
        `approval node '${nodeId}' cannot resolve in headless mode (message: "${message}"). Run via \`keelson serve\` for interactive approval.`,
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
      const projectName = slugifyForPath(basename(opts.cwd));
      const dest = worktreePathFor({
        root: defaultWorktreeRoot(),
        projectName,
        branch,
      });
      try {
        const created = await createWorktree({ repoPath: opts.cwd, branch, dest });
        effectiveCwd = created.worktreePath;
        cleanupWorktree = { repoPath: opts.cwd, dest: created.worktreePath };
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

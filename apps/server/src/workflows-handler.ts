// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  bulkDeleteRunsBodySchema,
  bulkDeleteRunsResponseSchema,
  type ContentBlock,
  coerceTokenUsage,
  getRunArtifactResponseSchema,
  type IsolationOverride,
  listWorkflowsResponseSchema,
  type MessageChunk,
  type NodeOutputRow,
  type Project,
  type RibWorkflowRunResult,
  recallRequestSchema,
  refreshWorkflowBodySchema,
  resumeWorkflowRunBodySchema,
  type SnapshotManager,
  startWorkflowRunBodySchema,
  TERMINAL_RUN_STATUSES,
  type WorkflowFrame,
  type WorkflowNodeStatus,
  type WorkflowRunDetail,
  type WorkflowRunOrigin,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowSummary,
  workflowDetailSchema,
  workflowRunDetailSchema,
  workflowRunOriginSchema,
  workflowRunStatusSchema,
  workflowRunSummarySchema,
  writebackRequestSchema,
} from "@keelson/shared";
import {
  type AwaitApproval,
  type AwaitInteraction,
  bashHandler,
  createWorktree,
  type DagNode,
  defaultRunUntilBashProbe,
  ensureWorktreeDeps,
  headDivergesFrom,
  isGitRepo,
  type MemoryTools,
  makeApprovalHandler,
  makeCancelHandler,
  makeCommandHandler,
  makeLoopHandler,
  makeScriptHandler,
  type NodeHandler,
  type NodeOutput,
  type NodeResult,
  type NotebookAdapter,
  type RequestCancel,
  type RunStreamEvent,
  type RunSummary,
  removeWorktree,
  resolveBranchTemplate,
  resolveDefaultBranch,
  runWorkflow,
  validateWorkflowInvariants,
  type WorkflowDefinition,
  workflowDefinitionSchema,
  worktreePathForRepoLocal,
} from "@keelson/workflows";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { z } from "zod";

import type { RibWorkflowBinding, WorkflowCatalog, WorkflowScopeContext } from "./bootstrap.ts";
import { createContentPartsAccumulator } from "./content-parts.ts";
import { createRunSlots, type RunSlots, resolveMaxConcurrentRuns } from "./run-concurrency.ts";
import { isAllowedOrigin, type WsData } from "./server-context.ts";
import { resolveWorkflowName } from "./workflow-resolve.ts";

// CSRF defense for state-changing routes — reject cross-origin POSTs that
// the browser would otherwise send with the user's cookies.
function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

import type { ConversationStore } from "./conversation-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import {
  MutationLockConflictError,
  type MutationLockHandle,
  type MutationLockManager,
} from "./mutation-lock-manager.ts";
import { formatNotebookSection, type ProjectNotebookStore } from "./project-notebook-store.ts";
import { canonicalPath, isPathInside, type ProjectsStore } from "./projects-store.ts";
import type { UsageStore } from "./usage-store.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

export interface WorkflowsHandlerOptions {
  catalog: WorkflowCatalog;
  store: WorkflowStore;
  // Every run is paired with a synthetic chat conversation created in the
  // start-run route so the run can be opened from the Chat sidebar. Required,
  // not optional — without it the run row's NOT NULL conversation_id FK has
  // nowhere to point.
  conversationStore: ConversationStore;
  // Resolves projectId → root_path at run start; also lets the route surface
  // a friendly 400 when the caller references an unknown project. Optional
  // so tests can spin up the routes without a project catalog — production
  // wiring (apps/server/src/index.ts) always passes one.
  projectsStore?: ProjectsStore;
  // Fallback cwd used when neither `projectId` nor `workingDir` is set on
  // the run body. Test-only seam: the production composition root leaves
  // it undefined so a UI start without a project picker rejects 400 rather
  // than silently targeting the server's install dir.
  defaultCwd?: string;
  // Working dir for `POST /:name/refresh` — re-running a rib producer needs a
  // cwd, but its node uses absolute paths so the value is nominal. Kept separate
  // from `defaultCwd` so wiring it in production can't widen the `/runs` target
  // resolution (a blank `workingDir` there must still 400, not fall through).
  refreshCwd?: string;
  // Real prompt handler injected from the composition root. When omitted
  // (tests, env where no provider is registered), the placeholder fires and
  // prompt nodes fail with a "not registered" sentinel. Keeps the route
  // construction testable without standing up a provider rig.
  promptHandler?: NodeHandler;
  // Optional MemoryStore. Undefined → executor memory hooks no-op.
  memoryStore?: MemoryStore;
  // Optional project notebook store. When set with a resolved project, prompt
  // nodes inherit the notebook and `notebook:` blocks append to it; undefined →
  // both are no-ops.
  projectNotebookStore?: ProjectNotebookStore;
  // Optional snapshot manager. When set, a run republishes its latest
  // structured node output under a run-scoped key;
  // undefined → runs never publish a snapshot.
  snapshotManager?: SnapshotManager;
  // Rib-contributed workflows bound to a rib-namespaced snapshot key, by
  // workflow name. A bound run fans its structured output to the rib's key in
  // addition to the run-scoped one.
  ribWorkflowBindings?: Map<WorkflowDefinition, RibWorkflowBinding>;
  // Optional usage ledger. When set, each node_done carrying real usage records
  // a `workflow`-sourced event; undefined → capture is skipped.
  usageStore?: UsageStore;
  // Shared workspace lifecycle service. Production wires this so workflow
  // worktrees use the same prepare/remove primitives as workspace leases.
  workspaceManager?: WorkspaceManager;
  mutationLockManager?: MutationLockManager;
  // Whether an active rib surface region (static or runtime-added) declares this
  // workflow as its refresh producer. Widens the `/refresh` gate beyond bound
  // producers: a region may name an UNBOUND workflow (one that republishes
  // through the rib's own tools rather than a bound key), and the SPA's panel
  // refresh must be able to run it. Region-declared only — an arbitrary catalog
  // workflow still goes through /runs with an explicit target.
  isRegionWorkflow?: (workflowName: string) => boolean;
}

// Renders the user-facing dispatch bubble that anchors the workflow run inside
// its conversation. The user types/clicks-to-start a workflow and that intent
// becomes the first (and only persisted) message in the conversation. The chat
// view renders this plus virtual system messages synthesized from useWorkflowRun.
function formatDispatchMessage(workflowName: string, inputs: Record<string, string>): string {
  const args = inputs.ARGUMENTS?.trim();
  return args && args.length > 0 ? `${workflowName}: ${args}` : workflowName;
}

const NODE_TYPE_FIELDS = [
  "prompt",
  "bash",
  "command",
  "loop",
  "approval",
  "cancel",
  "script",
] as const;

function nodeTypeOf(node: DagNode): string {
  for (const t of NODE_TYPE_FIELDS) {
    if (t in node) return t;
  }
  // Loader rejects unrecognized shapes; unreachable in practice.
  return "unknown";
}

// Node types whose own `model` this layer can resolve: prompt and command (a
// command node synthesizes a prompt from the node, carrying its model). Loop is
// intentionally excluded — the schema transform drops a loop node's `model`
// (dag-node.ts builds loop nodes without the AI fields), so its effective model
// isn't derivable here. bash / script / approval / cancel never call a model.
const MODEL_NODE_TYPES: ReadonlySet<string> = new Set(["prompt", "command"]);

function workflowToSummary(
  workflow: WorkflowDefinition,
  catalog: WorkflowCatalog,
  scope?: WorkflowScopeContext,
): WorkflowSummary {
  const prov = catalog.provenance(workflow.name, scope);
  return {
    name: workflow.name,
    description: workflow.description,
    nodeCount: workflow.nodes.length,
    source: prov.source,
    background: prov.background,
  };
}

// The owning rib id for a catalog entry, or null for a local workflow. Stamped
// onto each run so the feed can badge/filter/bulk-delete by rib. Scope matters:
// a project workflow shadowing a rib's name must not stamp the rib's id.
function ribIdFor(
  catalog: WorkflowCatalog,
  name: string,
  scope?: WorkflowScopeContext,
): string | null {
  const source = catalog.provenance(name, scope).source;
  return source.kind === "rib" ? (source.ribId ?? null) : null;
}

// Producer runs are refresh machinery, not history: keep only the newest few
// terminal `scheduled` runs per workflow (the snapshot is the durable output),
// cascading their linked conversations. Best-effort — a prune failure must never
// break the run that triggered it. Recent runs are protected outright: many
// per-item refreshes can share one workflow name, and a just-finished run must
// outlive its panel's poll loop (useWorkflowTrigger polls up to ~6 minutes).
const SCHEDULED_RUN_RETENTION = 5;
const SCHEDULED_RUN_PRUNE_MIN_AGE_MS = 10 * 60_000;
function pruneScheduledRuns(
  store: WorkflowStore,
  conversationStore: ConversationStore,
  workflowName: string,
): void {
  for (const { runId, conversationId } of store.scheduledRunsToPrune(
    workflowName,
    SCHEDULED_RUN_RETENTION,
    new Date(Date.now() - SCHEDULED_RUN_PRUNE_MIN_AGE_MS).toISOString(),
  )) {
    // Conversation first (FK SET NULLs the run pointer), then the run row — so a
    // conversation-delete failure leaves both intact (no orphan) and the next
    // prune retries. Per-run swallow keeps retention best-effort.
    try {
      if (conversationId !== null) conversationStore.delete(conversationId);
      store.deleteRun(runId);
    } catch (err) {
      console.warn(
        `[workflows] failed to prune scheduled run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function workflowToDetail(workflow: WorkflowDefinition) {
  return {
    name: workflow.name,
    description: workflow.description,
    nodes: workflow.nodes.map((n) => {
      const type = nodeTypeOf(n);
      // Resolve the node's own `model` over the workflow default, treating an
      // empty string as unset so it still falls back. The provider default
      // isn't known at this layer, so omit rather than guess.
      const ownModel = n.model && n.model.length > 0 ? n.model : undefined;
      const defaultModel = workflow.model && workflow.model.length > 0 ? workflow.model : undefined;
      const model = MODEL_NODE_TYPES.has(type) ? (ownModel ?? defaultModel) : undefined;
      return {
        id: n.id,
        type,
        ...(n.depends_on ? { dependsOn: n.depends_on } : {}),
        ...(n.when ? { when: n.when } : {}),
        ...(n.trigger_rule ? { triggerRule: n.trigger_rule } : {}),
        ...(model ? { model } : {}),
      };
    }),
    ...(workflow.worktree
      ? {
          worktree: {
            ...(workflow.worktree.enabled !== undefined
              ? { enabled: workflow.worktree.enabled }
              : {}),
            ...(workflow.worktree.branch !== undefined ? { branch: workflow.worktree.branch } : {}),
          },
        }
      : {}),
    ...(workflow.requiresProject ? { requiresProject: true } : {}),
  };
}

// Placeholder fires only when the composition root didn't inject a real prompt
// handler (tests, or a deployment with no provider registered). Kept as a
// safety net so the failure mode is structured rather than a crash.
const placeholderPromptHandler: NodeHandler = {
  type: "prompt",
  async handle(): Promise<NodeResult> {
    return {
      status: "failed",
      output: { kind: "text", text: "" },
      error: "prompt handler not registered (W3 pending)",
    };
  },
};

// Tracks in-flight runs so:
//   1. DELETE /api/workflows/runs/:runId can call .abort() on a specific runId.
//   2. The composition root can drain them on SIGINT — otherwise an
//      active bash subtree outlives the server and the persisted row
//      stays `running` indefinitely.
//   3. Pending approval resolvers piggyback so POST /resume can find the
//      right pending entry and POST resolve(text) into the executor's
//      awaited Promise.
//
// `done` is the executeRunInBackground promise; abortAll awaits each so the
// onEvent → store.updateRunStatus("cancelled") write lands before db.close().
export interface PendingApproval {
  nodeId: string;
  // Per-pause token the client must echo back on POST /resume. Defends
  // against stale POSTs (e.g. CLI retry, racy double-click) resolving a
  // LATER pause for an interactive-loop node that reuses the same nodeId
  // across iterations. Generated fresh every time a pause opens, so the
  // pre-resume client never knows the next iteration's pauseId.
  pauseId: string;
  // Gate message stored at pause time so the WS open handler can replay
  // `approval_awaiting` to a reconnecting client without re-reading the
  // store (and so the replay carries the right pauseId; SQLite never sees
  // the token).
  message: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export interface ActiveRunEntry {
  abort: AbortController;
  done: Promise<void>;
  // Keyed by nodeId so two parallel approval nodes in one layer can pause
  // and resume independently.
  pendingApprovals: Map<string, PendingApproval>;
  // Per-run artifacts tmpdir, set once created. Lets the read-only artifact
  // route resolve files while the run is live/paused; gone when the entry is
  // deleted on terminal status (the dir is cleaned at the same moment).
  artifactsDir?: string;
  // Identity for the run-start de-dup lookup: a concurrent start with the same
  // (workflow, workingDir, inputs) collapses onto this run. The heartbeat and a
  // bound producer's client refresh both target (collector, REPO_ROOT, {});
  // args-bearing region refreshes collapse per input set. See runDedupeKey.
  dedupeKey: string;
  // The resolved definition this run executes. The de-dup key is name-based,
  // but one name can resolve differently per scope/origin (a project shadow vs
  // the global copy), so a collapse must also match the definition itself.
  definition?: WorkflowDefinition;
  conversationId: string;
}

export interface ActiveRuns {
  register(runId: string, entry: ActiveRunEntry): void;
  get(runId: string): ActiveRunEntry | undefined;
  // The live run matching `dedupeKey`, or undefined. Backs the run-start de-dup
  // so an identical (workflow, workingDir, inputs) can't run twice concurrently.
  findActive(
    dedupeKey: string,
  ): { runId: string; conversationId: string; definition?: WorkflowDefinition } | undefined;
  delete(runId: string): void;
  size(): number;
  abortAll(): Promise<void>;
}

// Canonical de-dup identity for a run start. Two starts collapse only when
// workflow, workingDir, AND inputs all match; inputs are key-sorted so order
// can't make identical inputs look distinct.
export function runDedupeKey(
  name: string,
  workingDir: string,
  inputs: Record<string, string>,
): string {
  const sorted = Object.keys(inputs)
    .sort()
    .map((k) => [k, inputs[k]] as const);
  return JSON.stringify([name, workingDir, sorted]);
}

// Idempotent: abort the controller and unblock any paused approval node.
// Clearing pendingApprovals is load-bearing; the handler awaits on those
// promises and would otherwise sit forever after the abort fires.
export function cancelActiveRun(entry: ActiveRunEntry): void {
  try {
    entry.abort.abort();
  } catch {
    // already aborted
  }
  for (const pending of entry.pendingApprovals.values()) {
    try {
      pending.reject(new Error("aborted"));
    } catch {
      // already settled
    }
  }
  entry.pendingApprovals.clear();
}

export interface PurgeResult {
  existed: boolean;
  conversationId: string | null;
}

// Cancel the active run if any, await the executor's terminal SQLite write,
// then hard-delete the run row. Returns the row's conversationId so callers
// can cascade-delete the chat side in whichever direction triggered the purge.
export async function purgeWorkflowRun(deps: {
  runId: string;
  store: WorkflowStore;
  activeRuns: ActiveRuns;
}): Promise<PurgeResult> {
  const { runId, store, activeRuns } = deps;
  const entry = activeRuns.get(runId);
  if (entry) {
    cancelActiveRun(entry);
    // Wait for the executor's terminal write to land before deleting the
    // row — otherwise the onEvent callback writes after the row is gone
    // and SQLite silently no-ops the update.
    try {
      await entry.done;
    } catch {
      // executor never throws — abort surfaces as a terminal run_done event
    }
  }
  const snapshot = store.getRun(runId);
  if (!snapshot && !entry) return { existed: false, conversationId: null };
  store.deleteRun(runId);
  return { existed: true, conversationId: snapshot?.conversationId ?? null };
}

class ActiveRunRegistry implements ActiveRuns {
  private readonly runs = new Map<string, ActiveRunEntry>();

  register(runId: string, entry: ActiveRunEntry): void {
    this.runs.set(runId, entry);
  }

  get(runId: string): ActiveRunEntry | undefined {
    return this.runs.get(runId);
  }

  findActive(
    dedupeKey: string,
  ): { runId: string; conversationId: string; definition?: WorkflowDefinition } | undefined {
    for (const [runId, entry] of this.runs) {
      if (entry.dedupeKey === dedupeKey) {
        return {
          runId,
          conversationId: entry.conversationId,
          ...(entry.definition ? { definition: entry.definition } : {}),
        };
      }
    }
    return undefined;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  size(): number {
    return this.runs.size;
  }

  async abortAll(): Promise<void> {
    const dones: Promise<unknown>[] = [];
    for (const entry of this.runs.values()) {
      cancelActiveRun(entry);
      dones.push(entry.done);
    }
    await Promise.allSettled(dones);
  }
}

export function createActiveRuns(): ActiveRuns {
  return new ActiveRunRegistry();
}

// Per-run WS subscriber manager. Mirrors the chat connection manager (the
// chat WS is keyed by conversationId implicitly through the request frame;
// workflow runs are keyed by runId at the URL path). One Set of sockets per
// runId; cleanup runs on close. Frames are typed values constructed by the
// executor; the SPA parses workflowFrameSchema on receive.
export interface WorkflowSubscribers {
  subscribe(runId: string, ws: ServerWebSocket<WsData>): void;
  unsubscribe(runId: string, ws: ServerWebSocket<WsData>): void;
  broadcast(runId: string, frame: WorkflowFrame): void;
  hasRun(runId: string): boolean;
  closeRun(runId: string, code?: number, reason?: string): void;
  // In-process frame listener — the same frames the WS sockets receive, fanned
  // to an in-process consumer. Powers the WorkflowController's
  // awaitPauseOrTerminal so a chat tool can follow a run without opening a
  // loopback WebSocket. Returns an unsubscribe fn; listeners self-manage their
  // lifecycle (closeRun does not touch them).
  onFrame(runId: string, listener: (frame: WorkflowFrame) => void): () => void;
}

class WorkflowSubscriberRegistry implements WorkflowSubscribers {
  private readonly subscribers = new Map<string, Set<ServerWebSocket<WsData>>>();
  private readonly listeners = new Map<string, Set<(frame: WorkflowFrame) => void>>();

  subscribe(runId: string, ws: ServerWebSocket<WsData>): void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(ws);
  }

  unsubscribe(runId: string, ws: ServerWebSocket<WsData>): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.subscribers.delete(runId);
  }

  broadcast(runId: string, frame: WorkflowFrame): void {
    const set = this.subscribers.get(runId);
    if (set && set.size > 0) {
      const json = JSON.stringify(frame);
      for (const ws of set) {
        try {
          ws.send(json);
        } catch {
          // socket closed mid-send; close handler will drain it
        }
      }
    }
    const listeners = this.listeners.get(runId);
    if (listeners && listeners.size > 0) {
      // Snapshot before iterating — a listener that resolves on this frame
      // (e.g. run_done) unsubscribes synchronously, mutating the set mid-loop.
      for (const fn of [...listeners]) {
        try {
          fn(frame);
        } catch {
          // listener errors are isolated from the broadcast and other listeners
        }
      }
    }
  }

  onFrame(runId: string, listener: (frame: WorkflowFrame) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  hasRun(runId: string): boolean {
    return this.subscribers.has(runId);
  }

  closeRun(runId: string, code = 1000, reason = "run complete"): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    for (const ws of set) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.subscribers.delete(runId);
  }
}

export function createWorkflowSubscribers(): WorkflowSubscribers {
  return new WorkflowSubscriberRegistry();
}

class RunArtifactsDir {
  private constructor(private readonly dir: string | undefined) {}

  // Deterministic per-run path (no mkdtemp suffix): a resumed execution must
  // land in the SAME dir so artifacts written by seeded nodes (plan.md,
  // .issue-number) — and the absolute paths their outputs embed — stay valid.
  static async create(runId: string): Promise<RunArtifactsDir> {
    try {
      const dir = join(tmpdir(), `keelson-run-${runId}`);
      // 0o700 preserves mkdtemp's owner-only posture — artifacts can hold
      // issue text and plans that other local users shouldn't read.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return new RunArtifactsDir(dir);
    } catch (err) {
      console.warn(
        `[workflows] failed to create artifacts dir for ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new RunArtifactsDir(undefined);
    }
  }

  runWorkflowOptions(): { artifactsDir?: string } {
    return this.dir !== undefined ? { artifactsDir: this.dir } : {};
  }

  async cleanup(): Promise<void> {
    if (this.dir === undefined) return;
    // force:true swallows ENOENT so a workflow that already cleaned its own
    // dir doesn't crash the finally. recursive removes anything the run wrote.
    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[workflows] failed to remove artifacts dir ${this.dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// Resolves the prompt handler + memory tools an executor run needs from the
// handler options. Shared by workflowsRoutes and createWorkflowController so
// both the HTTP and chat-tool start paths build runs with identical wiring.
// The memory tools re-parse with the Zod wire schemas at the adapter boundary
// so executor-built requests satisfy the same constraints as the HTTP route.
function buildExecutionDeps(opts: WorkflowsHandlerOptions): {
  promptHandler: NodeHandler;
  memoryTools: MemoryTools | undefined;
  projectNotebookStore: ProjectNotebookStore | undefined;
} {
  const promptHandler = opts.promptHandler ?? placeholderPromptHandler;
  const memoryStore = opts.memoryStore;
  const memoryTools =
    memoryStore !== undefined
      ? {
          recall: (req: unknown) => {
            const parsed = recallRequestSchema.parse(req);
            return Promise.resolve(memoryStore.recall(parsed));
          },
          writeback: (req: unknown) => {
            const parsed = writebackRequestSchema.parse(req);
            return Promise.resolve(memoryStore.writeback(parsed));
          },
        }
      : undefined;
  return { promptHandler, memoryTools, projectNotebookStore: opts.projectNotebookStore };
}

interface StartRunCoreDeps {
  store: WorkflowStore;
  conversationStore: ConversationStore;
  projectsStore?: ProjectsStore;
  activeRuns: ActiveRuns;
  subscribers: WorkflowSubscribers;
  promptHandler: NodeHandler;
  memoryTools: MemoryTools | undefined;
  projectNotebookStore?: ProjectNotebookStore;
  snapshotManager?: SnapshotManager;
  ribWorkflowBindings?: Map<WorkflowDefinition, RibWorkflowBinding>;
  usageStore?: UsageStore;
  workspaceManager?: WorkspaceManager;
  mutationLockManager?: MutationLockManager;
}

interface StartRunCoreParams {
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
  workingDir: string;
  projectId: string | null;
  resolvedProject: Pick<Project, "id" | "rootPath"> | null;
  isolationOn: boolean;
  branchTemplate: string | undefined;
  worktreeBase: string | undefined;
  // Trigger provenance for the run row. Omitted → 'manual'. The owning rib id
  // (null for local workflows) is stamped so the runs feed can badge/filter and
  // bulk-delete by rib even after the rib is removed.
  origin?: WorkflowRunOrigin;
  ribId?: string | null;
}

// Seed-map builder from persisted rows: maps succeeded rows to NodeOutput so
// the executor can re-enter from the first incomplete node. Skipped rows are
// deliberately NOT seeded: a persisted skip can be a failure cascade (upstream
// failed → trigger_rule skipped the tail), and replaying it would keep the tail
// skipped after the failed node re-runs. Skips are pure re-derivations —
// trigger_rule / when: evaluate over the seeded upstream outputs, so a
// legitimate condition-skip re-derives identically. Failed/awaiting rows are
// likewise excluded so they re-run on resume. `alwaysRun` node ids are excluded
// too, so a node marked `always_run: true` re-executes on resume even though it
// succeeded (a gate/validation should re-check, not replay a stale pass).
function buildResumeSeed(
  nodes: NodeOutputRow[],
  alwaysRun: ReadonlySet<string> = new Set(),
): Map<string, NodeOutput> {
  const seed = new Map<string, NodeOutput>();
  for (const node of nodes) {
    if (node.status === "succeeded" && !alwaysRun.has(node.nodeId)) {
      seed.set(node.nodeId, {
        state: "completed",
        output: node.outputText ?? "",
        ...(node.startedAt !== null ? { startedAt: node.startedAt } : {}),
        ...(node.completedAt !== null ? { completedAt: node.completedAt } : {}),
      });
    }
  }
  return seed;
}

// Bind a project notebook adapter (read + contribute), but only when the working
// dir actually resolves inside the resolved project — a display-only projectId
// with an overriding workingDir outside the project must not touch its notebook.
// Shared by the start and resume paths so a resumed run gets the same notebook
// the fresh run had.
function buildNotebookAdapter(
  projectNotebookStore: ProjectNotebookStore | undefined,
  projectId: string | null,
  projectRootPath: string | null,
  workingDir: string,
): NotebookAdapter | undefined {
  if (
    !projectNotebookStore ||
    projectId === null ||
    projectRootPath === null ||
    !isPathInside(canonicalPath(projectRootPath), canonicalPath(workingDir))
  ) {
    return undefined;
  }
  const nbStore = projectNotebookStore;
  const pid = projectId;
  return {
    read: () => {
      const content = nbStore.get(pid)?.content;
      return content ? formatNotebookSection(content) : undefined;
    },
    append: (entry, section) => ({ ok: nbStore.appendEntry(pid, entry, section).ok }),
  };
}

function resolveMutationLockProjectId(opts: {
  resolvedProject: Pick<Project, "id" | "rootPath"> | null;
  workingDir: string;
  projectsStore?: ProjectsStore;
}): string | null {
  const cwd = canonicalPath(opts.workingDir);
  // Resolve the cwd to its most-specific registered project FIRST, so two runs in
  // the same (possibly nested) checkout always lock the same project id; the
  // caller-supplied project is only a fallback for a cwd under no registered
  // project. Preferring the caller's project could otherwise let concurrent runs
  // lock an outer and an inner project independently and mutate the same tree.
  const byPath = opts.projectsStore?.findByPathPrefix(cwd)?.id;
  if (byPath !== undefined) return byPath;
  if (
    opts.resolvedProject !== null &&
    isPathInside(canonicalPath(opts.resolvedProject.rootPath), cwd)
  ) {
    return opts.resolvedProject.id;
  }
  return null;
}

function mutationLockOwner(origin: WorkflowRunOrigin, runId: string): string {
  return `${origin === "scheduled" ? "scheduled" : "workflow"}:${runId.slice(0, 8)}`;
}

function acquireRunMutationLock(opts: {
  mutationLockManager?: MutationLockManager;
  workflow: WorkflowDefinition;
  lockProjectId: string | null;
  runId: string;
  origin: WorkflowRunOrigin;
}): MutationLockHandle | undefined {
  const { mutationLockManager, workflow, lockProjectId, runId, origin } = opts;
  if (
    mutationLockManager === undefined ||
    lockProjectId === null ||
    workflow.mutates_checkout === false
  ) {
    return undefined;
  }
  return mutationLockManager.acquire({
    projectId: lockProjectId,
    purpose: workflow.name,
    owner: mutationLockOwner(origin, runId),
  });
}

function releaseMutationLockNow(runId: string, lockHandle: MutationLockHandle): void {
  try {
    lockHandle.release();
  } catch (err) {
    console.warn(
      `[mutation-lock] failed to release lock ${lockHandle.id} for run ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function releaseMutationLockOnSettle(
  runId: string,
  lockHandle: MutationLockHandle,
  done: Promise<void>,
): void {
  void done
    .finally(() => releaseMutationLockNow(runId, lockHandle))
    .catch((err) => {
      console.warn(
        `[mutation-lock] release chain observed run ${runId} rejection: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}

function startRunErrorStatus(err: unknown): 409 | 500 {
  return err instanceof MutationLockConflictError ? 409 : 500;
}

// Run-launch core: create the linked conversation + run row, spawn the
// background executor, register the active run. Both the HTTP start route and
// the WorkflowController call this after resolving inputs / working dir, so the
// conversation→run→spawn→register sequence has a single definition. Throws
// (after rolling back the orphan conversation) when the run row can't be
// written — callers map that to a 500 / tool error.
function startRunCore(
  deps: StartRunCoreDeps,
  params: StartRunCoreParams,
): { runId: string; conversationId: string } {
  const { store, conversationStore, activeRuns, subscribers, promptHandler, memoryTools } = deps;
  const { snapshotManager, ribWorkflowBindings, projectNotebookStore, usageStore } = deps;
  const { workspaceManager, mutationLockManager, projectsStore } = deps;
  const {
    workflow,
    inputs,
    workingDir,
    projectId,
    resolvedProject,
    isolationOn,
    branchTemplate,
    worktreeBase,
  } = params;
  const origin: WorkflowRunOrigin = params.origin ?? "manual";
  const ribId = params.ribId ?? null;
  const notebook = buildNotebookAdapter(
    projectNotebookStore,
    projectId,
    resolvedProject?.rootPath ?? null,
    workingDir,
  );
  const name = workflow.name;
  const dedupeKey = runDedupeKey(name, workingDir, inputs);
  const lockProjectId = resolveMutationLockProjectId({
    resolvedProject,
    workingDir,
    projectsStore,
  });
  // De-dup only non-isolated producer refreshes — bound producers AND any
  // scheduled-origin start (the heartbeat, /refresh, a rib's ctx.refreshWorkflow),
  // which covers unbound region workflows too: a concurrent start with an
  // identical (workflow, workingDir, inputs) already live returns that run,
  // serializing the two-tabs / client-open vs server-tick races. The live run
  // must also be executing the SAME resolved definition — the key is name-based
  // and one name can resolve differently per scope/origin (a manual run of a
  // project shadow vs a scheduled run of the global copy). Arbitrary /runs and
  // chat starts aren't collapsed, so their inputs are untouched. Isolated runs
  // are excluded because they linger in activeRuns through an awaited worktree
  // teardown after `run_done` — de-duping them could hand back a terminal run.
  // A non-isolated run is gone by `run_done` (prompt delete), so the live run
  // matched here is never terminal.
  if ((origin === "scheduled" || ribWorkflowBindings?.has(workflow)) && !isolationOn) {
    const existing = activeRuns.findActive(dedupeKey);
    if (existing && existing.definition === workflow) {
      return { runId: existing.runId, conversationId: existing.conversationId };
    }
  }
  const runId = crypto.randomUUID();
  let lockHandle = !isolationOn
    ? acquireRunMutationLock({
        mutationLockManager,
        workflow,
        lockProjectId,
        runId,
        origin,
      })
    : undefined;
  const isolationFallbackLock =
    isolationOn &&
    mutationLockManager !== undefined &&
    workflow.mutates_checkout !== false &&
    lockProjectId !== null
      ? {
          manager: mutationLockManager,
          projectId: lockProjectId,
          purpose: workflow.name,
          owner: mutationLockOwner(origin, runId),
        }
      : undefined;
  const startedAt = new Date().toISOString();
  let conversation: ReturnType<ConversationStore["create"]> | undefined;
  try {
    // Create the conversation FIRST so the workflow_runs FK has a target.
    conversation = conversationStore.create({
      providerId: "workflow",
      name: `${name} · ${runId.slice(0, 6)}`,
    });
    conversationStore.appendMessage(conversation.id, {
      id: crypto.randomUUID(),
      role: "user",
      content: formatDispatchMessage(name, inputs),
      createdAt: startedAt,
    });
    store.createRun({
      runId,
      workflowName: name,
      inputs,
      startedAt,
      conversationId: conversation.id,
      projectId,
      workingDir,
      origin,
      ribId,
    });
  } catch (err) {
    if (lockHandle !== undefined) {
      releaseMutationLockNow(runId, lockHandle);
      lockHandle = undefined;
    }
    // Orphan rollback: the conversation row exists only to anchor a run, so
    // if createRun throws drop the empty conversation rather than leak it.
    if (conversation !== undefined) {
      try {
        conversationStore.delete(conversation.id);
      } catch (cleanupErr) {
        console.warn(
          `[workflows] orphan-rollback failed for conversation ${conversation.id}: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[workflows] createRun failed for ${name}: ${message}`);
    throw new Error(`failed to create run: ${message}`);
  }
  const abort = new AbortController();
  const pendingApprovals = new Map<string, PendingApproval>();
  const done = executeRunInBackground({
    workflow,
    runId,
    inputs,
    cwd: workingDir,
    store,
    abort,
    activeRuns,
    subscribers,
    promptHandler,
    pendingApprovals,
    isolation: isolationOn
      ? {
          branchTemplate,
          base: worktreeBase,
          // Anchor worktrees at the project's rootPath whenever workingDir sits
          // inside it (incl. equal); fall back to workingDir otherwise.
          projectRootPath:
            resolvedProject &&
            (workingDir === resolvedProject.rootPath ||
              workingDir.startsWith(`${resolvedProject.rootPath}${sep}`))
              ? resolvedProject.rootPath
              : workingDir,
        }
      : null,
    ...(projectId !== null ? { projectId } : {}),
    ...(memoryTools !== undefined ? { memoryTools } : {}),
    ...(notebook !== undefined ? { notebook } : {}),
    ...(snapshotManager !== undefined ? { snapshotManager } : {}),
    ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
    ...(usageStore !== undefined ? { usageStore } : {}),
    ...(workspaceManager !== undefined ? { workspaceManager } : {}),
    ...(isolationFallbackLock !== undefined ? { isolationFallbackLock } : {}),
  });
  try {
    activeRuns.register(runId, {
      abort,
      done,
      pendingApprovals,
      dedupeKey,
      definition: workflow,
      conversationId: conversation.id,
    });
  } catch (err) {
    if (lockHandle !== undefined) {
      releaseMutationLockNow(runId, lockHandle);
      lockHandle = undefined;
    }
    throw err;
  }
  if (lockHandle !== undefined) {
    releaseMutationLockOnSettle(runId, lockHandle, done);
    lockHandle = undefined;
  }
  // Retention is a creation-time invariant of scheduled runs, so it covers the
  // heartbeat AND panel /refresh uniformly (rather than only firing on a
  // scheduler tick). Manual runs are never auto-pruned.
  if (origin === "scheduled") {
    pruneScheduledRuns(store, conversationStore, name);
  }
  return { runId, conversationId: conversation.id };
}

export type ResumeRunResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_terminal" | "locked";
      message: string;
    };

// Resume-run core: load a terminal run, validate it's terminal (not running/paused),
// build the seed from persisted node outputs, flip back to running, and re-enter
// the executor. Returns a discriminated result so the HTTP route maps it to
// appropriate status codes.
function resumeRunCore(
  deps: Omit<StartRunCoreDeps, "conversationStore"> & {
    catalog: WorkflowCatalog;
    projectsStore?: ProjectsStore;
  },
  runId: string,
): ResumeRunResult {
  const { store, activeRuns, subscribers, promptHandler, memoryTools } = deps;
  const { snapshotManager, ribWorkflowBindings, catalog, usageStore } = deps;
  const { workspaceManager, mutationLockManager } = deps;
  const { projectsStore, projectNotebookStore } = deps;

  const run = store.getRun(runId);
  if (!run) {
    return { ok: false, reason: "not_found", message: `unknown run '${runId}'` };
  }
  if (run.status === "running" || run.status === "paused") {
    return {
      ok: false,
      reason: "not_terminal",
      message: `run is still in progress (status: ${run.status})`,
    };
  }

  const scope = { projectId: run.projectId ?? undefined };
  const workflow = catalog.get(run.workflowName, scope);
  if (!workflow) {
    return {
      ok: false,
      reason: "not_found",
      message: `workflow '${run.workflowName}' not found in catalog`,
    };
  }

  const alwaysRun = new Set(
    workflow.nodes
      .filter((n) => (n as { always_run?: boolean }).always_run === true)
      .map((n) => n.id),
  );
  const completedNodeOutputs = buildResumeSeed(run.nodes, alwaysRun);

  if (!run.workingDir) {
    return {
      ok: false,
      reason: "not_terminal",
      message: `run has no working directory`,
    };
  }

  if (!run.conversationId) {
    return {
      ok: false,
      reason: "not_terminal",
      message: `run has no associated conversation`,
    };
  }

  // Resolve the run's project from its persisted id so the resumed run binds the
  // same notebook adapter a fresh run would (the start path resolves it too).
  const resumeProject = run.projectId !== null ? (projectsStore?.get(run.projectId) ?? null) : null;
  const notebook = buildNotebookAdapter(
    projectNotebookStore,
    run.projectId,
    resumeProject?.rootPath ?? null,
    run.workingDir,
  );
  const resumeLockProjectId = resolveMutationLockProjectId({
    resolvedProject: resumeProject,
    workingDir: run.workingDir,
    projectsStore,
  });
  let lockHandle: MutationLockHandle | undefined;
  try {
    lockHandle =
      run.worktreePath === null
        ? acquireRunMutationLock({
            mutationLockManager,
            workflow,
            lockProjectId: resumeLockProjectId,
            runId,
            origin: run.origin,
          })
        : undefined;
  } catch (err) {
    if (err instanceof MutationLockConflictError) {
      // A lock conflict is NOT a terminal-state problem — the run is resumable, but
      // another run holds the project lock. Distinct reason so the 409 mapping and
      // the resume-tool hint don't misreport it as "only failed/cancelled can resume".
      return { ok: false, reason: "locked", message: err.message };
    }
    throw err;
  }

  // Atomically claim the run: one UPDATE flips failed/cancelled → running. A
  // succeeded (or otherwise non-interrupted) run, or one a concurrent resume
  // already claimed, loses here — only the winner launches a background run.
  if (!store.claimRunForResume(runId)) {
    if (lockHandle !== undefined) {
      releaseMutationLockNow(runId, lockHandle);
      lockHandle = undefined;
    }
    return {
      ok: false,
      reason: "not_terminal",
      message: `run '${runId}' is not in a resumable state (only failed or cancelled runs can be resumed)`,
    };
  }

  const abort = new AbortController();
  const pendingApprovals = new Map<string, PendingApproval>();
  let done: Promise<void>;
  try {
    done = executeRunInBackground({
      workflow,
      runId,
      inputs: run.inputs,
      cwd: run.workingDir,
      store,
      abort,
      activeRuns,
      subscribers,
      promptHandler,
      pendingApprovals,
      isolation: null,
      ...(run.projectId !== null ? { projectId: run.projectId } : {}),
      ...(memoryTools !== undefined ? { memoryTools } : {}),
      ...(snapshotManager !== undefined ? { snapshotManager } : {}),
      ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
      ...(usageStore !== undefined ? { usageStore } : {}),
      ...(workspaceManager !== undefined ? { workspaceManager } : {}),
      ...(notebook !== undefined ? { notebook } : {}),
      completedNodeOutputs,
      existingWorktreePath: run.worktreePath ?? undefined,
    });

    activeRuns.register(runId, {
      abort,
      done,
      pendingApprovals,
      dedupeKey: runDedupeKey(workflow.name, run.workingDir, run.inputs),
      definition: workflow,
      conversationId: run.conversationId,
    });
  } catch (err) {
    if (lockHandle !== undefined) {
      releaseMutationLockNow(runId, lockHandle);
      lockHandle = undefined;
    }
    throw err;
  }
  if (lockHandle !== undefined) {
    releaseMutationLockOnSettle(runId, lockHandle, done);
    lockHandle = undefined;
  }

  return { ok: true };
}

export type ResolveApprovalResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "no_pending" | "stale_pause" | "settle_failed";
      message: string;
    };

// Approval-resume core: look up the pending approval, guard the pauseId, flip
// the run back to running (when no other approvals remain), and settle the
// executor's awaited promise. Returns a discriminated result so the HTTP route
// maps it to 404/409 and the chat tool maps it to a message.
function resolveApprovalCore(
  deps: { activeRuns: ActiveRuns; store: WorkflowStore },
  runId: string,
  body: { nodeId: string; text: string; pauseId?: string },
): ResolveApprovalResult {
  const { activeRuns, store } = deps;
  const entry = activeRuns.get(runId);
  if (!entry) {
    return { ok: false, reason: "not_found", message: `unknown or completed run '${runId}'` };
  }
  const pending = entry.pendingApprovals.get(body.nodeId);
  if (!pending) {
    return {
      ok: false,
      reason: "no_pending",
      message: `no pending approval for node '${body.nodeId}'`,
    };
  }
  // pauseId guard — interactive loops reuse the same nodeId across iterations,
  // so a stale resume for an earlier pause must not settle a later one.
  if (body.pauseId !== undefined && body.pauseId !== pending.pauseId) {
    return {
      ok: false,
      reason: "stale_pause",
      message: `pauseId mismatch for node '${body.nodeId}' — the pause has advanced; refetch the run state and retry`,
    };
  }
  // Flip back to running BEFORE handing the text to the executor so the
  // snapshot can't briefly report 'paused' after the next node starts writing.
  entry.pendingApprovals.delete(body.nodeId);
  if (entry.pendingApprovals.size === 0) {
    try {
      store.updateRunStatus({ runId, status: "running", completedAt: null, error: null });
    } catch (err) {
      console.warn(
        `[workflows] resume: failed to flip ${runId} back to running: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  try {
    pending.resolve(body.text);
  } catch (err) {
    return {
      ok: false,
      reason: "settle_failed",
      message: `resume failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

// Result of awaitPauseOrTerminal — the run's next observable boundary.
export type WatchResult =
  | { kind: "paused"; nodeId: string; pauseId: string; message: string }
  | { kind: "terminal"; status: WorkflowRunStatus }
  | { kind: "running" }
  | { kind: "unknown" };

export interface AwaitPauseOrTerminalOptions {
  // Forwarded the non-terminal, non-pause frames (node_started, node_chunk,
  // node_log, run_warning) so a chat tool can stream live progress.
  onFrame?: (frame: WorkflowFrame) => void;
  // When aborted, watching detaches and resolves `running` — the run keeps
  // executing in the background.
  signal?: AbortSignal;
  // Soft cap on a single watch so a long no-approval run doesn't pin a chat
  // turn forever; on expiry resolves `running`.
  deadlineMs?: number;
}

export type StartRunResult =
  | { ok: true; runId: string; conversationId: string }
  | { ok: false; message: string };

// In-process facade over the workflow engine for non-HTTP callers (the chat
// tools). Shares the SAME activeRuns + subscribers + store the HTTP routes use,
// so a run started here is identical to one started over the API.
export interface WorkflowController {
  startRun(params: {
    name: string;
    inputs: Record<string, string>;
    workingDir: string;
    // Explicit project selection for chat-callers that resolved a project by id/name.
    // When provided, this pins workflow-definition scope and run tagging to that
    // project instead of re-deriving from workingDir.
    project?: Pick<Project, "id" | "rootPath">;
    isolation?: IsolationOverride;
    // Defaults to 'manual'. The heartbeat passes 'scheduled' so producer runs
    // stay out of the default feed and get retention-pruned.
    origin?: WorkflowRunOrigin;
  }): StartRunResult;
  // The live run for an identical (name, workingDir, inputs), or undefined — the
  // heartbeat scheduler's pre-check so it won't re-fire a collector still running.
  findActiveRun(
    name: string,
    workingDir: string,
    inputs: Record<string, string>,
  ): { runId: string; conversationId: string } | undefined;
  resolveApproval(
    runId: string,
    body: { nodeId: string; text: string; pauseId?: string },
  ): ResolveApprovalResult;
  // Re-enter a terminal (failed/cancelled) run from its last completed node,
  // reusing the persisted worktree + node outputs. The same core the HTTP
  // resume-run route drives; NOT the approval-resolution path above.
  resumeRun(runId: string): ResumeRunResult;
  awaitPauseOrTerminal(runId: string, opts?: AwaitPauseOrTerminalOptions): Promise<WatchResult>;
  listRuns(opts?: { status?: WorkflowRunStatus }): WorkflowRunSummary[];
  getRun(runId: string): WorkflowRunDetail | undefined;
  // Live pending approvals for a run, including the in-memory `pauseId` that the
  // persisted snapshot (getRun) cannot carry. Empty for a run with no live
  // resolver (terminal, unknown, or paused-but-reconciled after restart).
  pendingApprovals(runId: string): Array<{ nodeId: string; pauseId: string; message: string }>;
  // Execute an in-memory workflow DEFINITION (not a catalog name) and resolve to its
  // terminal result — backs RibContext.runWorkflow. Validates the definition, assembles
  // a headless handler map (approval fails fast — there is no UI to pause on), runs the
  // shared executor at `cwd`, and never throws (every failure maps to a failed result).
  runDefinition(
    definition: unknown,
    inputs: Record<string, string>,
    cwd: string,
    ribId?: string,
  ): Promise<RibWorkflowRunResult>;
}

// Map the executor's RunSummary onto the @keelson/shared structural result the rib seam
// returns (only id -> {state, output, error?}, dropping usage/timing).
function summaryToRibWorkflowResult(summary: RunSummary): RibWorkflowRunResult {
  const nodes: RibWorkflowRunResult["nodes"] = {};
  let firstNodeError: string | undefined;
  for (const [id, output] of Object.entries(summary.nodes)) {
    nodes[id] = {
      state: output.state,
      output: output.output,
      ...(output.state === "failed" ? { error: output.error } : {}),
    };
    if (output.state === "failed" && output.error !== undefined && firstNodeError === undefined) {
      firstNodeError = output.error;
    }
  }
  // Surface the first failed node's error as the run-level error so a caller
  // reading only `result.error` on a failed run learns why (the contract).
  return {
    status: summary.status,
    nodes,
    ...(summary.status === "failed" && firstNodeError !== undefined
      ? { error: firstNodeError }
      : {}),
  };
}

const DEFAULT_WATCH_DEADLINE_MS = 75_000;

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function createWorkflowController(
  opts: WorkflowsHandlerOptions,
  activeRuns: ActiveRuns,
  subscribers: WorkflowSubscribers,
): WorkflowController {
  const {
    catalog,
    store,
    conversationStore,
    projectsStore,
    snapshotManager,
    ribWorkflowBindings,
    usageStore,
    workspaceManager,
    mutationLockManager,
  } = opts;
  const { promptHandler, memoryTools, projectNotebookStore } = buildExecutionDeps(opts);

  return {
    async runDefinition(
      definition: unknown,
      inputs: Record<string, string>,
      cwd: string,
      ribId?: string,
    ): Promise<RibWorkflowRunResult> {
      const parsed = workflowDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        return { status: "failed", nodes: {}, error: `invalid workflow: ${parsed.error.message}` };
      }
      const definitionObj = parsed.data as WorkflowDefinition;
      const invariantError = validateWorkflowInvariants(definitionObj);
      if (invariantError) {
        return { status: "failed", nodes: {}, error: `invalid workflow: ${invariantError}` };
      }
      let workingDir: string;
      try {
        if (!statSync(cwd).isDirectory()) {
          return { status: "failed", nodes: {}, error: `cwd is not a directory: ${cwd}` };
        }
        workingDir = canonicalPath(cwd);
      } catch {
        return { status: "failed", nodes: {}, error: `cwd does not exist: ${cwd}` };
      }
      // Scope memory to the project the cwd sits in, matching the named-run path
      // (an unscoped run bleeds memory rows across targets).
      const projectId = projectsStore?.findByPathPrefix(workingDir)?.id;
      const runId = crypto.randomUUID();
      const abort = new AbortController();
      const handlers = new Map<string, NodeHandler>([
        ["bash", bashHandler],
        ["prompt", promptHandler],
        // No UI to pause on for a rib-driven run — approval fails fast, cancel aborts.
        [
          "approval",
          makeApprovalHandler({
            awaitApproval: async (_runId, nodeId, message) => {
              throw new Error(
                `approval node '${nodeId}' cannot resolve in a rib-run workflow (message: "${message}")`,
              );
            },
          }),
        ],
        [
          "cancel",
          makeCancelHandler({
            requestCancel: async () => {
              abort.abort();
            },
          }),
        ],
        ["command", makeCommandHandler({ promptHandler })],
        ["loop", makeLoopHandler({ promptHandler, runUntilBashProbe: defaultRunUntilBashProbe })],
        ["script", makeScriptHandler()],
      ]);
      const artifacts = await RunArtifactsDir.create(runId);
      // Register in the shared run table so a server shutdown aborts an in-flight
      // rib-run's bash/script subtree like a named run — a headless run writes no
      // store row (a unique key keeps it out of dedupe/findActive), leaving only a
      // live process tree to reap.
      let settleDone: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settleDone = resolve;
      });
      activeRuns.register(runId, {
        abort,
        done,
        pendingApprovals: new Map(),
        dedupeKey: runId,
        conversationId: "",
      });
      try {
        const nodeStart = new Map<string, string>();
        const summary = await runWorkflow({
          workflow: definitionObj,
          runId,
          inputs,
          handlers,
          cwd: workingDir,
          abortSignal: abort.signal,
          ...(usageStore !== undefined
            ? {
                onEvent: (event: RunStreamEvent) => {
                  if (event.type === "node_started") {
                    nodeStart.set(event.nodeId, new Date().toISOString());
                    return;
                  }
                  if (event.type !== "node_done") return;
                  const usage = coerceTokenUsage(event.result.usage);
                  const provider = sanitizeProvenanceField(event.result.provider);
                  const model = sanitizeProvenanceField(event.result.model);
                  if (usage === undefined || provider === null || model === null) return;
                  const completedAt = new Date().toISOString();
                  recordNodeUsage({
                    usageStore,
                    usage,
                    provider,
                    model,
                    status: event.result.status,
                    startedAt: nodeStart.get(event.nodeId) ?? null,
                    completedAt,
                    attribution: {
                      runId,
                      nodeId: event.nodeId,
                      workflowName: definitionObj.name,
                      conversationId: null,
                      projectId: projectId ?? null,
                      ribId: ribId ?? null,
                    },
                  });
                  nodeStart.delete(event.nodeId);
                },
              }
            : {}),
          ...artifacts.runWorkflowOptions(),
          ...(memoryTools !== undefined ? { memoryTools } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
        });
        return summaryToRibWorkflowResult(summary);
      } catch (err) {
        return {
          status: "failed",
          nodes: {},
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        activeRuns.delete(runId);
        await artifacts.cleanup();
        settleDone();
      }
    },
    startRun({ name, inputs, workingDir: rawWorkingDir, project, isolation, origin }) {
      try {
        if (!statSync(rawWorkingDir).isDirectory()) {
          return { ok: false, message: `workingDir is not a directory: ${rawWorkingDir}` };
        }
      } catch {
        return { ok: false, message: `workingDir does not exist: ${rawWorkingDir}` };
      }
      const workingDir = canonicalPath(rawWorkingDir);
      const selectedProject =
        project !== undefined ? { ...project, rootPath: canonicalPath(project.rootPath) } : null;
      // Project resolution precedes the lookup so a workingDir inside a
      // registered project sees that project's workflows (shadowing global).
      // Scheduled producer runs are the exception: they must always resolve
      // the rib's own definition (snapshot bindings are object-identity-keyed,
      // so a project shadow would run uselessly and never publish).
      const resolvedProject =
        selectedProject ?? projectsStore?.findByPathPrefix(workingDir) ?? null;
      const projectId = resolvedProject?.id ?? null;
      const scope = origin === "scheduled" || projectId === null ? undefined : { projectId };
      const workflow = catalog.get(name, scope);
      if (!workflow) return { ok: false, message: `unknown workflow '${name}'` };
      const yamlEnabled = workflow.worktree?.enabled === true;
      const isolationOn =
        isolation === "worktree" ? true : isolation === "none" ? false : yamlEnabled;
      try {
        const { runId, conversationId } = startRunCore(
          {
            store,
            conversationStore,
            ...(projectsStore !== undefined ? { projectsStore } : {}),
            activeRuns,
            subscribers,
            promptHandler,
            memoryTools,
            ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
            ...(snapshotManager !== undefined ? { snapshotManager } : {}),
            ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
            ...(usageStore !== undefined ? { usageStore } : {}),
            ...(workspaceManager !== undefined ? { workspaceManager } : {}),
            ...(mutationLockManager !== undefined ? { mutationLockManager } : {}),
          },
          {
            workflow,
            inputs,
            workingDir,
            projectId,
            resolvedProject,
            isolationOn,
            branchTemplate: workflow.worktree?.branch,
            worktreeBase: workflow.worktree?.base,
            origin: origin ?? "manual",
            ribId: ribIdFor(catalog, workflow.name, scope),
          },
        );
        return { ok: true, runId, conversationId };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    findActiveRun(name, workingDir, inputs) {
      return activeRuns.findActive(runDedupeKey(name, workingDir, inputs));
    },

    resolveApproval(runId, body) {
      return resolveApprovalCore({ activeRuns, store }, runId, body);
    },

    resumeRun(runId) {
      return resumeRunCore(
        {
          store,
          activeRuns,
          subscribers,
          promptHandler,
          memoryTools,
          catalog,
          ...(projectsStore !== undefined ? { projectsStore } : {}),
          ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
          ...(snapshotManager !== undefined ? { snapshotManager } : {}),
          ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
          ...(usageStore !== undefined ? { usageStore } : {}),
          ...(workspaceManager !== undefined ? { workspaceManager } : {}),
          ...(mutationLockManager !== undefined ? { mutationLockManager } : {}),
        },
        runId,
      );
    },

    awaitPauseOrTerminal(runId, options = {}) {
      const { onFrame, signal, deadlineMs = DEFAULT_WATCH_DEADLINE_MS } = options;
      const existing = store.getRun(runId);
      if (!existing) return Promise.resolve<WatchResult>({ kind: "unknown" });
      if (isTerminalStatus(existing.status)) {
        return Promise.resolve<WatchResult>({ kind: "terminal", status: existing.status });
      }
      return new Promise<WatchResult>((resolve) => {
        let settled = false;
        let unsubscribe: () => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: WatchResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          unsubscribe();
          resolve(result);
        };
        const onAbort = (): void => finish({ kind: "running" });
        unsubscribe = subscribers.onFrame(runId, (frame) => {
          if (frame.type === "approval_awaiting") {
            finish({
              kind: "paused",
              nodeId: frame.nodeId,
              pauseId: frame.pauseId,
              message: frame.message,
            });
          } else if (frame.type === "run_done") {
            finish({ kind: "terminal", status: frame.status });
          } else if (onFrame) {
            onFrame(frame);
          }
        });
        if (signal) {
          if (signal.aborted) {
            finish({ kind: "running" });
            return;
          }
          signal.addEventListener("abort", onAbort);
        }
        timer = setTimeout(() => finish({ kind: "running" }), deadlineMs);
        // Post-subscribe race re-check: the pause/terminal frame may have fired
        // between the initial store read and the onFrame attach above.
        const after = store.getRun(runId);
        if (!after) {
          finish({ kind: "unknown" });
          return;
        }
        if (isTerminalStatus(after.status)) {
          finish({ kind: "terminal", status: after.status });
          return;
        }
        if (after.status === "paused") {
          const pending = activeRuns.get(runId)?.pendingApprovals.values().next().value;
          if (pending) {
            finish({
              kind: "paused",
              nodeId: pending.nodeId,
              pauseId: pending.pauseId,
              message: pending.message,
            });
          }
          // A 'paused' row with no in-memory resolver (boot-reconciliation
          // window) just keeps waiting; the deadline / abort releases it.
        }
      });
    },

    listRuns(opts2 = {}) {
      if (opts2.status) return store.listRunsByStatus(opts2.status);
      return [...store.listRunsByStatus("running"), ...store.listRunsByStatus("paused")];
    },

    getRun(runId) {
      return store.getRun(runId);
    },

    pendingApprovals(runId) {
      const entry = activeRuns.get(runId);
      if (!entry) return [];
      return [...entry.pendingApprovals.values()].map((p) => ({
        nodeId: p.nodeId,
        pauseId: p.pauseId,
        message: p.message,
      }));
    },
  };
}

export function workflowsRoutes(
  app: Hono,
  opts: WorkflowsHandlerOptions,
  activeRuns: ActiveRuns = createActiveRuns(),
  subscribers: WorkflowSubscribers = createWorkflowSubscribers(),
): void {
  const {
    catalog,
    store,
    conversationStore,
    projectsStore,
    defaultCwd,
    refreshCwd,
    snapshotManager,
    ribWorkflowBindings,
    usageStore,
    workspaceManager,
    mutationLockManager,
    isRegionWorkflow,
  } = opts;
  const {
    promptHandler: effectivePromptHandler,
    memoryTools,
    projectNotebookStore,
  } = buildExecutionDeps(opts);

  // Purge a run and cascade its linked chat conversation. Delete the
  // conversation FIRST (the workflow_runs FK is ON DELETE SET NULL, so this only
  // clears the run's pointer): if it throws, we abort before purging the run —
  // the caller sees the error and can retry — rather than deleting the run row
  // and orphaning the conversation. Returns whether a row actually existed so
  // callers can count / 404.
  const purgeAndCascade = async (runId: string): Promise<boolean> => {
    const conversationId = store.getRun(runId)?.conversationId ?? null;
    if (conversationId !== null) {
      conversationStore.delete(conversationId);
    }
    const { existed } = await purgeWorkflowRun({ runId, store, activeRuns });
    return existed;
  };

  // Optional ?projectId= narrows catalog reads to that project's view
  // (project workflows overlaid on global, project winning name collisions).
  const resolveScopeParam = (
    projectIdParam: string | undefined,
  ): { ok: true; scope?: WorkflowScopeContext } | { ok: false; error: string } => {
    if (projectIdParam === undefined || projectIdParam.length === 0) return { ok: true };
    if (!projectsStore?.get(projectIdParam)) {
      return { ok: false, error: `unknown project '${projectIdParam}'` };
    }
    return { ok: true, scope: { projectId: projectIdParam } };
  };

  app.get("/api/workflows", (c) => {
    const scoped = resolveScopeParam(c.req.query("projectId"));
    if (!scoped.ok) return c.json({ error: scoped.error }, 400);
    const workflows = catalog
      .list(scoped.scope)
      .map((w) => workflowToSummary(w, catalog, scoped.scope));
    return c.json(
      listWorkflowsResponseSchema.parse({
        workflows,
        discoveryNotices: catalog.discoveryNotices(scoped.scope),
      }),
    );
  });

  // Register the literal `/api/workflows/runs` path BEFORE the `/:name`
  // route so Hono doesn't bind `name="runs"` and return a 404. General runs
  // feed: filterable by status / origin / owning rib / workflow, newest first,
  // bounded. `?status=paused` (the long-standing nav-badge + CLI query) still
  // returns exactly the paused rows. No filter → all runs up to `limit`.
  const RUNS_FEED_DEFAULT_LIMIT = 200;
  const RUNS_FEED_MAX_LIMIT = 1000;
  app.get("/api/workflows/runs", (c) => {
    const filter: {
      workflowName?: string;
      origin?: WorkflowRunOrigin;
      ribId?: string;
      statuses?: WorkflowRunStatus[];
      limit: number;
    } = { limit: RUNS_FEED_DEFAULT_LIMIT };

    const statusParam = c.req.query("status");
    if (statusParam !== undefined && statusParam !== "all") {
      const parsed = workflowRunStatusSchema.safeParse(statusParam);
      if (!parsed.success) {
        return c.json({ error: `invalid status '${statusParam}'` }, 400);
      }
      filter.statuses = [parsed.data];
    }

    const originParam = c.req.query("origin");
    if (originParam !== undefined && originParam !== "all") {
      const parsed = workflowRunOriginSchema.safeParse(originParam);
      if (!parsed.success) {
        return c.json({ error: `invalid origin '${originParam}'` }, 400);
      }
      filter.origin = parsed.data;
    }

    const workflowName = c.req.query("workflow");
    if (workflowName) filter.workflowName = workflowName;
    const ribId = c.req.query("ribId");
    if (ribId) filter.ribId = ribId;

    const limitParam = c.req.query("limit");
    if (limitParam !== undefined) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: `invalid limit '${limitParam}'` }, 400);
      }
      filter.limit = Math.min(RUNS_FEED_MAX_LIMIT, Math.floor(n));
    }

    return c.json({ runs: z.array(workflowRunSummarySchema).parse(store.queryRuns(filter)) });
  });

  // Delete a group of runs in one call — either an explicit id list or a filter
  // (e.g. every `scheduled` run, or all runs owned by a rib). Same per-run
  // semantics as DELETE /runs/:runId?purge=1 (cancel active, await terminal
  // write, hard-delete, cascade the linked conversation). Origin-gated like the
  // other state-changing routes.
  app.post("/api/workflows/runs/bulk-delete", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = bulkDeleteRunsBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    let runIds: string[];
    if ("runIds" in parsed.data) {
      runIds = parsed.data.runIds;
    } else {
      const f = parsed.data.filter;
      runIds = store
        .queryRuns({
          ...(f.workflowName !== undefined ? { workflowName: f.workflowName } : {}),
          ...(f.origin !== undefined ? { origin: f.origin } : {}),
          ...(f.ribId !== undefined ? { ribId: f.ribId } : {}),
          ...(f.statuses !== undefined ? { statuses: f.statuses } : {}),
        })
        .map((r) => r.runId);
    }
    let deleted = 0;
    for (const runId of runIds) {
      if (await purgeAndCascade(runId)) deleted += 1;
    }
    return c.json(bulkDeleteRunsResponseSchema.parse({ deleted }));
  });

  // Read-only feed for `keelson worktree prune`. Returns persisted
  // worktree_path values so worktrees from deleted projects (FK NULLed,
  // path retained) stay prunable.
  app.get("/api/workflows/worktree-paths", (c) => {
    return c.json({ paths: store.listWorktreePaths() });
  });

  app.get("/api/workflows/:name", (c) => {
    const name = c.req.param("name");
    const scoped = resolveScopeParam(c.req.query("projectId"));
    if (!scoped.ok) return c.json({ error: scoped.error }, 400);
    const wf = catalog.get(name, scoped.scope);
    if (!wf) return c.json({ error: `unknown workflow '${name}'` }, 404);
    return c.json({ workflow: workflowDetailSchema.parse(workflowToDetail(wf)) });
  });

  app.get("/api/workflows/:name/runs", (c) => {
    const name = c.req.param("name");
    const scoped = resolveScopeParam(c.req.query("projectId"));
    if (!scoped.ok) return c.json({ error: scoped.error }, 400);
    if (!catalog.get(name, scoped.scope)) {
      return c.json({ error: `unknown workflow '${name}'` }, 404);
    }
    const runs = store.listRuns(name);
    return c.json({ runs: z.array(workflowRunSummarySchema).parse(runs) });
  });

  app.post("/api/workflows/:name/runs", async (c) => {
    // This route can execute `bash` nodes — gate cross-origin POSTs with the
    // same Origin allow-list as state-changing routes (CSRF defense against
    // a malicious site form-POSTing the local server while the user is
    // signed in to the SPA).
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const requested = c.req.param("name");
    // Distinguish empty body from malformed JSON. An absent body is fine
    // (inputs defaults to {}); a body that's present but unparseable is a
    // client bug and must surface as 400 — silently defaulting to {} could
    // run bash nodes with empty inputs the caller didn't intend.
    const rawText = await c.req.text();
    let raw: unknown;
    if (rawText.trim().length === 0) {
      raw = {};
    } else {
      try {
        raw = JSON.parse(rawText);
      } catch {
        return c.json({ error: "invalid json body" }, 400);
      }
    }
    const parsed = startWorkflowRunBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // Resolve the run's working directory. The wire schema allows either
    // `projectId` (named pointer) or `workingDir` (raw override) or both —
    // when both are present, `workingDir` wins and `projectId` is preserved
    // for display. When only `workingDir` is set we attempt a longest-prefix
    // lookup so runs anchored inside a registered project still get tagged.
    let resolvedProject: import("@keelson/shared").Project | null = null;
    let projectId: string | null = null;
    let workingDir: string;
    if (parsed.data.workingDir !== undefined && parsed.data.workingDir.trim().length > 0) {
      const raw = parsed.data.workingDir;
      if (!isAbsolute(raw)) {
        return c.json({ error: "workingDir must be an absolute path" }, 400);
      }
      workingDir = canonicalPath(normalize(raw));
      if (parsed.data.projectId !== undefined && projectsStore) {
        const proj = projectsStore.get(parsed.data.projectId);
        if (!proj) {
          return c.json({ error: `unknown project '${parsed.data.projectId}'` }, 400);
        }
        // Canonical rootPath so containment checks against the (canonical)
        // workingDir agree — the same contract findByPathPrefix returns.
        resolvedProject = { ...proj, rootPath: canonicalPath(proj.rootPath) };
      } else if (projectsStore) {
        resolvedProject = projectsStore.findByPathPrefix(workingDir) ?? null;
      }
      if (resolvedProject) {
        projectId = resolvedProject.id;
      }
    } else if (parsed.data.projectId !== undefined && parsed.data.projectId.length > 0) {
      if (!projectsStore) {
        return c.json({ error: "projects are not wired in this server" }, 400);
      }
      const project = projectsStore.get(parsed.data.projectId);
      if (!project) {
        return c.json({ error: `unknown project '${parsed.data.projectId}'` }, 400);
      }
      resolvedProject = { ...project, rootPath: canonicalPath(project.rootPath) };
      projectId = project.id;
      workingDir = resolvedProject.rootPath;
    } else if (defaultCwd !== undefined) {
      workingDir = canonicalPath(defaultCwd);
    } else {
      return c.json({ error: "projectId or workingDir is required" }, 400);
    }

    // Forgiving lookup, scoped to the project that contains the EXECUTION
    // directory (matching controller.startRun, so the same name+dir resolves
    // the same definition on every entry path; an explicit body projectId
    // still tags the run but never picks a different definition than where it
    // runs): exact name wins; otherwise a confident typo resolves to the run
    // while a weak guess returns suggestions rather than auto-starting a
    // possibly-destructive workflow. Runs before the workingDir stat check so
    // an unknown name is always a 404 (the CLI maps 404 → exit 4 with
    // suggestions) regardless of target validity.
    const scopeProjectId = projectsStore?.findByPathPrefix(workingDir)?.id ?? null;
    const scope: WorkflowScopeContext | undefined =
      scopeProjectId !== null ? { projectId: scopeProjectId } : undefined;
    let workflow = catalog.get(requested, scope);
    if (!workflow) {
      const resolution = resolveWorkflowName(
        requested,
        catalog.list(scope).map((w) => w.name),
      );
      if (resolution.kind === "match") {
        workflow = catalog.get(resolution.name, scope);
      } else if (resolution.kind === "suggest") {
        return c.json(
          {
            error: `No workflow named '${requested}'. Did you mean: ${resolution.candidates.join(", ")}?`,
            suggestions: resolution.candidates,
          },
          404,
        );
      }
    }
    if (!workflow) {
      const available = catalog.list(scope).map((w) => w.name);
      return c.json(
        {
          error:
            available.length > 0
              ? `No workflow named '${requested}'. Available: ${available.join(", ")}.`
              : `No workflow named '${requested}'.`,
          ...(available.length > 0 ? { available } : {}),
        },
        404,
      );
    }

    // Fail closed when the resolved target isn't a usable directory. Without
    // this, a `--working-dir package.json` (file) or stale project root would
    // pass schema validation, get a run row written, then crash the executor's
    // pre-start worktree probe before the try/finally that closes the row out.
    try {
      const st = statSync(workingDir);
      if (!st.isDirectory()) {
        return c.json({ error: `workingDir is not a directory: ${workingDir}` }, 400);
      }
    } catch {
      return c.json({ error: `workingDir does not exist: ${workingDir}` }, 400);
    }

    // Resolve isolation policy: YAML default ⊕ per-run override. The override
    // wins when given; otherwise we use the workflow's `worktree.enabled`
    // (defaulting to false). The handler still does the git-repo probe later
    // and warns-then-falls-back if isolation can't be honored.
    const yamlEnabled = workflow.worktree?.enabled === true;
    const isolationOverride: IsolationOverride | null = parsed.data.isolation ?? null;
    const isolationOn =
      isolationOverride === "worktree" ? true : isolationOverride === "none" ? false : yamlEnabled;
    const branchTemplate = workflow.worktree?.branch;

    try {
      const { runId } = startRunCore(
        {
          store,
          conversationStore,
          ...(projectsStore !== undefined ? { projectsStore } : {}),
          activeRuns,
          subscribers,
          promptHandler: effectivePromptHandler,
          memoryTools,
          ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
          ...(snapshotManager !== undefined ? { snapshotManager } : {}),
          ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
          ...(usageStore !== undefined ? { usageStore } : {}),
          ...(workspaceManager !== undefined ? { workspaceManager } : {}),
          ...(mutationLockManager !== undefined ? { mutationLockManager } : {}),
        },
        {
          workflow,
          inputs: parsed.data.inputs,
          workingDir,
          projectId,
          resolvedProject,
          isolationOn,
          branchTemplate,
          worktreeBase: workflow.worktree?.base,
          origin: "manual",
          ribId: ribIdFor(catalog, workflow.name, scope),
        },
      );
      // Echo the canonical name so a fuzzy start (smoketst → smoke-test) hands
      // the client the real name for run-detail / "open in Workflows" routes.
      return c.json({ runId, workflowName: workflow.name });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        startRunErrorStatus(err),
      );
    }
  });

  // Re-run a rib producer workflow to repopulate its bound snapshot key — the
  // "refresh" behind a surface panel's icon. Restricted to bound producers and
  // rib-contributed workflows a rib region declares, and run in the server's
  // default working dir: a general workflow must still go through /runs with an
  // explicit target (so it can't silently execute against the server's install
  // dir), but a producer's node uses absolute paths, so the server owns the
  // nominal cwd here. The region leg checks catalog provenance, not just the
  // name — a filesystem workflow shadowing a region-declared rib name resolves
  // to non-rib provenance and stays 409, mirroring makeBoundKeyResolver's
  // object-identity rule. The new frame fans to the bound key, which the
  // panel's live subscription picks up; an unbound region workflow republishes
  // through the rib's own tools instead. Optional `inputs` carry a region's
  // workflowArgs (e.g. the lens id a shared per-item producer is refreshing) —
  // region-leg only, since a bound producer's single key would make concurrent
  // per-input runs clobber each other.
  app.post("/api/workflows/:name/refresh", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const requested = c.req.param("name");
    const workflow = catalog.get(requested);
    if (!workflow) {
      return c.json({ error: `No workflow named '${requested}'.` }, 404);
    }
    const bound = ribWorkflowBindings?.has(workflow) === true;
    const regionDeclared =
      isRegionWorkflow?.(workflow.name) === true && ribIdFor(catalog, workflow.name) !== null;
    if (!bound && !regionDeclared) {
      return c.json({ error: `workflow '${requested}' is not a refreshable producer` }, 409);
    }
    if (refreshCwd === undefined) {
      return c.json({ error: "server has no refresh working directory" }, 400);
    }
    // The historical body was empty/absent; that still means no inputs. A
    // NON-EMPTY body must parse — folding malformed JSON to {} would run the
    // producer with silently-dropped inputs and report success.
    const rawBody = await c.req.text();
    let body: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "invalid refresh body: not JSON" }, 400);
      }
    }
    const parsedBody = refreshWorkflowBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return c.json({ error: `invalid refresh body: ${parsedBody.error.message}` }, 400);
    }
    if (bound && Object.keys(parsedBody.data.inputs).length > 0) {
      return c.json(
        { error: `workflow '${requested}' is a bound producer — refresh takes no inputs` },
        400,
      );
    }
    try {
      const { runId } = startRunCore(
        {
          store,
          conversationStore,
          ...(projectsStore !== undefined ? { projectsStore } : {}),
          activeRuns,
          subscribers,
          promptHandler: effectivePromptHandler,
          memoryTools,
          ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
          ...(snapshotManager !== undefined ? { snapshotManager } : {}),
          ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
          ...(usageStore !== undefined ? { usageStore } : {}),
          ...(workspaceManager !== undefined ? { workspaceManager } : {}),
          ...(mutationLockManager !== undefined ? { mutationLockManager } : {}),
        },
        {
          workflow,
          inputs: parsedBody.data.inputs,
          workingDir: refreshCwd,
          projectId: null,
          resolvedProject: null,
          // Honor the producer's declared worktree policy, same as /runs — a
          // collector that opts into isolation must not write the live checkout.
          isolationOn: workflow.worktree?.enabled === true,
          branchTemplate: workflow.worktree?.branch,
          worktreeBase: workflow.worktree?.base,
          // A panel refresh is a producer run, same class as the heartbeat's —
          // keep it out of the default (manual) runs feed and subject to prune.
          origin: "scheduled",
          ribId: ribIdFor(catalog, workflow.name),
        },
      );
      return c.json({ runId, workflowName: workflow.name });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        startRunErrorStatus(err),
      );
    }
  });

  app.get("/api/workflows/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const run = store.getRun(runId);
    if (!run) return c.json({ error: `unknown run '${runId}'` }, 404);
    return c.json({ run: workflowRunDetailSchema.parse(run) });
  });

  // Read-only fetch of a file under a run's per-run artifacts dir, sandboxed
  // to that dir. Only resolves while the run is live/paused (the dir is an
  // ephemeral tmpdir cleaned on terminal status). Read-only GET → no origin
  // gate; the /api/* CORS middleware already restricts origins.
  app.get("/api/workflows/runs/:runId/artifact", (c) => {
    const runId = c.req.param("runId");
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path query is required" }, 400);

    const baseDir = activeRuns.get(runId)?.artifactsDir;
    // 410 (not 404): the dir only lives while the run does, so a gone/unknown
    // run is distinct from a missing file in a live run (404). The client maps
    // 410 → "no longer available" but surfaces a real error for a 404.
    if (baseDir === undefined) {
      return c.json({ error: `no live artifacts for run '${runId}'` }, 410);
    }

    if (isAbsolute(rel) || normalize(rel).split(sep).includes("..")) {
      return c.json({ error: "invalid artifact path" }, 400);
    }

    // Resolve symlinks before validating containment — a lexical
    // resolve()+startsWith() check alone would let a symlink *inside* the dir
    // point outside it. realpath the base too: tmpdir() can itself be a
    // symlink (e.g. macOS /tmp → /private/tmp). A non-existent path throws.
    let realBase: string;
    try {
      realBase = realpathSync(baseDir);
    } catch {
      return c.json({ error: `no live artifacts for run '${runId}'` }, 410);
    }
    let realPath: string;
    try {
      realPath = realpathSync(resolve(baseDir, rel));
    } catch {
      return c.json({ error: `artifact not found: ${rel}` }, 404);
    }
    if (realPath !== realBase && !realPath.startsWith(`${realBase}${sep}`)) {
      return c.json({ error: "invalid artifact path" }, 400);
    }

    // Read through a single no-follow fd so the type/size check and the read
    // act on the same inode we validated — not a path re-resolved per call,
    // which a concurrent symlink swap could race. O_NOFOLLOW also rejects a
    // final-component symlink planted after the realpath check. It is
    // POSIX-only (undefined on Windows, where symlink creation requires
    // elevation and the realpath containment check above still holds).
    let fd: number;
    try {
      fd = openSync(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return c.json({ error: `artifact not found: ${rel}` }, 404);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return c.json({ error: `not a file: ${rel}` }, 400);
      if (stat.size > 1_000_000) return c.json({ error: "artifact too large" }, 400);
      // Enforce the text-only contract: reject NUL bytes and any payload that
      // doesn't round-trip as UTF-8 (a lossy decode swaps invalid bytes for
      // U+FFFD, changing the byte length) rather than serving a mangled binary.
      const bytes = readFileSync(fd);
      const content = bytes.toString("utf8");
      if (bytes.includes(0) || Buffer.byteLength(content, "utf8") !== bytes.length) {
        return c.json({ error: `artifact is not UTF-8 text: ${rel}` }, 400);
      }
      return c.json(getRunArtifactResponseSchema.parse({ path: rel, content }));
    } finally {
      closeSync(fd);
    }
  });

  // Cancellation (default) or purge (?purge=1). Cancel: triggers the
  // AbortController; the executor's run_done branch writes 'cancelled' to
  // SQLite via the normal onEvent path. Purge: cancel-if-active, await
  // terminal write, then hard-delete the run row + linked conversation —
  // FK CASCADE drops node outputs.
  app.delete("/api/workflows/runs/:runId", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const runId = c.req.param("runId");
    const purge = c.req.query("purge") === "1";

    if (purge) {
      const existed = await purgeAndCascade(runId);
      if (!existed) {
        return c.json({ error: `unknown run '${runId}'` }, 404);
      }
      return c.json({ deleted: true });
    }

    const entry = activeRuns.get(runId);
    if (!entry) {
      // Either never existed or already terminal — both surface the same way
      // so the client can treat 404 as "nothing to cancel" without polling
      // the store first.
      return c.json({ error: `unknown or completed run '${runId}'` }, 404);
    }
    cancelActiveRun(entry);
    return c.json({ cancelled: true });
  });

  // Resume a paused approval node. The body's `text` becomes the node's
  // $output (per the approval-handler's capture_response semantics), so the
  // downstream `when:` rules see whatever the user typed (or the canonical
  // "approve" from the quick-action button).
  app.post("/api/workflows/runs/:runId/resume", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const runId = c.req.param("runId");
    // Early 404 before parsing the body — preserves the route's "unknown or
    // completed run" semantics even for a malformed body. The shared core
    // re-checks below (covering a terminate-mid-request race).
    if (!activeRuns.get(runId)) {
      return c.json({ error: `unknown or completed run '${runId}'` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = resumeWorkflowRunBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const result = resolveApprovalCore({ activeRuns, store }, runId, parsed.data);
    if (!result.ok) {
      return c.json({ error: result.message }, result.reason === "not_found" ? 404 : 409);
    }
    return c.json({ resumed: true });
  });

  // Resume an interrupted (terminal) workflow run from the last completed node.
  // This is a node-less route that re-enters a failed/cancelled run without
  // requiring user approval.
  app.post("/api/workflows/runs/:runId/resume-run", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const runId = c.req.param("runId");
    // Reject if the run is already active (409).
    if (activeRuns.get(runId)) {
      return c.json({ error: `run is already active or not in a resumable state '${runId}'` }, 409);
    }
    const result = resumeRunCore(
      {
        store,
        activeRuns,
        subscribers,
        promptHandler: effectivePromptHandler,
        memoryTools,
        ...(snapshotManager !== undefined ? { snapshotManager } : {}),
        ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
        ...(usageStore !== undefined ? { usageStore } : {}),
        ...(projectsStore !== undefined ? { projectsStore } : {}),
        ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
        ...(workspaceManager !== undefined ? { workspaceManager } : {}),
        ...(mutationLockManager !== undefined ? { mutationLockManager } : {}),
        catalog,
      },
      runId,
    );
    if (!result.ok) {
      const statusCode = result.reason === "not_found" ? 404 : 409;
      return c.json({ error: result.message }, statusCode);
    }
    return c.json({ resumed: true, runId });
  });
}

// Per-run WS upgrade. Mirrors handleChatUpgrade. Origin-gated so a malicious
// page can't open a socket and read another user's run output. The runId is
// not validated against the store here — a client that opens a WS for a
// completed run will simply receive no frames (and can fall back to GET).
export function handleWorkflowRunUpgrade(
  req: Request,
  server: Server<WsData>,
  runId: string,
): Response | undefined {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const data: WsData = {
    abort: new AbortController(),
    kind: "workflowRun",
    runId,
  };
  const ok = server.upgrade(req, { data });
  if (ok) return undefined;
  return new Response("expected websocket", { status: 426 });
}

export function workflowRunWebSocketHandlers(deps: {
  subscribers: WorkflowSubscribers;
  store: WorkflowStore;
  // Optional so existing call sites that don't track in-flight runs (early
  // wiring, isolated tests) still work; production wires it from the
  // composition root. When present, the open handler replays the live
  // `approval_awaiting` frames so a reconnecting client gets the current
  // pauseId — which the persisted snapshot row alone cannot carry, since
  // the token only lives in memory.
  activeRuns?: ActiveRuns;
}): WebSocketHandler<WsData> {
  const { subscribers, store, activeRuns } = deps;

  function sendTerminal(ws: ServerWebSocket<WsData>, status: WorkflowRunStatus): void {
    const frame: WorkflowFrame = { type: "run_done", status };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // socket may have closed mid-send; nothing to do
    }
    try {
      ws.close(1000, "run complete");
    } catch {
      // already closed
    }
  }

  return {
    open(ws) {
      const runId = ws.data.runId;
      if (!runId) return;
      // Reconcile against the persisted store FIRST. The executor writes the
      // terminal status before the finally block clears activeRuns or the
      // subscriber set, so the store is the authoritative signal for whether
      // the client missed the run_done broadcast. This closes the
      // POST-then-subscribe gap: a fast run can complete entirely between
      // the POST response and the client's WS upgrade, and without this the
      // client would sit idle waiting for frames that already fired.
      const run = store.getRun(runId);
      if (!run) {
        try {
          ws.close(1008, "unknown run");
        } catch {
          // already closed
        }
        return;
      }
      // `paused` is a non-terminal state too. The run is still in flight,
      // waiting on POST /resume; a late subscriber needs the WS open so the
      // resumed node's `node_done` reaches them. Snapshot rehydration paints
      // the awaiting message from `getWorkflowRun`, but the pauseId only
      // lives in memory — replay live pending pauses below so a reconnecting
      // client gets the current token (otherwise a submit with the prior
      // iteration's pauseId hits 409).
      if (run.status !== "running" && run.status !== "paused") {
        sendTerminal(ws, run.status);
        return;
      }
      subscribers.subscribe(runId, ws);
      // Replay any currently-open pauses so the reconnecting client has the
      // live pauseId + the freshest gate message. Send DIRECTLY to this ws
      // rather than via broadcast — other subscribers already received the
      // frame at pause-open time and don't need a redundant copy.
      if (activeRuns) {
        const entry = activeRuns.get(runId);
        if (entry) {
          for (const pending of entry.pendingApprovals.values()) {
            const frame: WorkflowFrame = {
              type: "approval_awaiting",
              nodeId: pending.nodeId,
              message: pending.message,
              pauseId: pending.pauseId,
            };
            try {
              ws.send(JSON.stringify(frame));
            } catch {
              // socket may have closed mid-send; nothing to do
            }
          }
        }
      }
      // Narrow re-check: the run could have terminated between the store
      // lookup above and the subscribe call. The store update fires before
      // activeRuns clearing (see executeRunInBackground's finally), so a
      // second read closes the remaining race.
      const after = store.getRun(runId);
      if (after && after.status !== "running" && after.status !== "paused") {
        sendTerminal(ws, after.status);
      }
    },
    // Clients are pure subscribers; ignore any inbound frames. A future
    // resume / replay protocol would parse here.
    message(_ws, _raw) {},
    close(ws) {
      const runId = ws.data.runId;
      if (!runId) return;
      subscribers.unsubscribe(runId, ws);
    },
  };
}

interface IsolationConfig {
  /** YAML-supplied branch template; undefined → default. */
  branchTemplate: string | undefined;
  /** YAML-supplied start-point; undefined → resolve from the repo. */
  base: string | undefined;
  /** Source repo root; worktrees land at `<projectRootPath>/.worktrees/<branch>/`. */
  projectRootPath: string;
}

interface ExecuteRunArgs {
  workflow: WorkflowDefinition;
  runId: string;
  inputs: Record<string, string>;
  cwd: string;
  store: WorkflowStore;
  abort: AbortController;
  activeRuns: ActiveRuns;
  subscribers: WorkflowSubscribers;
  promptHandler: NodeHandler;
  // Per-run pending approval map shared with the route's POST /resume and
  // DELETE handlers. The route owns the lifecycle; this function builds the
  // closures that populate / drain it as the executor pauses and resumes.
  pendingApprovals: Map<string, PendingApproval>;
  // null → run in place at `cwd`. Set → create a worktree from `cwd` before
  // the first node runs and prune on success (keep on failure for inspection).
  isolation: IsolationConfig | null;
  // Forwarded to runWorkflow so the executor's pre-run recall and post-run
  // writeback envelopes carry `scope.projectId`. Without this the memory
  // layer falls back to the unqualified project scope and rows bleed across
  // targets.
  projectId?: string;
  // Undefined when no MemoryStore was wired; executor memory hooks no-op in that case.
  memoryTools?: MemoryTools;
  // Project-notebook handle, pre-bound + gated to a project the working dir sits
  // inside. Undefined → prompt nodes inject nothing and the `notebook:` hook no-ops.
  notebook?: NotebookAdapter;
  // Snapshot bridge: when set, the run republishes its latest
  // structured node output under the `workflow:run:<id>` snapshot key.
  snapshotManager?: SnapshotManager;
  // Rib-contributed workflow bindings by name; a bound run also fans its
  // structured output to the rib's namespaced key.
  ribWorkflowBindings?: Map<WorkflowDefinition, RibWorkflowBinding>;
  // Pre-completed node outputs to seed the executor on re-entry. When set,
  // existing worktree path should also be set for consistency.
  completedNodeOutputs?: ReadonlyMap<string, NodeOutput>;
  // Existing worktree path for re-entry: skip createWorktree and run in place
  // at this path. When set, the worktree is cleaned up only on success.
  existingWorktreePath?: string;
  // Optional usage ledger. When set, each node_done carrying real usage records
  // a `workflow`-sourced event; undefined → capture is skipped.
  usageStore?: UsageStore;
  workspaceManager?: WorkspaceManager;
  // Mutation lock to acquire before an isolation-requested run continues in
  // place (repo probe/worktree creation fallback), so fallback never mutates
  // the live checkout unlocked.
  isolationFallbackLock?: {
    manager: MutationLockManager;
    projectId: string;
    purpose: string;
    owner: string;
  };
}

// Process-wide slot pool, lazily built so KEELSON_MAX_CONCURRENT_RUNS is read
// after env setup. Only heavyweight (worktree-isolated / resumed-into-worktree)
// runs pass through it; lightweight in-place runs (rib collectors, refreshes)
// stay ungated so they never queue behind a long isolated run.
let runSlotsSingleton: RunSlots | null = null;
function runSlots(): RunSlots {
  if (runSlotsSingleton === null) {
    runSlotsSingleton = createRunSlots(resolveMaxConcurrentRuns());
  }
  return runSlotsSingleton;
}

async function executeRunInBackground(args: ExecuteRunArgs): Promise<void> {
  const heavy = args.isolation !== null || args.existingWorktreePath !== undefined;
  if (!heavy) {
    await runWorkflowExecution(args);
    return;
  }
  const { abort, runId, store, subscribers, activeRuns } = args;
  const slots = runSlots();
  // Skip the queue warning for an already-cancelled run: acquire() returns
  // immediately below and it's marked cancelled without ever queueing.
  if (!abort.signal.aborted && slots.active >= slots.limit) {
    subscribers.broadcast(runId, {
      type: "run_warning",
      nodeId: null,
      message: `waiting for a run slot (${slots.waiting + 1} queued; ${slots.limit} runs concurrently)`,
    });
  }
  const release = await slots.acquire(abort.signal);
  try {
    if (abort.signal.aborted) {
      // Cancelled while queued — never entered the executor, so close the row
      // out here (the executor's own run_done path never fires).
      store.updateRunStatus({
        runId,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: null,
      });
      subscribers.broadcast(runId, { type: "run_done", status: "cancelled" });
      activeRuns.delete(runId);
      subscribers.closeRun(runId);
      return;
    }
    await runWorkflowExecution(args);
  } finally {
    release();
  }
}

async function runWorkflowExecution(args: ExecuteRunArgs): Promise<void> {
  const {
    workflow,
    runId,
    inputs,
    cwd,
    store,
    abort,
    activeRuns,
    subscribers,
    promptHandler,
    pendingApprovals,
    isolation,
    projectId,
    memoryTools,
    notebook,
    snapshotManager,
    ribWorkflowBindings,
    completedNodeOutputs,
    existingWorktreePath,
    usageStore,
    workspaceManager,
    isolationFallbackLock,
  } = args;
  // Worktree lifecycle: create before the executor sees its first node, run
  // against the worktree path, prune on success — but keep on failure so the
  // operator can `cd` in and inspect. When the target isn't a git repo we
  // warn-and-fall-back to running in place rather than failing the run; the
  // workflow author may have isolation as a "best effort" preference for a
  // shared workspace they don't always run in.
  let effectiveCwd = cwd;
  let worktreePathForCleanup: string | null = null;
  let cleanupOnSuccessOnly = false;
  // Latches the run's terminal status as observed in the executor's run_done
  // dispatch (or in the catch block for pre-start failures). The finally uses
  // this instead of re-reading from SQLite — test teardown can delete the DB
  // file between the executor returning and our cleanup running.
  let terminalStatus: WorkflowRunStatus | null = null;
  let lockOnInPlaceIsolationFallback = false;
  let isolationFallbackLockHandle: MutationLockHandle | undefined;
  // The run_done event is captured here rather than dispatched immediately so
  // the finally block can persist/broadcast it AFTER artifacts.cleanup() runs
  // — otherwise a client polling status can observe "succeeded" while the run's
  // artifacts dir still exists on disk (a race that Windows' slower recursive
  // directory removal turns into a reliable CI failure).
  let pendingRunDoneEvent: Extract<RunStreamEvent, { type: "run_done" }> | undefined;
  let runDoneCompletedAt: string | undefined;
  const prepareDeps = async (worktreePath: string) => {
    if (workspaceManager !== undefined) {
      return workspaceManager.prepareDeps({
        worktreePath,
        abortSignal: abort.signal,
      });
    }
    return ensureWorktreeDeps({
      worktreePath,
      abortSignal: abort.signal,
    });
  };
  const prepareWorktree = async (opts: {
    repoPath: string;
    branch: string;
    dest: string;
    base: string | null;
    onCreated?: (worktreePath: string) => void;
  }) => {
    if (workspaceManager !== undefined) {
      return workspaceManager.prepareWorktree({
        repoPath: opts.repoPath,
        branch: opts.branch,
        dest: opts.dest,
        ...(opts.base !== null ? { base: opts.base } : {}),
        ...(opts.onCreated !== undefined ? { onCreated: opts.onCreated } : {}),
        abortSignal: abort.signal,
      });
    }
    const created = await createWorktree({
      repoPath: opts.repoPath,
      branch: opts.branch,
      dest: opts.dest,
      ...(opts.base !== null ? { base: opts.base } : {}),
    });
    opts.onCreated?.(created.worktreePath);
    const deps = await ensureWorktreeDeps({
      worktreePath: created.worktreePath,
      abortSignal: abort.signal,
    });
    return {
      worktreePath: created.worktreePath,
      adopted: created.adopted,
      branchCreated: created.branchCreated,
      deps,
      depsError: deps.error,
    };
  };
  const removePreparedWorktree = (dest: string) => {
    if (workspaceManager !== undefined) {
      return workspaceManager.removeWorktree({
        repoPath: cwd,
        dest,
        force: true,
      });
    }
    return removeWorktree({
      repoPath: cwd,
      dest,
      force: true,
    });
  };
  if (existingWorktreePath !== undefined) {
    effectiveCwd = existingWorktreePath;
    worktreePathForCleanup = existingWorktreePath;
    cleanupOnSuccessOnly = true;
    const deps = await prepareDeps(existingWorktreePath);
    if (deps.error !== null) {
      subscribers.broadcast(runId, {
        type: "run_warning",
        nodeId: null,
        message: `worktree dependency install failed; continuing: ${deps.error}`,
      });
    }
  } else if (isolation !== null) {
    let isRepo = false;
    let probeError: string | null = null;
    try {
      isRepo = await isGitRepo(cwd);
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
    if (!isRepo) {
      lockOnInPlaceIsolationFallback = true;
      subscribers.broadcast(runId, {
        type: "run_warning",
        nodeId: null,
        message:
          probeError !== null
            ? `worktree isolation probe failed; running in place: ${probeError}`
            : `worktree isolation requested but ${cwd} is not a git repo; running in place`,
      });
    } else {
      const branch = resolveBranchTemplate(isolation.branchTemplate, {
        workflow: workflow.name,
        runId,
      });
      const dest = worktreePathForRepoLocal({
        projectRootPath: isolation.projectRootPath,
        branch,
      });
      const base = isolation.base ?? (await resolveDefaultBranch(cwd));
      try {
        if (base !== null) {
          try {
            store.setRunWorktreeBase(runId, base);
          } catch (err) {
            console.warn(
              `[workflows] failed to persist worktree base for ${runId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (await headDivergesFrom(cwd, base)) {
            subscribers.broadcast(runId, {
              type: "run_warning",
              nodeId: null,
              message: `current HEAD is not contained in ${base}; creating isolated worktree branch from ${base}`,
            });
          }
        }
        const created = await prepareWorktree({
          repoPath: cwd,
          branch,
          dest,
          base,
          // Persist before the slow dependency install so a crash mid-install
          // leaves a resumable run pointing at its (registered) worktree.
          onCreated: (worktreePath) => {
            effectiveCwd = worktreePath;
            worktreePathForCleanup = worktreePath;
            cleanupOnSuccessOnly = true;
            try {
              store.setRunWorktreePath(runId, worktreePath);
            } catch (err) {
              console.warn(
                `[workflows] failed to persist worktree path for ${runId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          },
        });
        effectiveCwd = created.worktreePath;
        if (created.depsError !== null) {
          subscribers.broadcast(runId, {
            type: "run_warning",
            nodeId: null,
            message: `worktree dependency install failed; continuing: ${created.depsError}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lockOnInPlaceIsolationFallback = true;
        subscribers.broadcast(runId, {
          type: "run_warning",
          nodeId: null,
          message: `worktree creation failed; running in place: ${message}`,
        });
      }
    }
  }

  // Per-node timestamps + content-parts accumulators. The executor emits
  // node_started / node_event / node_done as separate events; the persistence
  // layer needs both timestamps on the same row, and the contentParts column
  // needs the structured projection accumulated from the chunk stream.
  // Declared before awaitApproval so the closure's `nodeStart.get(nodeId)`
  // reference is a normal lexical capture, not a TDZ-dependent hoist.
  const nodeStart = new Map<string, string>();
  const nodeAccumulators = new Map<string, ReturnType<typeof createContentPartsAccumulator>>();

  // Pause-and-await callback for the approval handler. Writes the 'paused'
  // run status + 'awaiting' node row so a page-reload mid-pause rehydrates
  // the approval callout from the snapshot, broadcasts the approval_awaiting
  // WS frame for live clients, and returns a Promise the route's POST /resume
  // (or DELETE / abortAll) settles.
  const awaitApproval: AwaitApproval = (nodeRunId, nodeId, message, signal) =>
    new Promise<string>((resolve, reject) => {
      const pauseId = crypto.randomUUID();
      const settle = {
        resolve: (text: string) => {
          cleanup();
          // Drop the awaiting row at resolve time — symmetric with
          // awaitInteraction. The subsequent `node_done` write recreates
          // the row with the terminal status. Without this, a fresh
          // hydrate triggered by `approval_resolved` could land in the
          // brief window before node_done and pull the stale `awaiting`
          // row back into the SPA via mergeNode's snapshot-awaiting-wins
          // rule.
          try {
            store.deleteNodeOutput(nodeRunId, nodeId);
          } catch (err) {
            console.warn(
              `[workflows] failed to clear awaiting row for ${nodeRunId}:${nodeId} after approval resume: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          // Tell live clients the pause cleared. Approval nodes also emit
          // `node_done` immediately after the handler returns, but live
          // clients depend on this frame to clear the composer between
          // settle and the executor's next write — the gap is short for
          // approval, long for interactive-loop iterations.
          subscribers.broadcast(nodeRunId, { type: "approval_resolved", nodeId });
          resolve(text);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => {
        // The route's DELETE / abortAll already drains pendingApprovals, so
        // by the time this fires the entry may already be gone. Defensive
        // reject() handles the race where the abort signal fires before
        // the route gets a chance to drain.
        settle.reject(new Error("aborted"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        pendingApprovals.delete(nodeId);
      };
      if (signal.aborted) {
        // Race: aborted before we registered. Resolve via the same path so
        // the handler observes consistent rejection semantics.
        reject(new Error("aborted"));
        return;
      }
      pendingApprovals.set(nodeId, {
        nodeId,
        pauseId,
        message,
        resolve: settle.resolve,
        reject: settle.reject,
      });
      signal.addEventListener("abort", onAbort);

      try {
        store.updateRunStatus({
          runId: nodeRunId,
          status: "paused",
          completedAt: null,
          error: null,
        });
        store.upsertNodeOutput({
          runId: nodeRunId,
          nodeId,
          status: "awaiting",
          outputText: message,
          contentParts: null,
          startedAt: nodeStart.get(nodeId) ?? new Date().toISOString(),
          completedAt: null,
          error: null,
          usage: null,
          // The terminal node_done write recreates the row with the resolved
          // provider/model; the transient awaiting snapshot carries neither.
          provider: null,
          model: null,
        });
      } catch (err) {
        console.warn(
          `[workflows] failed to persist paused state for ${nodeRunId}:${nodeId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      subscribers.broadcast(nodeRunId, {
        type: "approval_awaiting",
        nodeId,
        message,
        pauseId,
      });
    });

  // Interactive-loop sibling of awaitApproval. Shares the pendingApprovals
  // map (keyed by nodeId) so the existing POST /resume + DELETE abort drain
  // paths handle both pause types without branching. The only persisted
  // difference is the node's `outputText` (gate message) at the iteration
  // boundary; the SPA renders the pause through the same approval_awaiting
  // frame.
  //
  // Unlike approval, the loop handler does NOT return after resume — it
  // continues into the next iteration. So on settle.resolve we MUST flip
  // the node row from 'awaiting' back to 'running' (preserving the
  // original startedAt) before unblocking the executor. Otherwise a client
  // that reloads or reconnects mid-iteration-N+1 would hydrate a paused
  // callout for a node with no pending resolver, and POST /resume would
  // return 409.
  const awaitInteraction: AwaitInteraction = (
    nodeRunId,
    nodeId,
    message,
    _iteration,
    _sessionId,
    signal,
  ) =>
    new Promise<string>((resolve, reject) => {
      const pauseId = crypto.randomUUID();
      const settle = {
        resolve: (text: string) => {
          cleanup();
          // Drop the awaiting snapshot so a reload during the next iteration
          // doesn't rehydrate a stale pause callout. The node row will be
          // re-created at terminal (succeeded/failed/skipped) by the
          // executor's normal node_done write path; there is no "running"
          // status in workflowNodeStatusSchema, so "no row" is the correct
          // pre-terminal representation. Best-effort: a SQLite failure here
          // mustn't block the executor from receiving the user's reply.
          try {
            store.deleteNodeOutput(nodeRunId, nodeId);
          } catch (err) {
            console.warn(
              `[workflows] failed to clear awaiting row for ${nodeRunId}:${nodeId} after resume: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          // Tell live clients the pause cleared. Without this frame, an
          // open RunView keeps the composer active for the entire next
          // iteration (could be minutes) and retries 409.
          subscribers.broadcast(nodeRunId, { type: "approval_resolved", nodeId });
          resolve(text);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => {
        settle.reject(new Error("aborted"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        pendingApprovals.delete(nodeId);
      };
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      pendingApprovals.set(nodeId, {
        nodeId,
        pauseId,
        message,
        resolve: settle.resolve,
        reject: settle.reject,
      });
      signal.addEventListener("abort", onAbort);

      try {
        store.updateRunStatus({
          runId: nodeRunId,
          status: "paused",
          completedAt: null,
          error: null,
        });
        // Preserve the iteration's streamed prompt output on the awaiting
        // row — a reload mid-pause needs to surface what the agent said so
        // the user has context to respond. Approval nodes don't stream
        // content of their own so the accumulator is typically empty
        // there, but the loop handler's synthesized prompt iterations
        // emit through the SAME parent-node id (the iteration suffix is
        // an internal handle), so the loop node's accumulator is what's
        // populated by the time the pause opens.
        const acc = nodeAccumulators.get(nodeId);
        const parts: ContentBlock[] | null = acc && acc.parts().length > 0 ? acc.parts() : null;
        store.upsertNodeOutput({
          runId: nodeRunId,
          nodeId,
          status: "awaiting",
          outputText: message,
          contentParts: parts,
          startedAt: nodeStart.get(nodeId) ?? new Date().toISOString(),
          completedAt: null,
          error: null,
          usage: null,
          // The loop node's terminal node_done write carries the resolved
          // provider/model; the per-iteration awaiting snapshot carries neither.
          provider: null,
          model: null,
        });
      } catch (err) {
        console.warn(
          `[workflows] failed to persist interactive-loop paused state for ${nodeRunId}:${nodeId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      subscribers.broadcast(nodeRunId, {
        type: "approval_awaiting",
        nodeId,
        message,
        pauseId,
      });
    });

  // Cancel-node side effect. The handler returns `failed` for the cancel
  // node itself; this callback writes 'cancelled' onto the run row and
  // trips the AbortController so downstream layers skip.
  const requestCancel: RequestCancel = async (cancelRunId, reason) => {
    try {
      store.updateRunStatus({
        runId: cancelRunId,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: reason ? `cancelled: ${reason}` : "cancelled",
      });
    } catch (err) {
      console.warn(
        `[workflows] failed to persist cancelled state for ${cancelRunId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    abort.abort();
  };

  const handlers = new Map<string, NodeHandler>([
    ["bash", bashHandler],
    ["prompt", promptHandler],
    ["approval", makeApprovalHandler({ awaitApproval })],
    ["cancel", makeCancelHandler({ requestCancel })],
    ["command", makeCommandHandler({ promptHandler })],
    [
      "loop",
      makeLoopHandler({
        promptHandler,
        awaitInteraction,
        runUntilBashProbe: defaultRunUntilBashProbe,
      }),
    ],
    ["script", makeScriptHandler()],
  ]);

  const artifacts = await RunArtifactsDir.create(runId);
  const artifactsDir = artifacts.runWorkflowOptions().artifactsDir;
  if (artifactsDir !== undefined) {
    // The entry is registered (POST handler) before this awaited create runs,
    // so it's present; the field clears when activeRuns.delete fires below.
    const entry = activeRuns.get(runId);
    if (entry) entry.artifactsDir = artifactsDir;
  }

  // Snapshot bridge: expose this run's latest structured node
  // output under a run-scoped key so a snapshot-backed canvas renders it live.
  // The substrate stays domain-free — `data` is the structured value verbatim.
  // No per-key schema validation or redaction here: the producer is a trusted
  // in-tree workflow and the snapshot WS is loopback-origin-gated.
  let unregisterSnapshot: (() => void) | undefined;
  let publishStructured: ((value: unknown) => void) | undefined;
  // The most recent recompose, awaited before unregister so the final frame
  // finishes composing/broadcasting before the key (and its WS subscribers) are
  // dropped — otherwise a fast terminal run races the fire-and-forget publish.
  let lastRecompose: Promise<unknown> = Promise.resolve();
  if (snapshotManager !== undefined) {
    const snapshotKey = `workflow:run:${runId}`;
    let latestStructured: unknown;
    unregisterSnapshot = snapshotManager.register(snapshotKey, () => latestStructured);
    publishStructured = (value: unknown): void => {
      latestStructured = value;
      lastRecompose = snapshotManager.recompose(snapshotKey).catch(() => undefined);
    };
  }
  // When this run's workflow is bound to a rib-owned key, fan the same
  // structured output to it. Bindings are keyed by the definition *object*, and
  // `workflow` here is the object the catalog resolved for this run at start
  // (`catalog.get(name)` in both run entry points). So a project file that
  // shadows the name — even one added after boot, since the catalog hot-reloads
  // and returns the project's object — resolves to a different object and finds
  // no binding; the rib's key is only ever driven by the rib's own definition.
  // That key was registered at activation and persists past the run, so it's
  // never unregistered here — only the run-scoped key is. `publish` recomposes
  // (fail-closed) internally.
  const ribBinding = ribWorkflowBindings?.get(workflow);
  const publishRun: ((value: unknown) => void) | undefined =
    ribBinding !== undefined
      ? (value) => {
          publishStructured?.(value);
          ribBinding.publish(value);
        }
      : publishStructured;

  try {
    if (lockOnInPlaceIsolationFallback && isolationFallbackLock !== undefined) {
      isolationFallbackLockHandle = isolationFallbackLock.manager.acquire({
        projectId: isolationFallbackLock.projectId,
        purpose: isolationFallbackLock.purpose,
        owner: isolationFallbackLock.owner,
      });
    }
    await runWorkflow({
      workflow,
      runId,
      inputs,
      handlers,
      cwd: effectiveCwd,
      abortSignal: abort.signal,
      ...artifacts.runWorkflowOptions(),
      ...(memoryTools !== undefined ? { memoryTools } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(notebook !== undefined ? { notebook } : {}),
      ...(completedNodeOutputs !== undefined ? { completedNodeOutputs } : {}),
      onEvent: (event) => {
        if (event.type === "run_done") {
          terminalStatus = event.status;
          runDoneCompletedAt = new Date().toISOString();
          pendingRunDoneEvent = event;
          return;
        }
        dispatchRunEvent({
          event,
          runId,
          store,
          subscribers,
          nodeStart,
          nodeAccumulators,
          workflowName: workflow.name,
          ...(publishRun !== undefined ? { publishStructured: publishRun } : {}),
          ...(usageStore !== undefined ? { usageStore } : {}),
        });
      },
    });
  } catch (err) {
    // Executor throws before run_started (e.g. ExecutorValidationError) — the
    // onEvent run_done branch never fires, so close the row out here.
    const msg = err instanceof Error ? err.message : String(err);
    store.updateRunStatus({
      runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    terminalStatus = "failed" as WorkflowRunStatus;
    subscribers.broadcast(runId, { type: "run_done", status: "failed" });
  } finally {
    if (isolationFallbackLockHandle !== undefined) {
      releaseMutationLockNow(runId, isolationFallbackLockHandle);
      isolationFallbackLockHandle = undefined;
    }
    // Worktree cleanup before activeRuns.delete so the shutdown drain awaits
    // it via `entry.done`. Only on a clean terminal status — failed /
    // cancelled runs leave the worktree behind for inspection. `keelson
    // worktree prune` is the operator's escape hatch.
    if (worktreePathForCleanup !== null && cleanupOnSuccessOnly && terminalStatus === "succeeded") {
      // Force-remove on success: a successful run may have produced
      // intentional untracked files (e.g. an `architect` PR-creation node
      // that committed elsewhere) or left bash scratch in the working tree.
      // The worktree is ephemeral; if the author wanted the changes they
      // should have committed-and-pushed.
      const out = await removePreparedWorktree(worktreePathForCleanup);
      if (out.warning !== null) {
        console.warn(`[workflows] worktree cleanup for ${runId} warned: ${out.warning}`);
      }
      if (out.removed) {
        try {
          store.setRunWorktreePath(runId, null);
        } catch {
          // Best-effort; non-fatal.
        }
      }
    }
    // Failed / cancelled runs keep their artifacts dir: those are the resumable
    // states, and a resumed execution re-enters the same deterministic path —
    // same policy as the worktree retention above.
    if (terminalStatus !== "failed" && terminalStatus !== "cancelled") {
      await artifacts.cleanup();
    }
    // Persist/broadcast the terminal status now that cleanup has finished, so
    // a client can never observe "succeeded" while the artifacts dir (or a
    // success-cleaned worktree) is still on disk. Best-effort like the
    // cleanup steps above: a caller that never awaits `entry.done` (or a test
    // harness that force-closes db handles between runs) can race this write
    // against teardown; swallow rather than reject the whole run promise.
    if (pendingRunDoneEvent) {
      try {
        dispatchRunEvent({
          event: pendingRunDoneEvent,
          runId,
          store,
          subscribers,
          nodeStart,
          nodeAccumulators,
          workflowName: workflow.name,
          ...(runDoneCompletedAt !== undefined ? { completedAt: runDoneCompletedAt } : {}),
          ...(publishRun !== undefined ? { publishStructured: publishRun } : {}),
          ...(usageStore !== undefined ? { usageStore } : {}),
        });
      } catch (err) {
        console.warn(
          `[workflows] failed to persist terminal status for ${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    activeRuns.delete(runId);
    // Close any lingering WS subscribers — the run will emit no further frames.
    subscribers.closeRun(runId);
    // Let the final structured frame finish composing/broadcasting, then drop
    // the run-scoped snapshot key (also closes its WS subscribers).
    await lastRecompose;
    unregisterSnapshot?.();
  }
}

// Re-validate a provider/model id from a node result at the trust boundary,
// mirroring the usage coerce above: the in-tree prompt handler sets clean
// strings, but an embedder-supplied handler could set a non-string or oversized
// value that would fail the SPA's strict node_done frame parse and silently drop
// the whole frame. Returns null (persist/emit nothing) for anything but a
// non-empty string, and caps length so a pathological value can't bloat the row.
const MAX_PROVENANCE_FIELD_LEN = 200;
function sanitizeProvenanceField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_PROVENANCE_FIELD_LEN
    ? trimmed.slice(0, MAX_PROVENANCE_FIELD_LEN)
    : trimmed;
}

interface NodeUsageAttribution {
  runId: string;
  nodeId: string;
  workflowName: string;
  conversationId: string | null;
  projectId: string | null;
  ribId: string | null;
}

function recordNodeUsage(args: {
  usageStore?: UsageStore;
  usage: NonNullable<ReturnType<typeof coerceTokenUsage>>;
  provider: string;
  model: string;
  status: WorkflowNodeStatus;
  startedAt: string | null;
  completedAt: string;
  attribution: NodeUsageAttribution;
}): void {
  const { usageStore, usage, provider, model, status, startedAt, completedAt, attribution } = args;
  const durationMs = startedAt !== null ? Date.parse(completedAt) - Date.parse(startedAt) : null;
  usageStore?.record({
    source: "workflow",
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cacheWriteTokens: usage.cacheCreationInputTokens }
      : {}),
    ...(durationMs !== null && Number.isFinite(durationMs) ? { durationMs } : {}),
    // Node statuses fold onto the ledger's turn vocabulary so one query
    // never meets two spellings ('succeeded' vs 'ok') of the same state.
    status: status === "succeeded" ? "ok" : status === "failed" ? "error" : status,
    ...attribution,
  });
}

interface DispatchArgs {
  event: RunStreamEvent;
  runId: string;
  store: WorkflowStore;
  subscribers: WorkflowSubscribers;
  nodeStart: Map<string, string>;
  nodeAccumulators: Map<string, ReturnType<typeof createContentPartsAccumulator>>;
  // Snapshot bridge: when set, a node's structured output is
  // republished under the run-scoped snapshot key. Undefined → no publish.
  publishStructured?: (value: unknown) => void;
  // Owning workflow's name, stamped onto each recorded usage event.
  workflowName: string;
  // Optional usage ledger. When set, a node_done carrying real usage records a
  // `workflow`-sourced event; undefined → capture is skipped.
  usageStore?: UsageStore;
  // Timestamp to persist for a deferred run_done dispatch, captured when the
  // executor actually finished (before any post-completion cleanup ran) so
  // `completedAt` reflects real runtime rather than dispatch time.
  completedAt?: string;
}

function dispatchRunEvent(args: DispatchArgs): void {
  const {
    event,
    runId,
    store,
    subscribers,
    nodeStart,
    nodeAccumulators,
    publishStructured,
    workflowName,
    usageStore,
    completedAt: completedAtOverride,
  } = args;
  switch (event.type) {
    case "run_started":
      subscribers.broadcast(runId, {
        type: "run_started",
        runId: event.runId,
        workflowName: event.workflowName,
      });
      break;
    case "node_started":
      nodeStart.set(event.nodeId, new Date().toISOString());
      nodeAccumulators.set(event.nodeId, createContentPartsAccumulator());
      subscribers.broadcast(runId, {
        type: "node_started",
        nodeId: event.nodeId,
      });
      break;
    case "node_event": {
      // node_chunk events carry the provider's MessageChunk verbatim under
      // an unknown-typed boundary (executor.ts §NodeStreamEvent). Run them
      // through the content-parts accumulator AND fan them to WS subscribers
      // as workflowFrame.node_chunk for the UI. node_log lines from the bash
      // handler get their own frame type.
      const inner = event.event;
      if (inner.type === "node_chunk") {
        const chunk = inner.chunk as MessageChunk;
        const acc = nodeAccumulators.get(event.nodeId);
        if (acc) acc.ingest(chunk);
        subscribers.broadcast(runId, {
          type: "node_chunk",
          nodeId: event.nodeId,
          chunk,
        });
      } else if (inner.type === "node_log") {
        subscribers.broadcast(runId, {
          type: "node_log",
          nodeId: event.nodeId,
          line: inner.line,
        });
      }
      break;
    }
    case "node_done": {
      const startedAt = nodeStart.get(event.nodeId) ?? null;
      const completedAt = new Date().toISOString();
      const status: WorkflowNodeStatus = event.result.status;
      const outputText =
        event.result.output.kind === "text"
          ? event.result.output.text
          : JSON.stringify(event.result.output.value);
      const acc = nodeAccumulators.get(event.nodeId);
      const parts: ContentBlock[] | null = acc && acc.parts().length > 0 ? acc.parts() : null;
      // Re-coerce at the trust boundary rather than trusting the handler's
      // structural NodeTokenUsage: the prompt handler sanitizes its own
      // capture, but any embedder-supplied handler can set result.usage
      // directly, and a nonconforming value here would fail the SPA's strict
      // frame parse — silently dropping the whole node_done.
      const usage = coerceTokenUsage(event.result.usage) ?? null;
      const provider = sanitizeProvenanceField(event.result.provider);
      const model = sanitizeProvenanceField(event.result.model);
      store.upsertNodeOutput({
        runId,
        nodeId: event.nodeId,
        status,
        outputText,
        contentParts: parts,
        startedAt,
        completedAt,
        error: event.result.error ?? null,
        usage,
        provider,
        model,
      });
      subscribers.broadcast(runId, {
        type: "node_done",
        nodeId: event.nodeId,
        status,
        error: event.result.error ?? null,
        ...(usage !== null ? { usage } : {}),
        ...(provider !== null ? { provider } : {}),
        ...(model !== null ? { model } : {}),
      });
      // Snapshot bridge: a structured node output becomes the latest frame
      // on the run-scoped snapshot key.
      if (event.result.output.kind === "structured") {
        publishStructured?.(event.result.output.value);
      }
      // Usage ledger: only a node that both spent tokens and resolved a
      // provider/model can be attributed — an unattributed event (e.g. a
      // non-LLM node) would violate the ledger's NOT NULL provider/model
      // columns, so it's skipped rather than recorded with a placeholder.
      if (usage !== null && provider !== null && model !== null) {
        const run = store.getRun(runId);
        recordNodeUsage({
          usageStore,
          usage,
          provider,
          model,
          status,
          startedAt,
          completedAt,
          attribution: {
            runId,
            nodeId: event.nodeId,
            workflowName,
            conversationId: run?.conversationId ?? null,
            projectId: run?.projectId ?? null,
            ribId: run?.ribId ?? null,
          },
        });
      }
      // Free the per-node accumulator now that we've persisted it; keeps the
      // map bounded for long-running multi-node workflows.
      nodeAccumulators.delete(event.nodeId);
      break;
    }
    case "run_warning":
      subscribers.broadcast(runId, {
        type: "run_warning",
        nodeId: event.nodeId ?? null,
        message: event.message,
      });
      break;
    case "run_done": {
      const status: WorkflowRunStatus = event.status;
      let error: string | null = null;
      if (status === "failed") {
        const failures: string[] = [];
        for (const [nodeId, node] of Object.entries(event.summary.nodes)) {
          if (node.state === "failed") failures.push(`${nodeId}: ${node.error}`);
        }
        error = failures.length > 0 ? failures.join("; ") : "run failed";
      }
      store.updateRunStatus({
        runId,
        status,
        completedAt: completedAtOverride ?? new Date().toISOString(),
        error,
      });
      subscribers.broadcast(runId, { type: "run_done", status });
      break;
    }
  }
}

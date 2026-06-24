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
import { mkdtemp, rm } from "node:fs/promises";
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
  recallRequestSchema,
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
  removeWorktree,
  resolveBranchTemplate,
  runWorkflow,
  type WorkflowDefinition,
  worktreePathForRepoLocal,
} from "@keelson/workflows";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { z } from "zod";

import type { RibWorkflowBinding, WorkflowCatalog, WorkflowScopeContext } from "./bootstrap.ts";
import { createContentPartsAccumulator } from "./content-parts.ts";
import { isAllowedOrigin, type WsData } from "./server-context.ts";
import { resolveWorkflowName } from "./workflow-resolve.ts";

// CSRF defense for state-changing routes — reject cross-origin POSTs that
// the browser would otherwise send with the user's cookies.
function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

import type { ConversationStore } from "./conversation-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import { formatNotebookSection, type ProjectNotebookStore } from "./project-notebook-store.ts";
import { canonicalPath, isPathInside, type ProjectsStore } from "./projects-store.ts";
import type { WorkflowStore } from "./workflow-store.ts";

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
// break the run that triggered it.
const SCHEDULED_RUN_RETENTION = 5;
function pruneScheduledRuns(
  store: WorkflowStore,
  conversationStore: ConversationStore,
  workflowName: string,
): void {
  for (const { runId, conversationId } of store.scheduledRunsToPrune(
    workflowName,
    SCHEDULED_RUN_RETENTION,
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
  // client refresh both target (collector, REPO_ROOT, {}). See runDedupeKey.
  dedupeKey: string;
  conversationId: string;
}

export interface ActiveRuns {
  register(runId: string, entry: ActiveRunEntry): void;
  get(runId: string): ActiveRunEntry | undefined;
  // The live run matching `dedupeKey`, or undefined. Backs the run-start de-dup
  // so an identical (workflow, workingDir, inputs) can't run twice concurrently.
  findActive(dedupeKey: string): { runId: string; conversationId: string } | undefined;
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

  findActive(dedupeKey: string): { runId: string; conversationId: string } | undefined {
    for (const [runId, entry] of this.runs) {
      if (entry.dedupeKey === dedupeKey) {
        return { runId, conversationId: entry.conversationId };
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

  static async create(runId: string): Promise<RunArtifactsDir> {
    try {
      return new RunArtifactsDir(await mkdtemp(join(tmpdir(), `keelson-run-${runId}-`)));
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
  activeRuns: ActiveRuns;
  subscribers: WorkflowSubscribers;
  promptHandler: NodeHandler;
  memoryTools: MemoryTools | undefined;
  projectNotebookStore?: ProjectNotebookStore;
  snapshotManager?: SnapshotManager;
  ribWorkflowBindings?: Map<WorkflowDefinition, RibWorkflowBinding>;
}

interface StartRunCoreParams {
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
  workingDir: string;
  projectId: string | null;
  resolvedProject: Pick<Project, "id" | "rootPath"> | null;
  isolationOn: boolean;
  branchTemplate: string | undefined;
  // Trigger provenance for the run row. Omitted → 'manual'. The owning rib id
  // (null for local workflows) is stamped so the runs feed can badge/filter and
  // bulk-delete by rib even after the rib is removed.
  origin?: WorkflowRunOrigin;
  ribId?: string | null;
}

// Seed-map builder from persisted rows: maps terminal node rows to NodeOutput
// so the executor can re-enter from the first incomplete node. Only maps
// success-terminal rows (succeeded → completed, skipped → skipped); failed/awaiting
// rows are deliberately excluded so they re-run on resume.
function buildResumeSeed(nodes: NodeOutputRow[]): Map<string, NodeOutput> {
  const seed = new Map<string, NodeOutput>();
  for (const node of nodes) {
    if (node.status === "succeeded") {
      seed.set(node.nodeId, {
        state: "completed",
        output: node.outputText ?? "",
        ...(node.startedAt !== null ? { startedAt: node.startedAt } : {}),
        ...(node.completedAt !== null ? { completedAt: node.completedAt } : {}),
      });
    } else if (node.status === "skipped") {
      seed.set(node.nodeId, {
        state: "skipped",
        output: "",
      });
    }
  }
  return seed;
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
  const { snapshotManager, ribWorkflowBindings, projectNotebookStore } = deps;
  const { workflow, inputs, workingDir, projectId, resolvedProject, isolationOn, branchTemplate } =
    params;
  const origin: WorkflowRunOrigin = params.origin ?? "manual";
  const ribId = params.ribId ?? null;
  // Bind the notebook (read + contribute) only when the working dir actually
  // resolves inside the resolved project. A run started with a display-only
  // `projectId` + an overriding `workingDir` outside that project must NOT read
  // or write its notebook — that id is a UI pointer, not the run's context.
  const workingDirInProject =
    resolvedProject !== null && isPathInside(resolvedProject.rootPath, workingDir);
  let notebook: NotebookAdapter | undefined;
  if (projectNotebookStore && projectId !== null && workingDirInProject) {
    const nbStore = projectNotebookStore;
    const pid = projectId;
    notebook = {
      read: () => {
        const content = nbStore.get(pid)?.content;
        return content ? formatNotebookSection(content) : undefined;
      },
      append: (entry, section) => ({ ok: nbStore.appendEntry(pid, entry, section).ok }),
    };
  }
  const name = workflow.name;
  const dedupeKey = runDedupeKey(name, workingDir, inputs);
  // De-dup only non-isolated producer refreshes (rib collectors fired by the
  // heartbeat, /refresh, and client SWR): a concurrent start with an identical
  // (workflow, workingDir, inputs) already live returns that run, serializing
  // the cold-boot client-open vs server-tick race. Arbitrary /runs and chat
  // starts aren't collapsed, so their inputs are untouched. Isolated runs are
  // excluded because they linger in activeRuns through an awaited worktree
  // teardown after `run_done` — de-duping them could hand back a terminal run.
  // A non-isolated run is gone by `run_done` (prompt delete), so the live run
  // matched here is never terminal.
  if (ribWorkflowBindings?.has(workflow) && !isolationOn) {
    const existing = activeRuns.findActive(dedupeKey);
    if (existing) return existing;
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  // Create the conversation FIRST so the workflow_runs FK has a target.
  const conversation = conversationStore.create({
    providerId: "workflow",
    name: `${name} · ${runId.slice(0, 6)}`,
  });
  try {
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
    // Orphan rollback: the conversation row exists only to anchor a run, so
    // if createRun throws drop the empty conversation rather than leak it.
    try {
      conversationStore.delete(conversation.id);
    } catch (cleanupErr) {
      console.warn(
        `[workflows] orphan-rollback failed for conversation ${conversation.id}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
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
  });
  activeRuns.register(runId, {
    abort,
    done,
    pendingApprovals,
    dedupeKey,
    conversationId: conversation.id,
  });
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
      reason: "not_found" | "not_terminal";
      message: string;
    };

// Resume-run core: load a terminal run, validate it's terminal (not running/paused),
// build the seed from persisted node outputs, flip back to running, and re-enter
// the executor. Returns a discriminated result so the HTTP route maps it to
// appropriate status codes.
function resumeRunCore(
  deps: Omit<StartRunCoreDeps, "conversationStore"> & { catalog: WorkflowCatalog },
  runId: string,
): ResumeRunResult {
  const { store, activeRuns, subscribers, promptHandler, memoryTools } = deps;
  const { snapshotManager, ribWorkflowBindings, catalog } = deps;

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

  const completedNodeOutputs = buildResumeSeed(run.nodes);

  try {
    store.updateRunStatus({
      runId,
      status: "running",
      completedAt: null,
      error: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[workflows] failed to flip ${runId} back to running: ${msg}`);
    return {
      ok: false,
      reason: "not_terminal",
      message: `failed to resume run: ${msg}`,
    };
  }

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

  const abort = new AbortController();
  const pendingApprovals = new Map<string, PendingApproval>();
  const done = executeRunInBackground({
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
    completedNodeOutputs,
    existingWorktreePath: run.worktreePath ?? undefined,
  });

  activeRuns.register(runId, {
    abort,
    done,
    pendingApprovals,
    dedupeKey: runDedupeKey(workflow.name, run.workingDir, run.inputs),
    conversationId: run.conversationId,
  });

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
  awaitPauseOrTerminal(runId: string, opts?: AwaitPauseOrTerminalOptions): Promise<WatchResult>;
  listRuns(opts?: { status?: WorkflowRunStatus }): WorkflowRunSummary[];
  getRun(runId: string): WorkflowRunDetail | undefined;
  // Live pending approvals for a run, including the in-memory `pauseId` that the
  // persisted snapshot (getRun) cannot carry. Empty for a run with no live
  // resolver (terminal, unknown, or paused-but-reconciled after restart).
  pendingApprovals(runId: string): Array<{ nodeId: string; pauseId: string; message: string }>;
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
  const { catalog, store, conversationStore, projectsStore, snapshotManager, ribWorkflowBindings } =
    opts;
  const { promptHandler, memoryTools, projectNotebookStore } = buildExecutionDeps(opts);

  return {
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
            activeRuns,
            subscribers,
            promptHandler,
            memoryTools,
            ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
            ...(snapshotManager !== undefined ? { snapshotManager } : {}),
            ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
          },
          {
            workflow,
            inputs,
            workingDir,
            projectId,
            resolvedProject,
            isolationOn,
            branchTemplate: workflow.worktree?.branch,
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
          activeRuns,
          subscribers,
          promptHandler: effectivePromptHandler,
          memoryTools,
          ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
          ...(snapshotManager !== undefined ? { snapshotManager } : {}),
          ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
        },
        {
          workflow,
          inputs: parsed.data.inputs,
          workingDir,
          projectId,
          resolvedProject,
          isolationOn,
          branchTemplate,
          origin: "manual",
          ribId: ribIdFor(catalog, workflow.name, scope),
        },
      );
      // Echo the canonical name so a fuzzy start (smoketst → smoke-test) hands
      // the client the real name for run-detail / "open in Workflows" routes.
      return c.json({ runId, workflowName: workflow.name });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Re-run a rib producer workflow to repopulate its bound snapshot key — the
  // "refresh" behind a surface panel's icon. Restricted to bound producers and
  // run in the server's default working dir: a general workflow must still go
  // through /runs with an explicit target (so it can't silently execute against
  // the server's install dir), but a producer's node uses absolute paths, so the
  // server owns the nominal cwd here. The new frame fans to the bound key, which
  // the panel's live subscription picks up.
  app.post("/api/workflows/:name/refresh", (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const requested = c.req.param("name");
    const workflow = catalog.get(requested);
    if (!workflow) {
      return c.json({ error: `No workflow named '${requested}'.` }, 404);
    }
    if (!ribWorkflowBindings?.has(workflow)) {
      return c.json({ error: `workflow '${requested}' is not a refreshable producer` }, 409);
    }
    if (refreshCwd === undefined) {
      return c.json({ error: "server has no refresh working directory" }, 400);
    }
    try {
      const { runId } = startRunCore(
        {
          store,
          conversationStore,
          activeRuns,
          subscribers,
          promptHandler: effectivePromptHandler,
          memoryTools,
          ...(projectNotebookStore !== undefined ? { projectNotebookStore } : {}),
          ...(snapshotManager !== undefined ? { snapshotManager } : {}),
          ...(ribWorkflowBindings !== undefined ? { ribWorkflowBindings } : {}),
        },
        {
          workflow,
          inputs: {},
          workingDir: refreshCwd,
          projectId: null,
          resolvedProject: null,
          // Honor the producer's declared worktree policy, same as /runs — a
          // collector that opts into isolation must not write the live checkout.
          isolationOn: workflow.worktree?.enabled === true,
          branchTemplate: workflow.worktree?.branch,
          // A panel refresh is a producer run, same class as the heartbeat's —
          // keep it out of the default (manual) runs feed and subject to prune.
          origin: "scheduled",
          ribId: ribIdFor(catalog, workflow.name),
        },
      );
      return c.json({ runId, workflowName: workflow.name });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
      return c.json(
        { error: `run is already active or not in a resumable state '${runId}'` },
        409,
      );
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
}

async function executeRunInBackground(args: ExecuteRunArgs): Promise<void> {
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
  if (existingWorktreePath !== undefined) {
    effectiveCwd = existingWorktreePath;
    worktreePathForCleanup = existingWorktreePath;
    cleanupOnSuccessOnly = true;
    const deps = await ensureWorktreeDeps({
      worktreePath: existingWorktreePath,
      abortSignal: abort.signal,
    });
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
      try {
        const created = await createWorktree({ repoPath: cwd, branch, dest });
        effectiveCwd = created.worktreePath;
        worktreePathForCleanup = created.worktreePath;
        cleanupOnSuccessOnly = true;
        try {
          store.setRunWorktreePath(runId, created.worktreePath);
        } catch (err) {
          console.warn(
            `[workflows] failed to persist worktree path for ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        const deps = await ensureWorktreeDeps({
          worktreePath: created.worktreePath,
          abortSignal: abort.signal,
        });
        if (deps.error !== null) {
          subscribers.broadcast(runId, {
            type: "run_warning",
            nodeId: null,
            message: `worktree dependency install failed; continuing: ${deps.error}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        if (event.type === "run_done") terminalStatus = event.status;
        dispatchRunEvent({
          event,
          runId,
          store,
          subscribers,
          nodeStart,
          nodeAccumulators,
          ...(publishRun !== undefined ? { publishStructured: publishRun } : {}),
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
      const out = await removeWorktree({
        repoPath: cwd,
        dest: worktreePathForCleanup,
        force: true,
      });
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
    activeRuns.delete(runId);
    // Close any lingering WS subscribers — the run will emit no further frames.
    subscribers.closeRun(runId);
    // Let the final structured frame finish composing/broadcasting, then drop
    // the run-scoped snapshot key (also closes its WS subscribers).
    await lastRecompose;
    unregisterSnapshot?.();
    await artifacts.cleanup();
  }
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
}

function dispatchRunEvent(args: DispatchArgs): void {
  const { event, runId, store, subscribers, nodeStart, nodeAccumulators, publishStructured } = args;
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
      });
      subscribers.broadcast(runId, {
        type: "node_done",
        nodeId: event.nodeId,
        status,
        error: event.result.error ?? null,
        ...(usage !== null ? { usage } : {}),
      });
      // Snapshot bridge: a structured node output becomes the latest frame
      // on the run-scoped snapshot key.
      if (event.result.output.kind === "structured") {
        publishStructured?.(event.result.output.value);
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
        completedAt: new Date().toISOString(),
        error,
      });
      subscribers.broadcast(runId, { type: "run_done", status });
      break;
    }
  }
}

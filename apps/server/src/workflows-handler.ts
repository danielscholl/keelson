// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import type { WorktreeLayout } from "@keelson/shared";
import {
  type ContentBlock,
  type IsolationOverride,
  listWorkflowsResponseSchema,
  type MessageChunk,
  recallRequestSchema,
  resumeWorkflowRunBodySchema,
  startWorkflowRunBodySchema,
  type WorkflowFrame,
  type WorkflowNodeStatus,
  type WorkflowRunStatus,
  type WorkflowSummary,
  workflowDetailSchema,
  workflowRunDetailSchema,
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
  defaultWorktreeRoot,
  isGitRepo,
  type MemoryTools,
  makeApprovalHandler,
  makeCancelHandler,
  makeCommandHandler,
  makeLoopHandler,
  makeScriptHandler,
  type NodeHandler,
  type NodeResult,
  type RequestCancel,
  type RunStreamEvent,
  removeWorktree,
  resolveBranchTemplate,
  runWorkflow,
  type WorkflowDefinition,
  worktreePathFor,
  worktreePathForRepoLocal,
} from "@keelson/workflows";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { z } from "zod";

import type { WorkflowCatalog } from "./bootstrap.ts";
import { createContentPartsAccumulator } from "./content-parts.ts";
import { isAllowedOrigin, type WsData } from "./server-context.ts";

// CSRF defense for state-changing routes — reject cross-origin POSTs that
// the browser would otherwise send with the user's cookies.
function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

import type { ConversationStore } from "./conversation-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ProjectsStore } from "./projects-store.ts";
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
  // Override for the worktree home (defaults to `~/.keelson/worktrees/`).
  // Test-only seam: production wiring leaves it undefined so isolated runs
  // land in the documented global location; tests inject a per-suite temp
  // dir so they don't pollute the developer's home.
  worktreeRoot?: string;
  // Real prompt handler injected from the composition root. When omitted
  // (tests, env where no provider is registered), the placeholder fires and
  // prompt nodes fail with a "not registered" sentinel. Keeps the route
  // construction testable without standing up a provider rig.
  promptHandler?: NodeHandler;
  // Optional MemoryStore. Undefined → executor memory hooks no-op.
  memoryStore?: MemoryStore;
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

function workflowToSummary(workflow: WorkflowDefinition): WorkflowSummary {
  return {
    name: workflow.name,
    description: workflow.description,
    nodeCount: workflow.nodes.length,
  };
}

function workflowToDetail(workflow: WorkflowDefinition) {
  return {
    name: workflow.name,
    description: workflow.description,
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      type: nodeTypeOf(n),
      ...(n.depends_on ? { dependsOn: n.depends_on } : {}),
      ...(n.when ? { when: n.when } : {}),
      ...(n.trigger_rule ? { triggerRule: n.trigger_rule } : {}),
    })),
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
}

export interface ActiveRuns {
  register(runId: string, entry: ActiveRunEntry): void;
  get(runId: string): ActiveRunEntry | undefined;
  delete(runId: string): void;
  size(): number;
  abortAll(): Promise<void>;
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
}

class WorkflowSubscriberRegistry implements WorkflowSubscribers {
  private readonly subscribers = new Map<string, Set<ServerWebSocket<WsData>>>();

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
    if (!set || set.size === 0) return;
    const json = JSON.stringify(frame);
    for (const ws of set) {
      try {
        ws.send(json);
      } catch {
        // socket closed mid-send; close handler will drain it
      }
    }
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
    worktreeRoot,
    promptHandler,
    memoryStore,
  } = opts;
  const effectivePromptHandler = promptHandler ?? placeholderPromptHandler;
  // Re-parse with the Zod wire schemas at the adapter boundary so executor-built requests
  // satisfy the same constraints as the HTTP route (text-length caps, source-ref shape, etc.).
  // Without this, an in-process workflow could persist values the HTTP path would reject.
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

  app.get("/api/workflows", (c) => {
    const workflows = catalog.list().map(workflowToSummary);
    return c.json(
      listWorkflowsResponseSchema.parse({
        workflows,
        discoveryNotices: catalog.discoveryNotices(),
      }),
    );
  });

  // Register the literal `/api/workflows/runs` path BEFORE the `/:name`
  // route so Hono doesn't bind `name="runs"` and return a 404. Strict
  // allow-list on `status` keeps this from drifting into a generic aggregate
  // endpoint; widen the allow-list only when a concrete caller needs it.
  app.get("/api/workflows/runs", (c) => {
    const status = c.req.query("status");
    if (status !== "paused") {
      return c.json({ error: "status query is required and must be 'paused'" }, 400);
    }
    return c.json({ runs: store.listRunsByStatus("paused") });
  });

  // Read-only feed for `keelson worktree prune`. Returns persisted
  // worktree_path values so worktrees from deleted projects (FK NULLed,
  // path retained) stay prunable.
  app.get("/api/workflows/worktree-paths", (c) => {
    return c.json({ paths: store.listWorktreePaths() });
  });

  app.get("/api/workflows/:name", (c) => {
    const name = c.req.param("name");
    const wf = catalog.get(name);
    if (!wf) return c.json({ error: `unknown workflow '${name}'` }, 404);
    return c.json({ workflow: workflowDetailSchema.parse(workflowToDetail(wf)) });
  });

  app.get("/api/workflows/:name/runs", (c) => {
    const name = c.req.param("name");
    if (!catalog.get(name)) {
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
    const name = c.req.param("name");
    const workflow = catalog.get(name);
    if (!workflow) {
      return c.json({ error: `unknown workflow '${name}'` }, 404);
    }
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
    let projectName: string | null = null;
    let workingDir: string;
    if (parsed.data.workingDir !== undefined && parsed.data.workingDir.trim().length > 0) {
      const raw = parsed.data.workingDir;
      if (!isAbsolute(raw)) {
        return c.json({ error: "workingDir must be an absolute path" }, 400);
      }
      workingDir = normalize(raw);
      if (parsed.data.projectId !== undefined && projectsStore) {
        const proj = projectsStore.get(parsed.data.projectId);
        if (!proj) {
          return c.json({ error: `unknown project '${parsed.data.projectId}'` }, 400);
        }
        resolvedProject = proj;
      } else if (projectsStore) {
        resolvedProject = projectsStore.findByPathPrefix(workingDir) ?? null;
      }
      if (resolvedProject) {
        projectId = resolvedProject.id;
        projectName = resolvedProject.name;
      }
    } else if (parsed.data.projectId !== undefined && parsed.data.projectId.length > 0) {
      if (!projectsStore) {
        return c.json({ error: "projects are not wired in this server" }, 400);
      }
      const project = projectsStore.get(parsed.data.projectId);
      if (!project) {
        return c.json({ error: `unknown project '${parsed.data.projectId}'` }, 400);
      }
      resolvedProject = project;
      projectId = project.id;
      projectName = project.name;
      workingDir = project.rootPath;
    } else if (defaultCwd !== undefined) {
      workingDir = defaultCwd;
    } else {
      return c.json({ error: "projectId or workingDir is required" }, 400);
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

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    // Create the conversation FIRST so the workflow_runs FK has a target.
    // Persist the dispatch user message synchronously — it's the only durable
    // message; the trace renders virtually from useWorkflowRun on the client.
    const conversation = conversationStore.create({
      providerId: "workflow",
      name: `${name} · ${runId.slice(0, 6)}`,
    });
    conversationStore.appendMessage(conversation.id, {
      id: crypto.randomUUID(),
      role: "user",
      content: formatDispatchMessage(name, parsed.data.inputs),
      createdAt: startedAt,
    });
    try {
      store.createRun({
        runId,
        workflowName: name,
        inputs: parsed.data.inputs,
        startedAt,
        conversationId: conversation.id,
        projectId,
        workingDir,
      });
    } catch (err) {
      // Orphan rollback: the conversation row exists only to anchor a run, so
      // if createRun throws (FK validation, transient SQLite, etc.) drop the
      // empty conversation rather than leave it dangling in the sidebar.
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
      return c.json({ error: `failed to create run: ${message}` }, 500);
    }
    const abort = new AbortController();
    // Per-run pending approval map. The approval handler awaits a Promise
    // the route writes here; POST /resume resolves it.
    const pendingApprovals = new Map<string, PendingApproval>();
    // Capture the executeRun promise so shutdown can await settlement
    // (the executor writes the run's terminal status to SQLite inside
    // its onEvent run_done branch — db.close() must not race that).
    const done = executeRunInBackground({
      workflow,
      runId,
      inputs: parsed.data.inputs,
      cwd: workingDir,
      store,
      abort,
      activeRuns,
      subscribers,
      promptHandler: effectivePromptHandler,
      pendingApprovals,
      isolation: isolationOn
        ? {
            projectName: slugifyForPath(projectName ?? basename(workingDir)),
            branchTemplate,
            worktreeRoot,
            layout: resolvedProject?.worktreeLayout ?? "workspace-scoped",
            // repo-local anchors at the project's rootPath whenever workingDir
            // sits inside it (incl. equal) — that's the dir keelson worktree
            // prune scans. Only fall back to workingDir when the caller forced
            // a path that's not under the project (different repo entirely).
            projectRootPath:
              resolvedProject &&
              (workingDir === resolvedProject.rootPath ||
                workingDir.startsWith(`${resolvedProject.rootPath}${sep}`))
                ? resolvedProject.rootPath
                : workingDir,
          }
        : null,
      // Scope this run's memory recall/writeback to the target project so a
      // workflow with `memory:` nodes doesn't bleed across projects.
      ...(projectId !== null ? { projectId } : {}),
      ...(memoryTools !== undefined ? { memoryTools } : {}),
    });
    activeRuns.register(runId, { abort, done, pendingApprovals });

    return c.json({ runId });
  });

  app.get("/api/workflows/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const run = store.getRun(runId);
    if (!run) return c.json({ error: `unknown run '${runId}'` }, 404);
    return c.json({ run: workflowRunDetailSchema.parse(run) });
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
      const { existed, conversationId } = await purgeWorkflowRun({
        runId,
        store,
        activeRuns,
      });
      if (!existed) {
        return c.json({ error: `unknown run '${runId}'` }, 404);
      }
      if (conversationId !== null) {
        try {
          conversationStore.delete(conversationId);
        } catch (err) {
          console.warn(
            `[workflows] failed to delete linked conversation ${conversationId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
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
    const entry = activeRuns.get(runId);
    if (!entry) {
      // 404 covers both "never existed" and "already terminal" — same shape
      // as DELETE so the client treats them uniformly.
      return c.json({ error: `unknown or completed run '${runId}'` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = resumeWorkflowRunBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const pending = entry.pendingApprovals.get(parsed.data.nodeId);
    if (!pending) {
      // 409 — the run exists but no approval is open for that node. Could be
      // a stale client retrying after a successful resume, or the user typed
      // a nodeId that isn't currently paused.
      return c.json({ error: `no pending approval for node '${parsed.data.nodeId}'` }, 409);
    }
    // pauseId guard. Interactive loops reuse the same nodeId across
    // iterations; a stale POST for iteration N (e.g. a CLI retry whose
    // first attempt actually succeeded) would otherwise resolve
    // iteration N+1 with the wrong text. When the client knows the
    // pauseId, require it to match — otherwise accept and rely on the
    // operator to know what they're doing (CLI default path).
    if (parsed.data.pauseId !== undefined && parsed.data.pauseId !== pending.pauseId) {
      return c.json(
        {
          error: `pauseId mismatch for node '${parsed.data.nodeId}' — the pause has advanced; refetch the run state and retry`,
        },
        409,
      );
    }
    // Flip the run status back to running BEFORE we hand the text to the
    // executor — otherwise the snapshot could briefly report 'paused' after
    // the handler has already started writing the next node's state.
    // If other approvals are still pending we stay 'paused'.
    entry.pendingApprovals.delete(parsed.data.nodeId);
    if (entry.pendingApprovals.size === 0) {
      try {
        store.updateRunStatus({
          runId,
          status: "running",
          completedAt: null,
          error: null,
        });
      } catch (err) {
        console.warn(
          `[workflows] resume: failed to flip ${runId} back to running: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    try {
      pending.resolve(parsed.data.text);
    } catch (err) {
      // Resolver already settled (rare race with abort). Surface as 409 so
      // the client knows the run state diverged.
      return c.json(
        {
          error: `resume failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        409,
      );
    }
    return c.json({ resumed: true });
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
  /** Project label used as the path segment under `<root>/<name>/<branch>`. */
  projectName: string;
  /** YAML-supplied branch template; undefined → default. */
  branchTemplate: string | undefined;
  /** Override for the workspace-scoped worktree home; undefined → `defaultWorktreeRoot()`. */
  worktreeRoot: string | undefined;
  /** repo-local → `<projectRootPath>/.worktrees/<branch>/`; otherwise workspace-scoped. */
  layout: WorktreeLayout;
  /** Source repo root; required for repo-local layout, ignored for workspace-scoped. */
  projectRootPath: string | undefined;
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
}

// Constrain a free-form filesystem segment to a slug git/posix paths accept.
// Used as the per-project bucket under ~/.keelson/worktrees/<slug>/ when the
// run isn't tied to a named project.
function slugifyForPath(s: string): string {
  const slug = s
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return !slug || /^\.+$/.test(slug) ? "workspace" : slug;
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
  if (isolation !== null) {
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
      const dest =
        isolation.layout === "repo-local" && isolation.projectRootPath !== undefined
          ? worktreePathForRepoLocal({
              projectRootPath: isolation.projectRootPath,
              branch,
            })
          : worktreePathFor({
              root: isolation.worktreeRoot ?? defaultWorktreeRoot(),
              projectName: isolation.projectName,
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
  // boundary; iteration count / sessionId are forward-declared on
  // ApprovalContext but only used in-memory for now — the SPA renders the
  // pause through the same approval_awaiting frame.
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
      onEvent: (event) => {
        if (event.type === "run_done") terminalStatus = event.status;
        dispatchRunEvent({
          event,
          runId,
          store,
          subscribers,
          nodeStart,
          nodeAccumulators,
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
    // worktree prune` (slice 4) is the operator's escape hatch.
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
}

function dispatchRunEvent(args: DispatchArgs): void {
  const { event, runId, store, subscribers, nodeStart, nodeAccumulators } = args;
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
      store.upsertNodeOutput({
        runId,
        nodeId: event.nodeId,
        status,
        outputText,
        contentParts: parts,
        startedAt,
        completedAt,
        error: event.result.error ?? null,
      });
      subscribers.broadcast(runId, {
        type: "node_done",
        nodeId: event.nodeId,
        status,
        error: event.result.error ?? null,
      });
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
      store.updateRunStatus({
        runId,
        status,
        completedAt: new Date().toISOString(),
        error: null,
      });
      subscribers.broadcast(runId, { type: "run_done", status });
      break;
    }
  }
}

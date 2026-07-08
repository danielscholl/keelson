// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Chat-callable tools that expose the workflow engine to the LLM. A FIXED set
// of five tools (constant base-prompt cost regardless of how many workflows are
// authored): workflow_list discovers, workflow_run starts + watches,
// workflow_respond resolves a paused approval, workflow_resume re-enters a
// failed/cancelled run, workflow_status reports. They
// drive the same in-process WorkflowController the HTTP routes use; run IDs flow
// through the tool results so the model can carry them across chat turns.

import {
  type Project,
  parseWorkflowDescription,
  resumeWorkflowRunBodySchema,
  type ToolContext,
  type ToolDefinition,
  type WorkflowFrame,
  type WorkflowRunDetail,
} from "@keelson/shared";
import { z } from "zod";
import type { WorkflowCatalog, WorkflowScopeContext } from "./bootstrap.ts";
import type { ProjectsStore } from "./projects-store.ts";
import { resolveWorkflowName } from "./workflow-resolve.ts";
import type { WatchResult, WorkflowController } from "./workflows-handler.ts";

export interface CreateWorkflowChatToolsDeps {
  controller: WorkflowController;
  catalog: WorkflowCatalog;
  // Lets workflow_list / workflow_run recover the conversation's project from
  // ctx.cwd (chat sets it to the project root) so catalog reads see that
  // project's workflows shadowing global. The controller re-derives the same
  // scope from workingDir, keeping list- and run-resolution in agreement.
  projectsStore?: Pick<ProjectsStore, "findByPathPrefix" | "get" | "getByName">;
  // Soft cap on how long workflow_run / workflow_respond block waiting for the
  // run to pause or finish before returning a "still running" result. Tunable
  // for tests; the chat default gives a plan/approval node time to reach its
  // gate without pinning the turn indefinitely.
  watchDeadlineMs?: number;
}

// Kept under the server's 60s WS idleTimeout: a quiet long-running node would
// otherwise leave the chat socket idle (streamProgress drops node_chunk), so the
// tool must return — sending the "still running" result resets idle — before
// then. Slower runs degrade to a workflow_status poll.
const DEFAULT_CHAT_WATCH_DEADLINE_MS = 50_000;
const PER_NODE_OUTPUT_CAP = 2_000;
const PAUSED_OUTPUT_CAP = 8_000;
const TERMINAL_OUTPUT_CAP = 12_000;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function emitResult(ctx: ToolContext, content: string, isError = false): void {
  // toolUseId is a placeholder — Claude ignores it (its SDK emits the canonical
  // block), Copilot rewrites it to the real call id. See the provider factories.
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// Forward live node progress to the chat stream as terse text lines so a long
// run shows movement before the final tool_result lands. node_chunk is left out
// on purpose — it would flood the turn with raw provider output.
function streamProgress(ctx: ToolContext): (frame: WorkflowFrame) => void {
  return (frame) => {
    if (frame.type === "node_started") {
      ctx.emit({ type: "text", content: `▸ ${frame.nodeId}\n` });
    } else if (frame.type === "run_warning") {
      ctx.emit({ type: "text", content: `⚠ ${frame.message}\n` });
    }
  };
}

function renderNodes(detail: WorkflowRunDetail): string {
  const blocks: string[] = [];
  for (const node of detail.nodes) {
    const head = `[${node.nodeId}] ${node.status}`;
    const body = node.outputText ?? "";
    if (body.trim().length === 0) {
      blocks.push(head);
      continue;
    }
    blocks.push(`${head}\n${truncate(body, PER_NODE_OUTPUT_CAP)}`);
  }
  return blocks.join("\n\n");
}

// Shared resume guidance so workflow_run (live pause) and workflow_status
// (status-polled pause) hand the model the SAME runId/nodeId/pauseId protocol.
// pauseId may be absent only for a paused-but-reconciled run after a restart.
function resumeInstructions(runId: string, nodeId: string, pauseId: string | undefined): string {
  const refs =
    pauseId !== undefined
      ? `runId="${runId}", nodeId="${nodeId}", pauseId="${pauseId}"`
      : `runId="${runId}", nodeId="${nodeId}"`;
  return [
    "To continue: relay the plan to the user, then call workflow_respond with",
    `  ${refs}, text=<the user's decision>.`,
    'Use the literal text "approve" to accept as-is (the canonical token approval gates branch on), or pass the user\'s feedback verbatim to fold it into the plan.',
  ].join("\n");
}

// Turns a watch result into the tool_result the model reads. Carries the
// runId/nodeId/pauseId on a pause so the model can resume in a later turn.
function describeState(
  controller: WorkflowController,
  runId: string,
  state: WatchResult,
  workingDir: string,
): { content: string; isError: boolean } {
  switch (state.kind) {
    case "paused": {
      const detail = controller.getRun(runId);
      const nodeView = detail ? truncate(renderNodes(detail), PAUSED_OUTPUT_CAP) : "";
      const content = [
        `Workflow run ${runId} is PAUSED awaiting approval at node "${state.nodeId}".`,
        "",
        "Approval prompt:",
        state.message,
        nodeView ? `\nRun output so far:\n${nodeView}` : "",
        "",
        resumeInstructions(runId, state.nodeId, state.pauseId),
      ]
        .filter((line) => line !== "")
        .join("\n");
      return { content, isError: false };
    }
    case "terminal": {
      const detail = controller.getRun(runId);
      const nodeView = detail ? truncate(renderNodes(detail), TERMINAL_OUTPUT_CAP) : "";
      const verb = state.status === "succeeded" ? "completed successfully" : state.status;
      const hint =
        detail && state.status === "failed" && hasRepoMissingFailure(detail)
          ? `\n\n${repoMissingHint(workingDir)}`
          : "";
      const content = [
        `Workflow run ${runId} ${verb}.`,
        nodeView ? `\nRun output:\n${nodeView}` : "",
        hint,
      ]
        .filter((line) => line !== "")
        .join("\n");
      return { content, isError: state.status === "failed" };
    }
    case "running":
      return {
        content: `Workflow run ${runId} is still in progress and continues in the background. Call workflow_status with runId="${runId}" to check on it.`,
        isError: false,
      };
    case "unknown":
      return {
        content: `Workflow run ${runId} was not found (it may have been purged, or the server restarted while it was paused).`,
        isError: true,
      };
  }
}

const listInputSchema = z.object({
  query: z.string().optional(),
});

const runInputSchema = z.object({
  name: z.string().min(1),
  arguments: z.string().optional(),
  project: z.string().min(1).optional(),
});

// Reuse the HTTP resume body schema (nodeId + text ≤ 16 KiB + optional pauseId)
// so the chat path enforces the SAME reply-size cap as POST /resume — just add
// runId, which the route carries as a path param.
const respondInputSchema = resumeWorkflowRunBodySchema.extend({
  runId: z.string().min(1),
});

const resumeInputSchema = z.object({
  runId: z.string().min(1),
});

const statusInputSchema = z.object({
  runId: z.string().optional(),
});

const REPO_MISSING_HINT_RE = /(?:failed to run git|not a git repository)/i;

function resolveProjectSelection(
  projectsStore: Pick<ProjectsStore, "get" | "getByName"> | undefined,
  selector: string,
): { ok: true; project: Project } | { ok: false; message: string } {
  const projectId = selector.trim();
  if (projectId.length === 0) {
    return { ok: false, message: "invalid project selector: empty" };
  }
  const byId = projectsStore?.get(projectId);
  const byName = projectsStore?.getByName(projectId);
  if (byId && byName && byId.id !== byName.id) {
    return {
      ok: false,
      message: `project selector "${selector}" is ambiguous; use project id "${byId.id}" or exact name "${byName.name}"`,
    };
  }
  if (byId) return { ok: true, project: byId };
  if (byName) return { ok: true, project: byName };
  return {
    ok: false,
    message: `unknown project "${selector}". Use a registered project id or exact project name.`,
  };
}

function hasRepoMissingFailure(detail: WorkflowRunDetail): boolean {
  if (detail.error !== null && REPO_MISSING_HINT_RE.test(detail.error)) return true;
  return detail.nodes.some((node) => node.error !== null && REPO_MISSING_HINT_RE.test(node.error));
}

function repoMissingHint(workingDir: string): string {
  return `Hint: workflow ran in cwd "${workingDir}", which is not a git repository. For repo-scoped workflows, call workflow_run with project="<registered project id or exact name>".`;
}

export function createWorkflowChatTools(deps: CreateWorkflowChatToolsDeps): ToolDefinition[] {
  const { controller, catalog } = deps;
  const watchDeadlineMs = deps.watchDeadlineMs ?? DEFAULT_CHAT_WATCH_DEADLINE_MS;
  const scopeFor = (ctx: ToolContext): WorkflowScopeContext | undefined => {
    const projectId = deps.projectsStore?.findByPathPrefix(ctx.cwd)?.id;
    return projectId !== undefined ? { projectId } : undefined;
  };

  const workflowList: ToolDefinition = {
    name: "workflow_list",
    description:
      "Search the catalog of human-authored deterministic workflows that can be run. Call this when a request matches a repeatable or automatable task (e.g. fixing a GitHub issue, reviewing a PR) to find a matching workflow before running it. Optional `query` filters by name and description; omit to list all.",
    inputSchema: listInputSchema,
    async execute(input, ctx) {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const q = parsed.data.query?.trim().toLowerCase();
      const all = catalog.list(scopeFor(ctx));
      const matches = q
        ? all.filter(
            (w) => w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
          )
        : all;
      if (matches.length === 0) {
        emitResult(
          ctx,
          q
            ? `No workflows match "${parsed.data.query}". ${all.length} workflow(s) exist; call workflow_list with no query to see them.`
            : "No workflows are available.",
        );
        return;
      }
      const rendered = matches
        .map((w) => {
          const d = parseWorkflowDescription(w.description);
          const parts = [
            d.useWhen ? `  Use when: ${d.useWhen}` : "",
            d.triggers ? `  Triggers: ${d.triggers}` : "",
            d.does ? `  Does: ${d.does}` : "",
            d.notFor ? `  NOT for: ${d.notFor}` : "",
            !d.useWhen && !d.triggers && d.body ? `  ${d.body}` : "",
          ].filter((p) => p !== "");
          return `• ${w.name}\n${parts.join("\n")}`;
        })
        .join("\n\n");
      emitResult(
        ctx,
        `${matches.length} workflow(s):\n\n${rendered}\n\nRun one with workflow_run(name, arguments).`,
      );
    },
  };

  const workflowRun: ToolDefinition = {
    name: "workflow_run",
    description:
      'Start a deterministic workflow by name (discover names with workflow_list). Prefer this whenever the user asks to run a workflow — do NOT execute the name as a shell command. Names are matched leniently (case- and hyphen-insensitive), so "smoketest" resolves to "smoke-test". `arguments` is free-form text passed to the workflow as $ARGUMENTS (e.g. an issue number or a task description). Optional `project` targets a registered project by id or exact name. Returns when the run pauses for approval, finishes, or has run long enough to report progress. If it pauses, relay the plan to the user and resume it with workflow_respond.',
    inputSchema: runInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = runInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const requested = parsed.data.name;
      let project: Project | undefined;
      if (parsed.data.project !== undefined) {
        const selectedProject = resolveProjectSelection(deps.projectsStore, parsed.data.project);
        if (!selectedProject.ok) {
          emitResult(ctx, selectedProject.message, true);
          return;
        }
        project = selectedProject.project;
      }
      const scope = project ? { projectId: project.id } : scopeFor(ctx);
      const names = catalog.list(scope).map((w) => w.name);
      const resolution = resolveWorkflowName(requested, names);
      if (resolution.kind === "none") {
        const avail =
          names.length > 0
            ? `Available workflows: ${names.join(", ")}.`
            : "No workflows are available.";
        emitResult(
          ctx,
          `No workflow matches "${requested}". ${avail} Call workflow_list for details.`,
          true,
        );
        return;
      }
      if (resolution.kind === "suggest") {
        emitResult(
          ctx,
          `No workflow named "${requested}". Did you mean: ${resolution.candidates.join(", ")}? Call workflow_run again with the exact name.`,
          true,
        );
        return;
      }
      const name = resolution.name;
      const started = controller.startRun({
        name,
        inputs: { ARGUMENTS: parsed.data.arguments ?? "" },
        workingDir: project?.rootPath ?? ctx.cwd,
        ...(project ? { project: { id: project.id, rootPath: project.rootPath } } : {}),
      });
      if (!started.ok) {
        emitResult(ctx, `Could not start workflow "${name}": ${started.message}`, true);
        return;
      }
      ctx.emit({ type: "text", content: `Started workflow "${name}" (run ${started.runId}).\n` });
      const state = await controller.awaitPauseOrTerminal(started.runId, {
        onFrame: streamProgress(ctx),
        signal: ctx.abortSignal,
        deadlineMs: watchDeadlineMs,
      });
      const { content, isError } = describeState(
        controller,
        started.runId,
        state,
        project?.rootPath ?? ctx.cwd,
      );
      emitResult(ctx, content, isError);
    },
  };

  const workflowRespond: ToolDefinition = {
    name: "workflow_respond",
    description:
      "Resume a workflow that paused for human approval. Pass the runId, nodeId, and pauseId reported by workflow_run, plus the user's decision as `text` (the literal 'approve' to accept, or free-form feedback to fold into the plan). Returns the run's next state.",
    inputSchema: respondInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = respondInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const { runId, nodeId, text, pauseId } = parsed.data;
      const result = controller.resolveApproval(runId, {
        nodeId,
        text,
        ...(pauseId !== undefined ? { pauseId } : {}),
      });
      if (!result.ok) {
        const hint =
          result.reason === "stale_pause"
            ? " Call workflow_status to refetch the current state, then retry."
            : result.reason === "no_pending"
              ? " The run may have already advanced past this approval."
              : "";
        emitResult(ctx, `Could not resume run ${runId}: ${result.message}.${hint}`, true);
        return;
      }
      const state = await controller.awaitPauseOrTerminal(runId, {
        onFrame: streamProgress(ctx),
        signal: ctx.abortSignal,
        deadlineMs: watchDeadlineMs,
      });
      const { content, isError } = describeState(controller, runId, state, ctx.cwd);
      emitResult(ctx, content, isError);
    },
  };

  const workflowResume: ToolDefinition = {
    name: "workflow_resume",
    description:
      "Resume a workflow run that FAILED or was cancelled, continuing from the last successfully-completed node — it reuses the run's worktree and prior node outputs, so nothing already done is re-run. Pass the runId from workflow_run or workflow_status. Use this to retry a run that stopped on a transient or since-fixed error; it is NOT for an approval pause (use workflow_respond for that). Returns the run's next state.",
    inputSchema: resumeInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = resumeInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const { runId } = parsed.data;
      const result = controller.resumeRun(runId);
      if (!result.ok) {
        const hint =
          result.reason === "not_terminal"
            ? " Only failed or cancelled runs can be resumed; call workflow_status to check its state."
            : " It may have been purged, or the server restarted since it ran.";
        emitResult(ctx, `Could not resume run ${runId}: ${result.message}.${hint}`, true);
        return;
      }
      const state = await controller.awaitPauseOrTerminal(runId, {
        onFrame: streamProgress(ctx),
        signal: ctx.abortSignal,
        deadlineMs: watchDeadlineMs,
      });
      const { content, isError } = describeState(controller, runId, state, ctx.cwd);
      emitResult(ctx, content, isError);
    },
  };

  const workflowStatus: ToolDefinition = {
    name: "workflow_status",
    description:
      "Check workflow runs. With no runId, lists currently running and paused runs. With a runId, returns that run's per-node status, including any node awaiting approval.",
    inputSchema: statusInputSchema,
    async execute(input, ctx) {
      const parsed = statusInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const runId = parsed.data.runId?.trim();
      if (runId) {
        const detail = controller.getRun(runId);
        if (!detail) {
          emitResult(ctx, `Workflow run ${runId} was not found.`, true);
          return;
        }
        const awaiting = detail.nodes.find((n) => n.status === "awaiting");
        const lines = [
          `Run ${runId} — workflow "${detail.workflowName}" — status ${detail.status}.`,
        ];
        if (detail.status === "failed" || detail.status === "cancelled") {
          lines.push(
            `This run is ${detail.status}. Resume it from the last completed node with workflow_resume(runId="${runId}").`,
          );
        }
        if (awaiting) {
          // Surface the live pauseId (held only in the in-memory pending map, not
          // getRun) so a status-polled approval follows the same resume protocol
          // as workflow_run instead of dropping the stale-pause guard.
          const pauseId = controller
            .pendingApprovals(runId)
            .find((p) => p.nodeId === awaiting.nodeId)?.pauseId;
          lines.push(
            `Awaiting approval at node "${awaiting.nodeId}": ${awaiting.outputText ?? ""}`,
            resumeInstructions(runId, awaiting.nodeId, pauseId),
          );
        }
        lines.push("", renderNodes(detail));
        emitResult(ctx, lines.filter((line) => line !== "").join("\n"));
        return;
      }
      const active = controller.listRuns();
      if (active.length === 0) {
        emitResult(ctx, "No running or paused workflows.");
        return;
      }
      const rendered = active
        .map(
          (r) =>
            `• ${r.runId} — ${r.workflowName} [${r.status}] started ${r.startedAt}` +
            (r.status === "paused" ? " (awaiting approval — use workflow_respond)" : ""),
        )
        .join("\n");
      emitResult(
        ctx,
        `${active.length} active run(s):\n${rendered}\n\nPass a runId to workflow_status for per-node detail.`,
      );
    },
  };

  return [workflowList, workflowRun, workflowRespond, workflowResume, workflowStatus];
}

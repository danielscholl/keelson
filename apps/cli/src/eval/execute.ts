// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  getWorkflowRunResponseSchema,
  usageEventsResponseSchema,
  type WorkflowFrame,
  type WorkflowRunDetail,
} from "@keelson/shared";
import type { RunStreamEvent } from "@keelson/workflows";

import { normalizeBase, originHeader } from "../http/base.ts";
import { listProjects } from "../http/projects-client.ts";
import { attachRun, getRun, startRun } from "../http/workflow-client.ts";
import { runHeadless } from "../in-process/run-workflow.ts";

export interface CaseExecution {
  readonly runId: string | null;
  readonly runStatus: "succeeded" | "failed" | "cancelled" | null;
  readonly error: string | null;
  // Last succeeded node's output, the executor's own notion of "final".
  readonly finalOutput: string | null;
  readonly nodeOutputs: Readonly<Record<string, string>>;
  readonly durationMs: number | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly costUsd: number | null;
  readonly definitionHash: string | null;
}

export interface CaseExecutionRequest {
  readonly inputs: Readonly<Record<string, string>>;
  readonly onEvent?: (line: string) => void;
}

export type CaseExecutor = (request: CaseExecutionRequest) => Promise<CaseExecution>;

function errorExecution(error: string, runId: string | null = null): CaseExecution {
  return {
    runId,
    runStatus: null,
    error,
    finalOutput: null,
    nodeOutputs: {},
    durationMs: null,
    tokens: null,
    costUsd: null,
    definitionHash: null,
  };
}

function formatEvent(event: RunStreamEvent): string {
  switch (event.type) {
    case "node_started":
      return `  · ${event.nodeId} …`;
    case "node_done": {
      const icon =
        event.result.status === "succeeded" ? "✓" : event.result.status === "skipped" ? "○" : "✗";
      return `  ${icon} ${event.nodeId}${event.result.error ? ` — ${event.result.error}` : ""}`;
    }
    case "run_warning":
      return `  ! ${event.message}`;
    default:
      return "";
  }
}

function formatFrame(frame: WorkflowFrame): string {
  switch (frame.type) {
    case "node_started":
      return `  · ${frame.nodeId} …`;
    case "node_done": {
      const icon = frame.status === "succeeded" ? "✓" : frame.status === "skipped" ? "○" : "✗";
      return `  ${icon} ${frame.nodeId}${frame.error ? ` — ${frame.error}` : ""}`;
    }
    case "run_warning":
      return `  ! ${frame.message}`;
    default:
      return "";
  }
}

export interface InProcessExecutorOptions {
  readonly workflow: string;
  readonly cwd: string;
  readonly provider?: string;
  readonly workflowsDir?: string;
  readonly preflight?: boolean;
}

export function makeInProcessExecutor(opts: InProcessExecutorOptions): CaseExecutor {
  return async (request) => {
    const succeededOrder: string[] = [];
    let runId: string | null = null;
    let input = 0;
    let output = 0;
    let sawUsage = false;
    try {
      const result = await runHeadless({
        name: opts.workflow,
        inputs: { ...request.inputs },
        cwd: opts.cwd,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.workflowsDir !== undefined ? { workflowsDir: opts.workflowsDir } : {}),
        ...(opts.preflight !== undefined ? { preflight: opts.preflight } : {}),
        onEvent: (event) => {
          if (event.type === "run_started") runId = event.runId;
          if (event.type === "node_done") {
            if (event.result.status === "succeeded") succeededOrder.push(event.nodeId);
            if (event.result.usage !== undefined) {
              sawUsage = true;
              input += event.result.usage.inputTokens;
              output += event.result.usage.outputTokens;
            }
          }
          const line = formatEvent(event);
          if (line) request.onEvent?.(line);
        },
      });
      const nodeOutputs: Record<string, string> = {};
      for (const [id, node] of Object.entries(result.summary.nodes)) {
        nodeOutputs[id] = node.output;
      }
      const last = succeededOrder.at(-1);
      return {
        runId: result.runId,
        runStatus: result.summary.status,
        error: result.summary.status === "succeeded" ? null : `run ${result.summary.status}`,
        finalOutput: last !== undefined ? (nodeOutputs[last] ?? null) : null,
        nodeOutputs,
        durationMs: result.summary.completedAtMs - result.summary.startedAtMs,
        tokens: sawUsage ? { input, output } : null,
        costUsd: null,
        definitionHash: null,
      };
    } catch (err) {
      return errorExecution(err instanceof Error ? err.message : String(err), runId);
    }
  };
}

export interface HttpExecutorOptions {
  readonly workflow: string;
  readonly baseUrl: string;
  readonly projectId?: string;
  readonly workingDir?: string;
  readonly provider?: string;
  readonly preflight?: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveProjectId(baseUrl: string, nameOrId: string): Promise<string | null> {
  if (UUID_PATTERN.test(nameOrId)) return nameOrId;
  const projects = await listProjects(baseUrl);
  return projects.find((p) => p.name === nameOrId)?.id ?? null;
}

// Sum the server's per-event `costUsd` for one run. Null (never 0) when any
// event is unpriced, when the run has no events, or when the server is older
// than the pricing migration and does not serve the field.
export async function fetchRunCostUsd(baseUrl: string, runId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${normalizeBase(baseUrl)}/api/usage/events?limit=500&runId=${encodeURIComponent(runId)}`,
      { headers: { accept: "application/json", origin: originHeader(baseUrl) } },
    );
    if (!res.ok) return null;
    const parsed = usageEventsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const rows = parsed.data.filter((row) => row.runId === runId);
    if (rows.length === 0) return null;
    let total = 0;
    for (const row of rows) {
      if (row.costUsd === null) return null;
      total += row.costUsd;
    }
    return total;
  } catch {
    return null;
  }
}

export function makeHttpExecutor(opts: HttpExecutorOptions): CaseExecutor {
  return async (request) => {
    let runId: string;
    try {
      ({ runId } = await startRun(opts.baseUrl, opts.workflow, {
        inputs: { ...request.inputs },
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        ...(opts.workingDir !== undefined ? { workingDir: opts.workingDir } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.preflight === false ? { preflight: false } : {}),
      }));
    } catch (err) {
      return errorExecution(err instanceof Error ? err.message : String(err));
    }
    const succeededOrder: string[] = [];
    let terminalStatus: string | null = null;
    try {
      await attachRun({
        baseUrl: opts.baseUrl,
        runId,
        onFrame: (frame) => {
          if (frame.type === "node_done" && frame.status === "succeeded") {
            succeededOrder.push(frame.nodeId);
          }
          if (frame.type === "run_done") terminalStatus = frame.status;
          const line = formatFrame(frame);
          if (line) request.onEvent?.(line);
        },
      });
    } catch (err) {
      return errorExecution(
        `run ${runId} stream failed: ${err instanceof Error ? err.message : String(err)}`,
        runId,
      );
    }
    if (terminalStatus === null) {
      return errorExecution(`run ${runId} ended without a terminal frame`, runId);
    }
    let detail: WorkflowRunDetail;
    try {
      const body = await getRun(opts.baseUrl, runId);
      const parsed = getWorkflowRunResponseSchema.safeParse(body);
      if (!parsed.success) {
        return errorExecution(
          `run ${runId} detail did not match this CLI's schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          runId,
        );
      }
      detail = parsed.data.run;
    } catch (err) {
      return errorExecution(
        `run ${runId} detail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        runId,
      );
    }
    const nodeOutputs: Record<string, string> = {};
    let input = 0;
    let output = 0;
    let sawUsage = false;
    for (const row of detail.nodes) {
      nodeOutputs[row.nodeId] = row.outputText ?? "";
      if (row.usage !== null) {
        sawUsage = true;
        input += row.usage.inputTokens;
        output += row.usage.outputTokens;
      }
    }
    // A run that finished before the socket attached replays only run_done,
    // so recover the completion order from the persisted rows instead.
    const last =
      succeededOrder.at(-1) ??
      [...detail.nodes]
        .filter((row) => row.status === "succeeded")
        .sort((x, y) => (x.completedAt ?? "").localeCompare(y.completedAt ?? ""))
        .map((row) => row.nodeId)
        .at(-1);
    const startedAt = Date.parse(detail.startedAt);
    const completedAt = detail.completedAt !== null ? Date.parse(detail.completedAt) : NaN;
    const status =
      terminalStatus === "succeeded" ||
      terminalStatus === "failed" ||
      terminalStatus === "cancelled"
        ? terminalStatus
        : null;
    const runError = detail.error;
    return {
      runId,
      runStatus: status,
      error: status === "succeeded" ? null : (runError ?? `run ${terminalStatus}`),
      finalOutput: last !== undefined ? (nodeOutputs[last] ?? null) : null,
      nodeOutputs,
      durationMs:
        Number.isFinite(startedAt) && Number.isFinite(completedAt) ? completedAt - startedAt : null,
      tokens: sawUsage ? { input, output } : null,
      costUsd: await fetchRunCostUsd(opts.baseUrl, runId),
      // Null only for rows persisted before the definition-hash migration.
      definitionHash: detail.definitionHash,
    };
  };
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { WorkflowFrame } from "@keelson/shared";
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

interface RunDetailLoose {
  status?: unknown;
  error?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  definitionHash?: unknown;
  nodes?: unknown;
}

interface NodeRowLoose {
  nodeId?: unknown;
  status?: unknown;
  outputText?: unknown;
  completedAt?: unknown;
  usage?: unknown;
}

// Sum `costUsd` over the run's usage events when the server reports it; null
// (never 0) when the server predates pricing or no event carries a price.
export async function fetchRunCostUsd(baseUrl: string, runId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${normalizeBase(baseUrl)}/api/usage/events?window=24h&limit=500&runId=${encodeURIComponent(runId)}`,
      { headers: { accept: "application/json", origin: originHeader(baseUrl) } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return null;
    // The server prices per event and leaves `costUsd` null where it cannot;
    // one unpriced event makes the run unpriced rather than under-counted.
    let total = 0;
    let matched = 0;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      if ((row as { runId?: unknown }).runId !== runId) continue;
      matched++;
      const cost = (row as { costUsd?: unknown }).costUsd;
      if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
      total += cost;
    }
    return matched > 0 ? total : null;
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
    let detail: RunDetailLoose;
    try {
      const body = (await getRun(opts.baseUrl, runId)) as { run?: RunDetailLoose };
      detail = body.run ?? {};
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
    const rows = Array.isArray(detail.nodes) ? (detail.nodes as NodeRowLoose[]) : [];
    for (const row of rows) {
      if (typeof row.nodeId !== "string") continue;
      nodeOutputs[row.nodeId] = typeof row.outputText === "string" ? row.outputText : "";
      const usage = row.usage as { inputTokens?: unknown; outputTokens?: unknown } | null;
      if (
        usage &&
        typeof usage.inputTokens === "number" &&
        typeof usage.outputTokens === "number"
      ) {
        sawUsage = true;
        input += usage.inputTokens;
        output += usage.outputTokens;
      }
    }
    // A run that finished before the socket attached replays only run_done,
    // so recover the completion order from the persisted rows instead.
    const last =
      succeededOrder.at(-1) ??
      rows
        .filter((row) => row.status === "succeeded" && typeof row.nodeId === "string")
        .sort((x, y) => String(x.completedAt ?? "").localeCompare(String(y.completedAt ?? "")))
        .map((row) => row.nodeId as string)
        .at(-1);
    const startedAt = typeof detail.startedAt === "string" ? Date.parse(detail.startedAt) : NaN;
    const completedAt =
      typeof detail.completedAt === "string" ? Date.parse(detail.completedAt) : NaN;
    const status =
      terminalStatus === "succeeded" ||
      terminalStatus === "failed" ||
      terminalStatus === "cancelled"
        ? terminalStatus
        : null;
    const runError = typeof detail.error === "string" ? detail.error : null;
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
      definitionHash: typeof detail.definitionHash === "string" ? detail.definitionHash : null,
    };
  };
}

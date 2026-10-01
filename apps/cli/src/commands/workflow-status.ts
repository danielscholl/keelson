// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type RunTiming,
  runTiming,
  type WorkflowRunDetail,
  workflowRunDetailSchema,
} from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { formatReviewerAnswer, formatReviewLines } from "../format-approval.ts";
import {
  getRun,
  getWorkflow,
  HttpError,
  isServerDownError,
  listActiveRuns,
  listRunsByName,
  resolveRunRef,
} from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { gateSchemaSkew } from "../schema-gate.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowStatusOptions {
  json: boolean;
  baseUrl?: string;
  workflow?: string;
  brief?: boolean;
}

// Computed at read time from the run's node rows and the catalog's edges for
// the run's workflow; null when the workflow is gone or its node set no longer
// matches the run (runs persist no DAG snapshot). Never persisted.
async function timingFor(baseUrl: string, detail: WorkflowRunDetail): Promise<RunTiming | null> {
  let dag: Awaited<ReturnType<typeof getWorkflow>>;
  try {
    dag = await getWorkflow(baseUrl, detail.workflowName, detail.projectId);
  } catch {
    return null;
  }
  const ids = new Set(dag.nodes.map((node) => node.id));
  if (detail.nodes.some((row) => !ids.has(row.nodeId))) return null;
  const rows = new Map(detail.nodes.map((row) => [row.nodeId, row]));
  return runTiming(
    dag.nodes.map((node) => ({
      id: node.id,
      ...(node.dependsOn !== undefined ? { dependsOn: node.dependsOn } : {}),
      startedAt: rows.get(node.id)?.startedAt ?? null,
      completedAt: rows.get(node.id)?.completedAt ?? null,
    })),
  );
}

export async function runWorkflowStatus(
  runId: string | undefined,
  opts: WorkflowStatusOptions,
): Promise<never> {
  const info = opts.baseUrl ? null : await probeServer();
  const baseUrl = opts.baseUrl ?? info?.baseUrl;
  if (!baseUrl) {
    emit(
      {
        error: "workflow status requires a running server; start it with `keelson start` first",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }
  await gateSchemaSkew(baseUrl, info?.schemaVersion, opts.json);

  try {
    if (runId) {
      const resolved = await resolveRunRef(baseUrl, runId);
      if ("error" in resolved) {
        emit(
          { error: resolved.error, code: resolved.ambiguous ? "AMBIGUOUS_RUN_ID" : "NOT_FOUND" },
          { json: opts.json },
        );
        process.exit(resolved.ambiguous ? EXIT_BAD_ARGS : EXIT_NOT_FOUND);
      }
      const response = await getRun(baseUrl, resolved.runId);
      if (typeof response !== "object" || response === null || !("run" in response)) {
        throw new Error("workflow run response is missing run detail");
      }
      const detail = workflowRunDetailSchema.parse(response.run);
      const timing = await timingFor(baseUrl, detail);
      if (opts.brief) {
        const awaitingNode = detail.nodes.find((node) => node.status === "awaiting");
        emit(
          {
            data: {
              runId: detail.runId,
              workflowName: detail.workflowName,
              status: detail.status,
              startedAt: detail.startedAt,
              error: detail.error,
              workingDir: detail.workingDir,
              worktreePath: detail.worktreePath,
              isolationEnabled: detail.isolationEnabled,
              worktreeEstablished: detail.worktreeEstablished,
              definitionHash: detail.definitionHash,
              nodes: detail.nodes.map((node) => ({
                id: node.nodeId,
                status: node.status,
                ...(node.approval !== null ? { answeredBy: node.approval.answeredBy } : {}),
              })),
              gates: detail.nodes
                .map((node) => formatReviewerAnswer(node.nodeId, node.approval))
                .filter((line): line is string => line !== undefined),
              current: awaitingNode?.nodeId ?? null,
              awaiting:
                detail.status === "paused" && awaitingNode
                  ? {
                      nodeId: awaitingNode.nodeId,
                      ...(awaitingNode.approval !== null
                        ? { review: formatReviewLines(awaitingNode.approval) }
                        : {}),
                    }
                  : null,
              timing,
            },
          },
          { json: opts.json },
        );
        process.exit(EXIT_OK);
      }
      emit({ data: { ...response, timing } }, { json: opts.json });
      process.exit(EXIT_OK);
    }
    if (opts.workflow) {
      const runs = await listRunsByName(baseUrl, opts.workflow);
      emit({ data: runs }, { json: opts.json });
      process.exit(EXIT_OK);
    }
    // Membership here must match the MCP workflow_status listing, or the two
    // surfaces disagree about what is active.
    const runs = await listActiveRuns(baseUrl);
    if (!opts.json && runs.runs.length === 0) {
      emit({ data: "no active runs" }, { json: false });
      process.exit(EXIT_OK);
    }
    emit({ data: runs }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      emit({ error: err.message, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    if (isServerDownError(err)) {
      emit(
        { error: `server at ${baseUrl} is not reachable`, code: "NO_SERVER" },
        { json: opts.json },
      );
      process.exit(EXIT_NO_SERVER);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: message, code: "STATUS_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { workflowRunDetailSchema } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import {
  getRun,
  HttpError,
  isServerDownError,
  listPausedRuns,
  listRunsByName,
  resolveRunRef,
} from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowStatusOptions {
  json: boolean;
  baseUrl?: string;
  workflow?: string;
  brief?: boolean;
}

export async function runWorkflowStatus(
  runId: string | undefined,
  opts: WorkflowStatusOptions,
): Promise<never> {
  const baseUrl = opts.baseUrl ?? (await probeServer())?.baseUrl;
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
      if (opts.brief) {
        if (typeof response !== "object" || response === null || !("run" in response)) {
          throw new Error("workflow run response is missing run detail");
        }
        const detail = workflowRunDetailSchema.parse(response.run);
        const awaitingNode = detail.nodes.find((node) => node.status === "awaiting");
        emit(
          {
            data: {
              runId: detail.runId,
              workflowName: detail.workflowName,
              status: detail.status,
              startedAt: detail.startedAt,
              nodes: detail.nodes.map((node) => ({ id: node.nodeId, status: node.status })),
              current: awaitingNode?.nodeId ?? null,
              awaiting:
                detail.status === "paused" && awaitingNode ? { nodeId: awaitingNode.nodeId } : null,
            },
          },
          { json: opts.json },
        );
        process.exit(EXIT_OK);
      }
      emit({ data: response }, { json: opts.json });
      process.exit(EXIT_OK);
    }
    if (opts.workflow) {
      const runs = await listRunsByName(baseUrl, opts.workflow);
      emit({ data: runs }, { json: opts.json });
      process.exit(EXIT_OK);
    }
    // Default surface: paused runs (the only query the server exposes without
    // a workflow name). Operators reach here when checking "what's awaiting
    // input"; concrete-run views need an explicit --workflow or runId.
    const runs = await listPausedRuns(baseUrl);
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

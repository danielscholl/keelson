// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { HttpError, isServerDownError, resumeRun } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowRespondOptions {
  json: boolean;
  baseUrl?: string;
  /**
   * Per-pause token from the live `approval_awaiting` frame. Optional for
   * operator ergonomics — when omitted the server falls back to
   * "resolve whichever pause is currently open for this nodeId" (still
   * safe for approval nodes, but lets a stale retry hit the wrong
   * iteration of an interactive loop). Pass it via `--pause-id` when you
   * have it.
   */
  pauseId?: string;
}

// Resume a paused workflow run by POSTing { nodeId, text } to the same
// /api/workflows/runs/:runId/resume endpoint the SPA's approval composer
// uses. Designed for headless interactive-loop / approval flows: one
// terminal runs `workflow run --watch`, a second runs `workflow respond …`.
export async function runWorkflowRespond(
  runId: string,
  nodeId: string,
  text: string,
  opts: WorkflowRespondOptions,
): Promise<never> {
  const baseUrl = opts.baseUrl ?? (await probeServer())?.baseUrl;
  if (!baseUrl) {
    emit(
      {
        error: "workflow respond requires a running server; start it with `keelson service` first",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  try {
    await resumeRun(baseUrl, runId, {
      nodeId,
      text,
      ...(opts.pauseId !== undefined ? { pauseId: opts.pauseId } : {}),
    });
    emit({ data: { resumed: true, runId, nodeId } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      emit({ error: err.message, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    if (err instanceof HttpError && err.status === 409) {
      emit({ error: err.message, code: "NOT_PAUSED" }, { json: opts.json });
      process.exit(EXIT_FAIL);
    }
    if (isServerDownError(err)) {
      emit(
        { error: `server at ${baseUrl} is not reachable`, code: "NO_SERVER" },
        { json: opts.json },
      );
      process.exit(EXIT_NO_SERVER);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: message, code: "RESPOND_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
}

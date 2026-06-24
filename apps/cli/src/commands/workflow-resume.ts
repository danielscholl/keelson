// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { HttpError, isServerDownError, resolveRunRef, resumeInterruptedRun } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowResumeOptions {
  json: boolean;
  baseUrl?: string;
}

// Resume an interrupted (terminated) workflow run from the last completed node.
// The run must be in a terminal state (failed/cancelled) to be resumed.
export async function runWorkflowResume(
  runId: string,
  opts: WorkflowResumeOptions,
): Promise<never> {
  const baseUrl = opts.baseUrl ?? (await probeServer())?.baseUrl;
  if (!baseUrl) {
    emit(
      {
        error: "workflow resume requires a running server; start it with `keelson start` first",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  try {
    const resolved = await resolveRunRef(baseUrl, runId);
    if ("error" in resolved) {
      emit(
        { error: resolved.error, code: resolved.ambiguous ? "AMBIGUOUS_RUN_ID" : "NOT_FOUND" },
        { json: opts.json },
      );
      process.exit(resolved.ambiguous ? EXIT_FAIL : EXIT_NOT_FOUND);
    }
    await resumeInterruptedRun(baseUrl, resolved.runId);
    emit({ data: { resumed: true, runId: resolved.runId } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      emit({ error: err.message, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    if (err instanceof HttpError && err.status === 409) {
      emit({ error: err.message, code: "NOT_RESUMABLE" }, { json: opts.json });
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
    emit({ error: message, code: "RESUME_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import {
  getRun,
  HttpError,
  isServerDownError,
  listPausedRuns,
  listRunsByName,
} from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowStatusOptions {
  json: boolean;
  baseUrl?: string;
  workflow?: string;
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
      const run = await getRun(baseUrl, runId);
      emit({ data: run }, { json: opts.json });
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

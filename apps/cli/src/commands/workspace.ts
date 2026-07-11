// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_OK } from "../exit.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { listWorkspaceLeases } from "../http/workspace-client.ts";
import { emit } from "../output.ts";
import { defaultServerBaseUrl } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

function effectiveBaseUrl(opts: BaseOptions): string {
  return opts.baseUrl ?? defaultServerBaseUrl();
}

function noServer(opts: BaseOptions): never {
  emit(
    { error: "workspace commands require a running server (`keelson start`)", code: "NO_SERVER" },
    { json: opts.json },
  );
  process.exit(EXIT_NO_SERVER);
}

function failHttp(err: unknown, opts: BaseOptions, label: string): never {
  if (isServerDownError(err)) noServer(opts);
  if (err instanceof HttpError) {
    emit({ error: err.message, code: "REQUEST_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: `${label}: ${message}`, code: "REQUEST_FAILED" }, { json: opts.json });
  process.exit(EXIT_FAIL);
}

export async function runWorkspaceList(opts: BaseOptions): Promise<never> {
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const leases = await listWorkspaceLeases(baseUrl);
    emit({ data: { leases } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list workspace leases");
  }
}

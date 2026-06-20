// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ApprovalDecision } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { listApprovals, resolveApproval } from "../http/approvals-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
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
    { error: "approval commands require a running server (`keelson start`)", code: "NO_SERVER" },
    { json: opts.json },
  );
  process.exit(EXIT_NO_SERVER);
}

function failHttp(err: unknown, opts: BaseOptions, label: string): never {
  if (isServerDownError(err)) noServer(opts);
  if (err instanceof HttpError) {
    emit(
      {
        error: err.message,
        code:
          err.status === 404 ? "NOT_FOUND" : err.status === 400 ? "BAD_INPUTS" : "REQUEST_FAILED",
      },
      { json: opts.json },
    );
    process.exit(
      err.status === 404 ? EXIT_NOT_FOUND : err.status === 400 ? EXIT_BAD_ARGS : EXIT_FAIL,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: `${label}: ${message}`, code: "REQUEST_FAILED" }, { json: opts.json });
  process.exit(EXIT_FAIL);
}

export async function runApprovalList(opts: BaseOptions): Promise<never> {
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const approvals = await listApprovals(baseUrl);
    emit({ data: { approvals } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list approvals");
  }
}

function parseDecision(value: string, opts: BaseOptions): ApprovalDecision {
  const normalized = value.trim().toLowerCase();
  if (normalized === "accept" || normalized === "reject") return normalized;
  emit({ error: "decision must be 'accept' or 'reject'", code: "BAD_INPUTS" }, { json: opts.json });
  process.exit(EXIT_BAD_ARGS);
}

export async function runApprovalResolve(
  id: string,
  decision: string,
  opts: BaseOptions,
): Promise<never> {
  const trimmedId = id.trim();
  if (trimmedId.length === 0) {
    emit({ error: "approval id must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const parsed = parseDecision(decision, opts);
  const baseUrl = effectiveBaseUrl(opts);
  try {
    await resolveApproval(baseUrl, trimmedId, parsed);
    emit({ data: { id: trimmedId, decision: parsed } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "resolve approval");
  }
}

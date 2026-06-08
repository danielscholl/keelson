// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { RibSummary } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { listRibs } from "../http/ribs-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { DEFAULT_SERVER_BASE_URL } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

// Skip probeServer: the actual GET surfaces "connection refused" via
// isServerDownError at fewer round-trips (mirrors the project commands).
function effectiveBaseUrl(opts: BaseOptions): string {
  return opts.baseUrl ?? DEFAULT_SERVER_BASE_URL;
}

function noServer(opts: BaseOptions): never {
  emit(
    { error: "rib commands require `keelson serve` to be running", code: "NO_SERVER" },
    { json: opts.json },
  );
  process.exit(EXIT_NO_SERVER);
}

function failHttp(err: unknown, opts: BaseOptions, label: string): never {
  if (isServerDownError(err)) noServer(opts);
  if (err instanceof HttpError) {
    emit(
      { error: err.message, code: err.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED" },
      { json: opts.json },
    );
    process.exit(err.status === 404 ? EXIT_NOT_FOUND : EXIT_FAIL);
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: `${label}: ${message}`, code: "REQUEST_FAILED" }, { json: opts.json });
  process.exit(EXIT_FAIL);
}

function authLabel(rib: RibSummary): string {
  if (!rib.auth) return "n/a";
  return rib.auth.authenticated ? "authenticated" : "needs auth";
}

// One discovered rib at a glance: identity, the tools it brings, its surface
// tabs, and auth.
function toListItem(rib: RibSummary) {
  return {
    id: rib.id,
    displayName: rib.displayName,
    tools: rib.registered,
    surfaces: rib.surfaces.map((s) => s.id),
    auth: authLabel(rib),
  };
}

// Full detail for one rib: tools, canvas views, surfaces, whether it handles
// board actions, and auth.
function toShowItem(rib: RibSummary) {
  return {
    id: rib.id,
    displayName: rib.displayName,
    tools: rib.registered,
    views: rib.views.map((v) => v.key),
    surfaces: rib.surfaces.map((s) => ({ id: s.id, title: s.title })),
    handlesActions: rib.hasOnAction,
    auth: rib.auth ?? "n/a",
  };
}

export async function runRibList(opts: BaseOptions): Promise<never> {
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const ribs = await listRibs(baseUrl);
    emit({ data: { ribs: ribs.map(toListItem) } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list ribs");
  }
}

export async function runRibShow(id: string, opts: BaseOptions): Promise<never> {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    emit({ error: "rib id must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const rib = (await listRibs(baseUrl)).find((r) => r.id === trimmed);
    if (!rib) {
      emit({ error: `no rib named '${trimmed}'`, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    emit({ data: { rib: toShowItem(rib) } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "show rib");
  }
}

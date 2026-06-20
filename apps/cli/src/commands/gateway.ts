// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { UpsertGatewayBody } from "@keelson/shared/config";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { deleteGateway, listGateways, putGateway } from "../http/gateways-client.ts";
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
    { error: "gateway commands require a running server (`keelson start`)", code: "NO_SERVER" },
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

export async function runGatewayList(opts: BaseOptions): Promise<never> {
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const gateways = await listGateways(baseUrl);
    emit({ data: { gateways } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list gateways");
  }
}

export interface GatewayAddOptions extends BaseOptions {
  model?: string;
  key?: string;
  protocol?: string;
}

export async function runGatewayAdd(
  name: string,
  url: string,
  opts: GatewayAddOptions,
): Promise<never> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    emit({ error: "gateway name must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    emit({ error: "gateway baseUrl must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  // The key may also arrive via env so it stays out of shell history.
  const apiKey = opts.key ?? process.env.KEELSON_GATEWAY_KEY;
  const body: UpsertGatewayBody = {
    baseUrl: trimmedUrl,
    ...(opts.protocol ? { protocol: opts.protocol as UpsertGatewayBody["protocol"] } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const gateway = await putGateway(baseUrl, trimmedName, body);
    emit({ data: { gateway } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "add gateway");
  }
}

export async function runGatewayRemove(name: string, opts: BaseOptions): Promise<never> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    emit({ error: "gateway name must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const baseUrl = effectiveBaseUrl(opts);
  try {
    await deleteGateway(baseUrl, trimmed);
    emit({ data: { removed: trimmed } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "remove gateway");
  }
}

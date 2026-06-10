// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  probeServer as defaultProbeServer,
  type ProbeOptions,
  type ServerInfo,
} from "../server-probe.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

export type ProbeServer = (opts?: ProbeOptions) => Promise<ServerInfo | null>;

export interface ServerDeps {
  probeServer?: ProbeServer;
  baseUrl?: string;
}

export async function runServerCheck(deps: ServerDeps = {}): Promise<CategoryResult> {
  const probe = deps.probeServer ?? defaultProbeServer;
  const info = await probe(deps.baseUrl ? { baseUrl: deps.baseUrl } : {});

  const check: CheckResult = info
    ? {
        name: "GET /api/health",
        status: "ok",
        detail: `${info.name}${info.phase !== undefined ? ` phase ${info.phase}` : ""}, schema ${info.schemaVersion} @ ${info.baseUrl}`,
      }
    : {
        // Server-down is a warn, not a fail — the operator chooses when the
        // server runs. Headless `keelson workflow run …` works without it.
        name: "GET /api/health",
        status: "warn",
        detail: "not reachable",
        hint: "run `keelson serve start` to start the API server on http://127.0.0.1:7878",
      };

  return { category: "server", checks: [check] };
}

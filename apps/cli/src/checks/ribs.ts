// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { RibSummary } from "@keelson/shared";
import { listRibs as defaultListRibs } from "../http/ribs-client.ts";
import {
  probeServer as defaultProbeServer,
  type ProbeOptions,
  type ServerInfo,
} from "../server-probe.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

export type ProbeServer = (opts?: ProbeOptions) => Promise<ServerInfo | null>;
export type ListRibs = (baseUrl: string) => Promise<RibSummary[]>;

export interface RibsDeps {
  probeServer?: ProbeServer;
  listRibs?: ListRibs;
  baseUrl?: string;
}

export async function runRibsCheck(deps: RibsDeps = {}): Promise<CategoryResult> {
  const probe = deps.probeServer ?? defaultProbeServer;
  const listRibs = deps.listRibs ?? defaultListRibs;
  const info = await probe(deps.baseUrl ? { baseUrl: deps.baseUrl } : {});

  // Ribs only activate inside the server, so there's nothing to report when it's
  // down. Skip (not warn) — the server check already owns the single down warning.
  if (!info) {
    return {
      category: "ribs",
      checks: [
        {
          name: "rib readiness",
          status: "skip",
          detail: "server not running",
          hint: "run `keelson start`, then re-run doctor to probe rib readiness",
        },
      ],
    };
  }

  let ribs: RibSummary[];
  try {
    ribs = await listRibs(info.baseUrl);
  } catch (err) {
    return {
      category: "ribs",
      checks: [
        {
          name: "rib readiness",
          status: "warn",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  if (ribs.length === 0) {
    return {
      category: "ribs",
      checks: [{ name: "rib readiness", status: "skip", detail: "no ribs installed" }],
    };
  }

  // Not-ready is a warn, never a hard fail — installed-but-unready is the
  // operator's to resolve; a rib with no probe reports no readiness, so skip it.
  const checks: CheckResult[] = ribs.map((rib): CheckResult => {
    if (!rib.auth) {
      return { name: rib.displayName, status: "skip", detail: "no readiness probe" };
    }
    if (rib.auth.authenticated) {
      return {
        name: rib.displayName,
        status: "ok",
        ...(rib.auth.statusMessage ? { detail: rib.auth.statusMessage } : {}),
      };
    }
    return { name: rib.displayName, status: "warn", detail: rib.auth.statusMessage ?? "not ready" };
  });

  return { category: "ribs", checks };
}

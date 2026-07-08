// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isSchemaVersionCompatible, SCHEMA_VERSION } from "@keelson/shared";
import { EXIT_FAIL } from "./exit.ts";
import { emit } from "./output.ts";
import {
  probeServer as defaultProbeServer,
  type ProbeOptions,
  type ServerInfo,
} from "./server-probe.ts";

type ProbeFn = (opts?: ProbeOptions) => Promise<ServerInfo | null>;

export interface SchemaGateDeps {
  probeServer?: ProbeFn;
}

// The CLI strict-parses chat/workflow frames and fails the whole turn on the
// first frame it can't validate (chat-client.ts closes the WS with `1003 bad
// frame`). Against a server whose SCHEMA_VERSION differs, an additive change
// surfaces there — mid-stream, after work succeeded, with no pointer at the
// skew. Gating before the WS opens turns that into a fail-fast with a remedy.
//
// Returns the server's schema version when it differs from this build's, or
// null when they match or the server is unreachable — the caller's existing
// down-path owns the unreachable case. Reuses an already-probed version to
// avoid a second `/api/health` round-trip on the common (no `--base-url`) path.
export async function detectSchemaSkew(
  effectiveBase: string,
  knownServerVersion?: string,
  deps: SchemaGateDeps = {},
): Promise<string | null> {
  const probe = deps.probeServer ?? defaultProbeServer;
  const serverVersion =
    knownServerVersion ?? (await probe({ baseUrl: effectiveBase }))?.schemaVersion;
  if (serverVersion === undefined || isSchemaVersionCompatible(serverVersion)) return null;
  return serverVersion;
}

export function schemaSkewError(serverVersion: string): string {
  return `server schema version '${serverVersion}' does not match this CLI's '${SCHEMA_VERSION}'; run \`keelson update\`, then restart the server (\`keelson restart\`)`;
}

// Fail fast before the strict-parsing WS opens when the server's schema differs.
// Returns (so the caller proceeds) on a match or an unreachable server; exits
// EXIT_FAIL on skew. The single emit/exit site keeps the SCHEMA_SKEW code and
// exit semantics in one place across the chat and workflow-run commands.
export async function gateSchemaSkew(
  effectiveBase: string,
  knownServerVersion: string | undefined,
  json: boolean,
  deps: SchemaGateDeps = {},
): Promise<void> {
  const skew = await detectSchemaSkew(effectiveBase, knownServerVersion, deps);
  if (skew === null) return;
  emit({ error: schemaSkewError(skew), code: "SCHEMA_SKEW" }, { json });
  process.exit(EXIT_FAIL);
}

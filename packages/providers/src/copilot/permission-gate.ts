// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Builds the Copilot `onPermissionRequest` handler that enforces a workflow
// node's `allowed_tools` / `denied_tools` against the SDK's built-in tool
// permission requests. Custom/rib tools are projected with `skipPermission`, so
// they never reach this handler — only built-in capabilities (read / write /
// shell / url / memory) do, which is exactly the surface the rail must govern.

import type { CopilotPermissionHandler } from "./factory.ts";
import { type CopilotPermissionKind, GATED_KINDS, toolKind } from "./tool-names.ts";

export interface PermissionGateOptions {
  // The SDK's always-permit handler — delegated to for anything the rail allows.
  approveAll: CopilotPermissionHandler;
  // Node `allowed_tools` (Claude-style names). When set, only the capability
  // kinds these names map to are permitted; every other gated kind is denied.
  allowedTools?: readonly string[];
  // Node `denied_tools`. The capability kinds these map to are always denied.
  disallowedTools?: readonly string[];
}

function readKind(request: unknown): string | undefined {
  if (!request || typeof request !== "object") return undefined;
  const k = (request as Record<string, unknown>).kind;
  return typeof k === "string" ? k : undefined;
}

// Map a list of tool names to the set of GATED capability kinds they cover.
// Non-capability names (rib tools, unknowns) contribute nothing — an allowlist
// of only rib tools therefore yields an empty set, which fail-closes every
// built-in capability (the model is left with just its filtered rib tools).
function gatedKindsOf(names: readonly string[]): Set<CopilotPermissionKind> {
  const out = new Set<CopilotPermissionKind>();
  for (const name of names) {
    const kind = toolKind(name);
    if (kind !== undefined && GATED_KINDS.has(kind)) out.add(kind);
  }
  return out;
}

export function buildPermissionGate(opts: PermissionGateOptions): CopilotPermissionHandler {
  const { approveAll, allowedTools, disallowedTools } = opts;
  const allowedKinds = allowedTools === undefined ? undefined : gatedKindsOf(allowedTools);
  const deniedKinds = disallowedTools === undefined ? undefined : gatedKindsOf(disallowedTools);

  return (request: unknown, invocation: unknown) => {
    const kind = readKind(request);
    // Non-capability requests (custom-tool / mcp / hook / unrecognized) bypass
    // the rail — rib tools are gated upstream, not here.
    if (kind === undefined || !GATED_KINDS.has(kind as CopilotPermissionKind)) {
      return approveAll(request, invocation);
    }
    const capKind = kind as CopilotPermissionKind;
    if (deniedKinds?.has(capKind)) {
      return { kind: "reject", feedback: `'${capKind}' tools are denied for this workflow node.` };
    }
    if (allowedKinds !== undefined && !allowedKinds.has(capKind)) {
      return {
        kind: "reject",
        feedback: `'${capKind}' tools are not in this workflow node's allow-list.`,
      };
    }
    return approveAll(request, invocation);
  };
}

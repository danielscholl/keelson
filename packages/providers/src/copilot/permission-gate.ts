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
//
// When an `evaluateToolCall` gate is wired, those same built-in capabilities are
// ALSO run through the unified policy engine (mapped to a canonical tool name):
// a deny — including a rejected/timed-out ASK — becomes a reject, while an allow
// still defers to the SDK's own consent prompt, so policy gating and user
// consent stay independent. The handler stays synchronous when no gate is wired
// (the rail-only path) and returns a promise only when it must await the engine.

import { checkToolCallGate } from "../tool-gate.ts";
import type { ToolCallGate } from "../types.ts";
import type { CopilotPermissionHandler } from "./factory.ts";
import {
  builtinToolNames,
  type CopilotPermissionKind,
  capabilityToolName,
  GATED_KINDS,
  toolKind,
} from "./tool-names.ts";

export interface PermissionGateOptions {
  // The SDK's always-permit handler — delegated to for anything the rail allows.
  approveAll: CopilotPermissionHandler;
  // Node `allowed_tools` (Claude-style names). When set, only the capability
  // kinds these names map to are permitted; every other gated kind is denied.
  allowedTools?: readonly string[];
  // Node `denied_tools`. The capability kinds these map to are always denied.
  disallowedTools?: readonly string[];
  // The unified policy engine's per-call gate. When set, a built-in capability
  // that clears the rail is evaluated by name through the engine before it runs.
  evaluateToolCall?: ToolCallGate;
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

export interface SessionToolFilter {
  availableTools?: string[];
  excludedTools?: string[];
}

// The same rail as a session tool filter, so the model is never offered a
// built-in the gate would reject. Custom (rib) tools are railed before they are
// projected, so an allow-list admits every one that reached the session.
export function buildSessionToolFilter(
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): SessionToolFilter {
  const builtins = (names: readonly string[]): string[] =>
    [...gatedKindsOf(names)].flatMap((kind) =>
      builtinToolNames(kind).map((name) => `builtin:${name}`),
    );
  const filter: SessionToolFilter = {};
  if (allowedTools !== undefined) {
    filter.availableTools = ["custom:*", ...builtins(allowedTools)];
  }
  if (disallowedTools !== undefined) {
    const excluded = builtins(disallowedTools);
    if (excluded.length > 0) filter.excludedTools = excluded;
  }
  return filter;
}

export function buildPermissionGate(opts: PermissionGateOptions): CopilotPermissionHandler {
  const { approveAll, allowedTools, disallowedTools, evaluateToolCall } = opts;
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
    // The capability cleared the rail; let the policy engine have its say. Async
    // only on this branch (the engine call) so the rail-only path stays sync.
    if (evaluateToolCall) {
      return gateCapability(evaluateToolCall, capKind, request, invocation, approveAll);
    }
    return approveAll(request, invocation);
  };
}

// Run one built-in capability through the policy engine by its canonical tool
// name. A deny (incl. a rejected/timed-out/aborted ASK, which the engine returns
// as a clean deny) rejects the SDK request with the policy's reason; an allow
// defers to the SDK's own consent prompt. A thrown gate fails OPEN to preserve
// the turn — matching checkToolCallGate's posture on the custom-tool path.
async function gateCapability(
  gate: ToolCallGate,
  capKind: CopilotPermissionKind,
  request: unknown,
  invocation: unknown,
  approveAll: CopilotPermissionHandler,
): Promise<unknown> {
  const result = await checkToolCallGate(gate, capabilityToolName(capKind), undefined);
  if (result.denied) {
    return { kind: "reject", feedback: result.message };
  }
  return approveAll(request, invocation);
}

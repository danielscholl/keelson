// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Projects per-node YAML hook matchers (workflowNodeHooksSchema shape) into
// the Claude Agent SDK's hook protocol, and builds the built-in policy-gate
// PreToolUse hook. Provider-private — only the claude path consumes the
// projected shape, so this module never touches `@keelson/workflows` or
// `@anthropic-ai/claude-agent-sdk` directly. Structural types keep the dep
// graph clean and let tests pass any compatible shape without runtime coupling.

import { checkToolCallGate } from "../tool-gate.ts";
import type { ToolCallGate } from "../types.ts";

// Structural mirror of `WorkflowHookMatcher` from
// packages/workflows/src/schema/hooks.ts. Loose `unknown` typing on `response`
// because the SDK takes whatever JSON-shaped object the matcher returns and
// interprets it per the hook protocol (`hookSpecificOutput`,
// `permissionDecision`, `systemMessage`, etc.) — projecting it would just
// duplicate the SDK's contract.
export interface YAMLHookMatcher {
  matcher?: string;
  response: Record<string, unknown>;
  timeout?: number;
}

// Structural mirror of the SDK's `HookCallbackMatcher`. The `hooks` field is
// an array of async callbacks; on a real hook fire, the SDK calls each with
// the tool-use payload and uses the returned value as the hook output.
// Our projection ignores the payload and returns the canned YAML `response`.
export interface SDKHookCallbackMatcher {
  matcher?: string;
  hooks: Array<(input: unknown) => Promise<unknown>>;
  timeout?: number;
}

export type SDKHooksMap = Record<string, SDKHookCallbackMatcher[]>;

// Convert a `Record<event, YAMLHookMatcher[]>` (vendored workflow schema
// shape) into the SDK's matcher array layout. Falsy / empty event entries
// drop out so the caller can pass a Partial<WorkflowNodeHooks> without
// pre-filtering.
export function buildSDKHooksFromYAML(
  nodeHooks: Readonly<Record<string, YAMLHookMatcher[] | undefined>>,
): SDKHooksMap {
  const sdkHooks: SDKHooksMap = {};
  for (const [event, matchers] of Object.entries(nodeHooks)) {
    if (!matchers || matchers.length === 0) continue;
    sdkHooks[event] = matchers.map((m) => {
      const out: SDKHookCallbackMatcher = {
        // Each YAML matcher gets a single SDK hook that ignores its input
        // and returns the canned response — the SDK does the actual
        // semantic interpretation (permissionDecision / additionalContext /
        // systemMessage / hookSpecificOutput).
        hooks: [async (): Promise<unknown> => m.response],
      };
      if (m.matcher !== undefined) out.matcher = m.matcher;
      if (m.timeout !== undefined) out.timeout = m.timeout;
      return out;
    });
  }
  return sdkHooks;
}

// Merge two SDK hook maps. Per-event matcher arrays concatenate — `first`
// runs before `second`. Used by the factory to combine user-supplied
// per-node hooks (from YAML) with built-in capture hooks (if any). Pure
// projection — no mutation of either input.
export function mergeSDKHooks(
  first: SDKHooksMap | undefined,
  second: SDKHooksMap | undefined,
): SDKHooksMap | undefined {
  if (!first && !second) return undefined;
  if (!first) return second;
  if (!second) return first;
  const out: SDKHooksMap = {};
  const events = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const event of events) {
    const a = first[event] ?? [];
    const b = second[event] ?? [];
    out[event] = [...a, ...b];
  }
  return out;
}

// Built-in capability gate as a PreToolUse hook — the seam where the policy
// engine reaches Claude's own Bash/Edit/Write/Read, which run in the CLI
// subprocess and bypass `runClaudeToolHandler`. PreToolUse fires under
// `bypassPermissions` (the SDK's `canUseTool` does not), which is what makes
// this work; `mcp__*` names are skipped because the tool handler already gates
// them and double-gating would double-ASK.
export function buildBuiltinToolGateHooks(gate: ToolCallGate): SDKHooksMap {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: unknown): Promise<unknown> => {
            const toolName = readToolName(input);
            if (toolName === undefined) {
              // A PreToolUse payload with no readable tool_name shouldn't happen.
              // Fail open (don't wedge every turn) but warn so the gap is visible
              // rather than a silent bypass — matching checkToolCallGate's posture.
              console.warn("[policy] claude PreToolUse hook: missing tool_name; allowing");
              return {};
            }
            // mcp__* names are gated in runClaudeToolHandler — skip to avoid double-ASK.
            if (toolName.startsWith("mcp__")) return {};
            const result = await checkToolCallGate(gate, toolName, readToolInput(input));
            if (result.denied) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: result.message,
                },
              };
            }
            return {};
          },
        ],
      },
    ],
  };
}

// SDK PreToolUse payload carries `tool_name` (string) and `tool_input` (object).
function readToolName(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const name = (input as Record<string, unknown>).tool_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function readToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined;
  return (input as Record<string, unknown>).tool_input;
}

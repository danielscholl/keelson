// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Projects per-node YAML hook matchers into the Copilot SDK's native
// SessionHooks (onPreToolUse / onPostToolUse). Only those two events map cleanly
// onto Copilot's protocol; the SDK injects a returned `additionalContext` /
// `permissionDecision` itself, so no manual session-loop rewiring is needed.
// The remaining ~18 YAML hook events stay claude-only (surfaced as a warning by
// the workflow loader / prompt handler).

import type { YAMLHookMatcher } from "../claude/hooks-projection.ts";
import { type CopilotPermissionKind, toolKind, toolKindForInvocation } from "./tool-names.ts";

// Structural mirror of the SDK's onPreToolUse return (PreToolUseHookOutput).
export interface CopilotPreToolUseOutput {
  permissionDecision?: "allow" | "deny" | "ask";
  additionalContext?: string;
}

// Structural mirror of the SDK's onPostToolUse return (PostToolUseHookOutput).
export interface CopilotPostToolUseOutput {
  additionalContext?: string;
}

export interface CopilotSessionHooks {
  onPreToolUse?: (input: {
    toolName: string;
    toolArgs?: unknown;
  }) => CopilotPreToolUseOutput | undefined;
  onPostToolUse?: (input: {
    toolName: string;
    toolArgs?: unknown;
  }) => CopilotPostToolUseOutput | undefined;
}

// A YAML matcher fires when it matches the executing tool. Claude hook matchers
// are usually tool names, often alternated ("Write|Edit"); compare each
// alternative by capability kind so a Claude-style matcher aligns with Copilot's
// built-in name ("str_replace_editor"). `toolKind` is the invocation's
// already-resolved capability (args-aware for multi-mode tools). An empty/absent
// matcher matches everything; anything that isn't a known tool name falls back
// to a regex over the raw tool name.
function matcherMatches(
  matcher: string | undefined,
  toolName: string,
  invocationKind: CopilotPermissionKind | undefined,
): boolean {
  if (matcher === undefined || matcher === "") return true;
  if (invocationKind !== undefined) {
    for (const alt of matcher.split("|")) {
      if (toolKind(alt.trim()) === invocationKind) return true;
    }
  }
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

// Pull the injectable context out of a canned hook response. Claude carries it
// as `additionalContext` or `systemMessage`, either flat or nested under
// `hookSpecificOutput`; Copilot's hook output only has `additionalContext`, so
// every Claude shape collapses onto it.
function extractAdditionalContext(response: Record<string, unknown>): string | undefined {
  const nested = response.hookSpecificOutput;
  return (
    readString(response, "additionalContext") ??
    readString(nested, "additionalContext") ??
    readString(response, "systemMessage") ??
    readString(nested, "systemMessage")
  );
}

// Detect a deny verdict across the Claude response shapes
// ({decision:"block"}, {permissionDecision:"deny"}, or nested under
// hookSpecificOutput).
function isDeny(response: Record<string, unknown>): boolean {
  if (response.decision === "block") return true;
  if (response.permissionDecision === "deny") return true;
  const nested = response.hookSpecificOutput;
  if (nested && typeof nested === "object") {
    if ((nested as Record<string, unknown>).permissionDecision === "deny") return true;
  }
  return false;
}

export function buildCopilotSessionHooks(
  nodeHooks: Readonly<Record<string, YAMLHookMatcher[] | undefined>>,
): CopilotSessionHooks | undefined {
  const pre = nodeHooks.PreToolUse;
  const post = nodeHooks.PostToolUse;
  const hooks: CopilotSessionHooks = {};

  if (pre && pre.length > 0) {
    hooks.onPreToolUse = (input) => {
      const kind = toolKindForInvocation(input.toolName, input.toolArgs);
      const out: CopilotPreToolUseOutput = {};
      for (const m of pre) {
        if (!matcherMatches(m.matcher, input.toolName, kind)) continue;
        if (isDeny(m.response)) out.permissionDecision = "deny";
        const ctx = extractAdditionalContext(m.response);
        if (ctx !== undefined) {
          out.additionalContext =
            out.additionalContext === undefined ? ctx : `${out.additionalContext}\n\n${ctx}`;
        }
      }
      return out.permissionDecision !== undefined || out.additionalContext !== undefined
        ? out
        : undefined;
    };
  }

  if (post && post.length > 0) {
    hooks.onPostToolUse = (input) => {
      const kind = toolKindForInvocation(input.toolName, input.toolArgs);
      const contexts: string[] = [];
      for (const m of post) {
        if (!matcherMatches(m.matcher, input.toolName, kind)) continue;
        const ctx = extractAdditionalContext(m.response);
        if (ctx !== undefined) contexts.push(ctx);
      }
      return contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : undefined;
    };
  }

  if (hooks.onPreToolUse === undefined && hooks.onPostToolUse === undefined) return undefined;
  return hooks;
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolCallGate, ToolResultGate } from "./types.ts";

// Shared by every provider's custom-tool handler (Claude / Copilot / pi): runs
// the server-wired per-call policy gate against a tool call's validated args
// before the tool executes, turning a `deny` into the error text the model sees
// in place of the tool's output. Centralized so the deny wording and the
// fail-open defaults stay identical across providers (each still emits that text
// in its own SDK-specific error shape). Read defensively and inside the try: a
// gate that throws OR resolves to a malformed/missing decision is treated as
// allow-and-warn, so a gate fault can never wedge a turn — matching the engine's
// own per-policy containment and the projection seams' posture.
export async function checkToolCallGate(
  gate: ToolCallGate | undefined,
  tool: string,
  args: unknown,
): Promise<{ denied: false } | { denied: true; message: string }> {
  if (gate === undefined) return { denied: false };
  try {
    const decision = (await gate({ tool, ...(args !== undefined ? { args } : {}) })) as
      | { outcome?: unknown; reason?: unknown }
      | null
      | undefined;
    if (decision?.outcome === "deny") {
      // Coerce a missing/empty reason so a `{outcome:"deny"}` still reads as a
      // deny rather than "...denied by policy: undefined".
      const reason =
        typeof decision.reason === "string" && decision.reason.length > 0
          ? decision.reason
          : "denied";
      return { denied: true, message: `Tool '${tool}' denied by policy: ${reason}` };
    }
    if (decision?.outcome !== "allow") {
      // Malformed/missing decision → allow (fail open), but warn so a broken gate
      // is a visible diagnostic, not a silent enforcement bypass — matching the
      // engine's posture and the throw path below.
      console.warn(`[policy] tool-call gate returned a malformed decision for '${tool}'; allowing`);
    }
    return { denied: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[policy] tool-call gate threw for '${tool}': ${msg}; allowing`);
    return { denied: false };
  }
}

// Shared by every provider's custom-tool handler: runs the server-wired
// per-result policy gate against a tool's captured output AFTER `execute`
// returns but before that output reaches the model. Returns the (possibly
// rewritten) result the provider should hand back:
//   - deny           → the reason text, marked as an error (the model sees why
//                      the result was withheld, not the result).
//   - allow + data   → the substituted text (redaction), preserving isError.
//   - allow / absent → the original content, unchanged.
// Read defensively and inside the try, exactly like checkToolCallGate: a gate
// that throws OR resolves to a malformed decision passes the result through
// unchanged (fail open) and warns, so a gate fault can never wedge a turn.
export async function applyToolResultGate(
  gate: ToolResultGate | undefined,
  tool: string,
  content: string,
  isError: boolean,
): Promise<{ content: string; isError: boolean }> {
  if (gate === undefined) return { content, isError };
  try {
    const decision = (await gate({ tool, result: content })) as
      | { outcome?: unknown; reason?: unknown; data?: unknown }
      | null
      | undefined;
    if (decision?.outcome === "deny") {
      const reason =
        typeof decision.reason === "string" && decision.reason.length > 0
          ? decision.reason
          : "withheld";
      return { content: `Tool '${tool}' result withheld by policy: ${reason}`, isError: true };
    }
    if (decision?.outcome === "allow") {
      // Substitute only on a string `data` — a non-string substitution can't
      // replace text the model reads as a result, so pass the original through.
      if (typeof decision.data === "string") return { content: decision.data, isError };
      return { content, isError };
    }
    // Malformed/missing decision → pass through (fail open), but warn so a broken
    // gate is a visible diagnostic, matching checkToolCallGate's posture.
    console.warn(`[policy] tool-result gate returned a malformed decision for '${tool}'; allowing`);
    return { content, isError };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[policy] tool-result gate threw for '${tool}': ${msg}; allowing`);
    return { content, isError };
  }
}

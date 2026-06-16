// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolCallGate } from "./types.ts";

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
    // allow, or any malformed/null result → not denied (fail open).
    return { denied: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[policy] tool-call gate threw for '${tool}': ${msg}; allowing`);
    return { denied: false };
  }
}

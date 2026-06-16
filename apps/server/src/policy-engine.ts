// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  Policy,
  PolicyContext,
  PolicyDecision,
  PolicyEvent,
  PolicySurface,
} from "@keelson/shared";

// A rib-contributed policy tagged with the rib that supplied it, so the engine
// can namespace its id and a denial can be traced back to its owner.
export interface RibPolicyContribution {
  readonly ribId: string;
  readonly policy: Policy;
}

export interface PolicyEngineOptions {
  // Operator denylist floor (DEFAULT_TOOL_DENYLIST + KEELSON_WORKFLOW_TOOL_DENYLIST),
  // folded into a single builtin `tool_denylist` policy so there's one source of truth.
  denylist?: readonly string[];
  // Rib-declared policies, collected at activation (see Rib.contributePolicies).
  ribPolicies?: readonly RibPolicyContribution[];
}

export interface ToolProjection<T> {
  // Candidates that survived every policy, order-preserved.
  readonly allowed: T[];
  // Candidates dropped, with the deciding policy's reason (for logging/telemetry).
  readonly denied: readonly { tool: string; reason: string }[];
}

// The per-call decision the engine emits: allow, or deny-with-reason. `ask` has
// no approval round-trip yet (Phase 3), so the engine normalizes it to deny
// here — callers never see an `ask` and so never have to handle one.
export type ToolCallDecision = { outcome: "allow" } | { outcome: "deny"; reason: string };

export interface PolicyEngine {
  // Projection-time tool gate: evaluate a synthetic `tool_call` event per
  // candidate (no args yet) and drop any whose first matching policy returns
  // deny — or ask, which has no round-trip at projection time and degrades to
  // a deny-with-reason. Order: builtin floor first, then rib-declared;
  // first-deny-wins so a future session tier prepends without reordering.
  projectTools<T extends { name: string }>(
    candidates: readonly T[],
    base: { surface: PolicySurface; ribId?: string; provider?: string },
  ): Promise<ToolProjection<T>>;
  // Per-call tool gate: the same ordered stack and first-deny-wins semantics as
  // projectTools, but for ONE call with its (validated) args. Providers invoke
  // it inside their custom-tool handler before the tool executes; a `deny`
  // short-circuits the call. Tools cleared at projection can still be denied
  // here on the strength of their args — the whole point of the per-call gate.
  evaluateToolCall(
    call: { tool: string; args?: unknown },
    base: { surface: PolicySurface; ribId?: string; provider?: string },
  ): Promise<ToolCallDecision>;
}

// Does a policy's `on` matcher select this event? An absent matcher means the
// policy self-selects (always consulted); the engine then trusts evaluate to
// no-op via `allow` for phases it doesn't care about.
function matches(policy: Policy, event: PolicyEvent): boolean {
  if (policy.on === undefined) return true;
  return policy.on.some(
    (m) =>
      m.phase === event.phase &&
      (m.tool === undefined || (event.phase === "tool_call" && m.tool === event.tool)),
  );
}

// The operator denylist as a Policy — the existing name-based filter, now one
// source of truth. `id` is fixed so the floor is identifiable in logs.
function makeDenylistPolicy(denylist: readonly string[]): Policy {
  const denied = new Set(denylist);
  return {
    id: "builtin:tool_denylist",
    on: [{ phase: "tool_call" }],
    evaluate(event): PolicyDecision {
      if (event.phase === "tool_call" && denied.has(event.tool)) {
        return { outcome: "deny", reason: "denylisted by operator floor" };
      }
      return { outcome: "allow" };
    },
  };
}

// Run the ordered policy stack against one event; first-deny-wins. Returns
// `allow` when no matching policy denies, else `deny` with the deciding
// policy's reason (an `ask` is degraded here — no round-trip exists yet).
// Shared by projectTools (per candidate, no args) and evaluateToolCall (one
// call, with args) so the precedence, ask-degradation, and fail-open-per-policy
// behavior can't drift between the projection and per-call seams.
async function evaluateStack(
  ordered: readonly { id: string; policy: Policy }[],
  event: PolicyEvent,
  ctx: PolicyContext,
): Promise<ToolCallDecision> {
  // tool_call events carry the tool name; other phases label by phase.
  const label = event.phase === "tool_call" ? event.tool : event.phase;
  for (const entry of ordered) {
    // `matches`, `evaluate`, AND the decision dispatch all live inside the try:
    // a rib's `on` matcher or evaluate body can throw, and a single bad policy
    // must never crash the turn — it is skipped (contributes no opinion), so the
    // tool is allowed unless another policy denies it, while the floor and other
    // policies still apply. `await` (not `instanceof Promise`) so a foreign
    // thenable returned by evaluate resolves too.
    try {
      if (!matches(entry.policy, event)) continue;
      // Read defensively: a JS rib (or a TS rib without noImplicitReturns) can
      // return null/undefined or an unknown outcome. A malformed decision is a
      // no-op (allow) + a warning, never a crash (which would reject the caller
      // and fail the gate open) or a silent fail-open.
      const decision = (await entry.policy.evaluate(event, ctx)) as
        | { outcome?: unknown; reason?: unknown }
        | null
        | undefined;
      const outcome = decision?.outcome;
      const reason = decision?.reason;
      if (outcome === "deny") {
        // Coerce a missing/empty reason so a `{outcome:"deny"}` still denies
        // rather than degrading to a reasonless (and so droppable) allow.
        return {
          outcome: "deny",
          reason: typeof reason === "string" && reason.length > 0 ? reason : "denied",
        };
      }
      if (outcome === "ask") {
        // No approval round-trip yet — degrade to deny so the call is withheld.
        // Warn because an author's ASK silently becoming a deny is surprising
        // until Phase 3 wires the real pause.
        const why = typeof reason === "string" && reason.length > 0 ? reason : "approval required";
        console.warn(
          `[policy] '${entry.id}' asked for approval on '${label}'; withheld (no approval round-trip yet)`,
        );
        return { outcome: "deny", reason: `requires approval (deferred): ${why}` };
      }
      if (outcome !== "allow") {
        // An unrecognized/malformed outcome is treated as allow (like a throw)
        // but warned, so it isn't a silent fail-open.
        console.warn(
          `[policy] '${entry.id}' returned an unrecognized decision for '${label}'; treating as allow`,
        );
      }
    } catch (err) {
      // Contain the failure to THIS policy: it contributes no opinion, so the
      // tool is allowed unless another policy denies it.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[policy] '${entry.id}' threw evaluating '${label}': ${msg}`);
    }
  }
  return { outcome: "allow" };
}

export function createPolicyEngine(opts: PolicyEngineOptions = {}): PolicyEngine {
  // Builtin floor first, then rib-declared — first-deny-wins. Rib ids are
  // namespaced so two ribs' identically-named policies stay distinguishable.
  const ordered: { id: string; policy: Policy }[] = [
    { id: "builtin:tool_denylist", policy: makeDenylistPolicy(opts.denylist ?? []) },
    ...(opts.ribPolicies ?? []).map((c) => ({
      id: `rib:${c.ribId}:${c.policy.id}`,
      policy: c.policy,
    })),
  ];

  const makeCtx = (base: { surface: PolicySurface; ribId?: string }): PolicyContext => ({
    surface: base.surface,
    ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
  });

  const toolCallEvent = (
    tool: string,
    base: { ribId?: string; provider?: string },
    args?: unknown,
  ): PolicyEvent => ({
    phase: "tool_call",
    tool,
    ...(args !== undefined ? { args } : {}),
    ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
    ...(base.provider !== undefined ? { provider: base.provider } : {}),
  });

  return {
    async projectTools(candidates, base) {
      const ctx = makeCtx(base);
      const allowed: (typeof candidates)[number][] = [];
      const denied: { tool: string; reason: string }[] = [];
      for (const candidate of candidates) {
        const decision = await evaluateStack(ordered, toolCallEvent(candidate.name, base), ctx);
        if (decision.outcome === "deny") {
          denied.push({ tool: candidate.name, reason: decision.reason });
        } else {
          allowed.push(candidate);
        }
      }
      return { allowed, denied };
    },

    async evaluateToolCall(call, base) {
      return evaluateStack(ordered, toolCallEvent(call.tool, base, call.args), makeCtx(base));
    },
  };
}

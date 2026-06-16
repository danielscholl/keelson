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

  return {
    async projectTools(candidates, base) {
      const ctx: PolicyContext = {
        surface: base.surface,
        ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
      };
      const allowed: (typeof candidates)[number][] = [];
      const denied: { tool: string; reason: string }[] = [];

      for (const candidate of candidates) {
        const event: PolicyEvent = {
          phase: "tool_call",
          tool: candidate.name,
          ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
          ...(base.provider !== undefined ? { provider: base.provider } : {}),
        };
        let drop: string | undefined;
        for (const entry of ordered) {
          let decision: PolicyDecision;
          // `matches` and `evaluate` are both inside the try: a rib's `on`
          // matcher or evaluate body can throw on malformed input, and a single
          // bad policy must never crash the turn. `await` (not `instanceof
          // Promise`) so a foreign thenable returned by evaluate resolves too.
          try {
            if (!matches(entry.policy, event)) continue;
            decision = await entry.policy.evaluate(event, ctx);
          } catch (err) {
            // Fail closed for THIS policy only: it contributes no opinion (allow).
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[policy] '${entry.id}' threw evaluating '${candidate.name}': ${msg}`);
            continue;
          }
          if (decision.outcome === "deny") {
            drop = decision.reason;
            break;
          }
          if (decision.outcome === "ask") {
            // No approval round-trip at projection time — degrade to deny so the
            // tool is withheld. Warn because an author's ASK silently becoming a
            // drop is surprising until Phase 2 wires the real pause.
            drop = `requires approval (deferred): ${decision.reason}`;
            console.warn(
              `[policy] '${entry.id}' asked for approval on '${candidate.name}'; withheld (no approval round-trip yet)`,
            );
            break;
          }
        }
        if (drop === undefined) allowed.push(candidate);
        else denied.push({ tool: candidate.name, reason: drop });
      }

      return { allowed, denied };
    },
  };
}

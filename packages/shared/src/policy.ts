// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

/**
 * Policy — Keelson's unified governance contract.
 *
 * A `Policy` is evaluated at well-defined hook points across every turn path
 * (chat agent, workflow `prompt` nodes, rib agent turns) and returns one of
 * three outcomes: `allow` (no opinion — proceed), `deny` (short-circuit), or
 * `ask` (pause for human approval). Ribs contribute policies through the
 * `Rib.contributePolicies?` hook the same way they contribute workflows; the
 * harness composes them with its own builtins behind a single engine.
 *
 * This file is the CONTRACT only — types, no engine. The engine that composes
 * and evaluates the policy stack lives in the server (apps/server), mirroring
 * the split between `ToolDefinition` (here) and the tool registry
 * (`@keelson/skills`). Decisions are produced in-process; the only thing that
 * crosses the wire is the redacted `PendingApprovalView` an `ask` surfaces for
 * a human to resolve, so that — and only that — carries a zod schema.
 *
 * The `tool_call` phase is honored at two seams: PROJECTION time (which tools
 * are offered to the model, by name — no call arguments, so `args` is
 * undefined) and PER-CALL (one call with its validated `args`). At projection an
 * `ask` lets the tool through so it can be asked for when actually called; the
 * per-call seam runs the round-trip (pause → accept→allow, reject/timeout→deny).
 * With no approval channel wired, an `ask` degrades to deny-with-reason at both
 * seams. The other phases are declared for the request/response hooks later
 * phases wire in.
 */

// Which turn surface triggered evaluation. Lets a policy scope itself (e.g.
// "only gate rib turns") without the engine pre-filtering by surface.
export type PolicySurface = "chat" | "workflow" | "rib";

export type PolicyDecision =
  // `data` is reserved for a future content-substitution/redaction outcome; an
  // allow today means "no opinion" — it never silences a provider's own consent
  // prompt, so policy gating and user consent stay independent.
  | { outcome: "allow"; data?: unknown }
  // The agent receives `reason` as a tool error (or the tool is dropped from the
  // projection in Phase 1).
  | { outcome: "deny"; reason: string }
  // Pause for human approval: accept -> allow, else (reject/timeout/abort) ->
  // deny. Resolved per-call through the approval round-trip; with no channel
  // wired it degrades to deny-with-reason.
  | { outcome: "ask"; reason: string };

export type PolicyEvent =
  | { phase: "tool_call"; tool: string; args?: unknown; ribId?: string; provider?: string }
  | { phase: "tool_result"; tool: string; result: unknown }
  | { phase: "request"; prompt: string }
  | { phase: "response"; text: string };

// The cost signal a budget policy reads to apply downgrade-gate semantics: at
// the ceiling, deny only while on an expensive model. A subset of `ModelInfo`
// (chat.ts), restated here so the policy contract doesn't depend on the chat
// module.
export interface ModelCostHint {
  readonly costTier?: "free" | "low" | "mid" | "high";
  readonly billing?: "metered" | "subscription";
}

// Accumulated spend for the current session (a chat conversation or a workflow
// run), summed by the seam from persisted per-turn usage so a budget policy can
// gate on cumulative cost without the engine reaching into a store.
export interface SessionUsage {
  // input + output tokens across the session so far.
  readonly totalTokens: number;
  // Model-calling turns/nodes completed in the session so far.
  readonly turns: number;
}

// Per-evaluation context handed to every policy alongside the event. The
// `tool_call` seams populate only `surface`/`ribId`/`provider`; the `request`
// seam additionally carries `model` and `usage` so a budget policy can gate
// cumulative spend. `evaluate`'s signature stays fixed across phases.
export interface PolicyContext {
  readonly surface: PolicySurface;
  readonly ribId?: string;
  // The provider id backing the turn under evaluation, when known.
  readonly provider?: string;
  // The model about to run, reduced to its cost signal — present at the
  // `request` seam for downgrade-gate budget policies.
  readonly model?: ModelCostHint;
  // Accumulated session spend — present at the `request` seam for budget gating.
  readonly usage?: SessionUsage;
}

export interface Policy {
  // Stable identifier for logging / precedence. Harness builtins use a
  // `builtin:` prefix; rib-contributed policies are namespaced by the harness.
  id: string;
  // Optional matcher — when set, the policy is only consulted for events whose
  // `phase` (and `tool`, when given) match. Omitted means the policy
  // self-selects inside `evaluate`.
  on?: { phase: PolicyEvent["phase"]; tool?: string }[];
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
}

// ── ASK approval round-trip ──────────────────────────────────────────────────
// An `ask` outcome pauses the turn until a human accepts or rejects. The engine
// opens a pending approval through an injected channel; the server's registry
// surfaces it over the snapshot WS (POLICY_APPROVALS_SNAPSHOT_KEY) and resolves
// it from POST /api/approvals/:id.

export type ApprovalDecision = "accept" | "reject";
export const approvalDecisionSchema = z.enum(["accept", "reject"]);

// What an `ask` carries to the approval channel — enough for a human to judge
// the call without exposing tool args (which can hold secrets). The engine fills
// this from the matching event + context; the registry stamps it into a view.
export interface ApprovalRequest {
  surface: PolicySurface;
  // The deciding policy's namespaced engine id (e.g. `builtin:ask_on_shell`).
  policyId: string;
  reason: string;
  tool?: string;
  ribId?: string;
  provider?: string;
}

// The pending approval as published over the snapshot WS and returned by
// GET /api/approvals — the request plus the registry's id and open timestamp.
// Deliberately omits tool `args`: the snapshot is broadcast to every subscriber.
export const pendingApprovalViewSchema = z
  .object({
    id: z.string().min(1),
    surface: z.enum(["chat", "workflow", "rib"]),
    policyId: z.string().min(1),
    reason: z.string(),
    tool: z.string().optional(),
    ribId: z.string().optional(),
    provider: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PendingApprovalView = z.infer<typeof pendingApprovalViewSchema>;

// Snapshot payload: the list of currently-open approvals, newest last.
export const policyApprovalsSnapshotSchema = z.array(pendingApprovalViewSchema);
export type PolicyApprovalsSnapshot = z.infer<typeof policyApprovalsSnapshotSchema>;

export const POLICY_APPROVALS_SNAPSHOT_KEY = "keelson:policy:approvals";

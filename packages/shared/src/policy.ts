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
 * seams.
 *
 * The `tool_result` phase is evaluated PROVIDER-SIDE, after a keelson tool's
 * `execute` returns but before the result reaches the model — inside each
 * provider's custom-tool handler (Claude / Copilot / pi). It gates what the
 * model actually consumes, not the UI echo. `deny` replaces the result with the
 * reason; an `allow` carrying a string `data` substitutes that text for the
 * result (redaction). Built-in SDK tools (the agent's own Bash/Edit/Write) run
 * outside this handler and are out of scope here.
 *
 * The `response` phase is evaluated where the full turn text is BUFFERED before
 * it becomes a downstream source of truth — today the workflow `prompt` node's
 * assembled output. It governs the node's OUTPUT: the value `$nodeId.output`
 * resolves to in dependent nodes, and the recorded output. `deny` fails the
 * node; an `allow` with string `data` substitutes that output. It does NOT
 * retract the node's already-streamed transcript — like the chat and rib
 * streaming seams (where the text reaches the human as it streams), a whole-text
 * verdict can't claw back what already streamed; those seams wire no `response`
 * gate at all.
 *
 * An `ask` on `tool_result` / `response` has no round-trip (the work already
 * ran) and degrades to deny-with-reason.
 */

// Which turn surface triggered evaluation. Lets a policy scope itself (e.g.
// "only gate rib turns") without the engine pre-filtering by surface. `mcp` is
// the gateway exposing tools to external MCP clients.
export type PolicySurface = "chat" | "workflow" | "rib" | "mcp";

export type PolicyDecision =
  // On `tool_result` / `response`, an allow carrying a string `data` SUBSTITUTES
  // that text for the result/response the model (or a downstream node) sees —
  // the redaction outcome. On `tool_call`, allow means "no opinion" (`data` is
  // ignored): it never silences a provider's own consent prompt, so policy
  // gating and user consent stay independent. `data` stays `unknown` so a future
  // structured phase can substitute non-text payloads; the text phases apply it
  // only when it's a string.
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
  // The turn's working directory, used by path-scoping policies to resolve
  // relative tool args.
  readonly cwd?: string;
  // Confined directories for this turn; absent or empty means the turn is
  // unconfined.
  readonly allowedDirectories?: readonly string[];
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
//
// When more than one policy returns `ask` for a single event, the engine
// coalesces them into ONE prompt (first-ask-wins): the first accepted ask
// clears the call and later asks are not re-prompted; any reject denies.

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
    surface: z.enum(["chat", "workflow", "rib", "mcp"]),
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

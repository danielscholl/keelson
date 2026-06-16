// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

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
 * (`@keelson/skills`). Kept as pure TS types because Phase 1 decisions are
 * produced in-process, never deserialized over the wire.
 *
 * Phase 1 honors only the `tool_call` phase, and only at PROJECTION time (which
 * tools are offered to the model, by name — no call arguments yet, so `args` is
 * undefined). An `ask` decision has no round-trip channel at projection time and
 * degrades to a deny-with-reason there; the other phases are declared for the
 * per-call and request/response hooks that later phases wire in.
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
  // Pause for human approval: accept -> allow, else -> deny. No round-trip exists
  // at projection time, so Phase 1 treats this as deny-with-reason.
  | { outcome: "ask"; reason: string };

export type PolicyEvent =
  | { phase: "tool_call"; tool: string; args?: unknown; ribId?: string; provider?: string }
  | { phase: "tool_result"; tool: string; result: unknown }
  | { phase: "request"; prompt: string }
  | { phase: "response"; text: string };

// Per-evaluation context handed to every policy alongside the event. Minimal in
// Phase 1; later phases extend it (session id, accumulated turn usage, abort
// signal) without changing the `evaluate` signature.
export interface PolicyContext {
  readonly surface: PolicySurface;
  readonly ribId?: string;
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

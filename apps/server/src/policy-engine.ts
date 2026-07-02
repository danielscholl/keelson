// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ModelCostHint,
  Policy,
  PolicyContext,
  PolicyDecision,
  PolicyEvent,
  PolicySurface,
  SessionUsage,
} from "@keelson/shared";
import safeRegex from "safe-regex2";
import { canonicalPath, isPathInside } from "./projects-store.ts";

// A rib-contributed policy tagged with the rib that supplied it, so the engine
// can namespace its id and a denial can be traced back to its owner.
export interface RibPolicyContribution {
  readonly ribId: string;
  readonly policy: Policy;
}

interface PolicyScopeBase {
  surface: PolicySurface;
  ribId?: string;
  targetRibId?: string;
  provider?: string;
  cwd?: string;
  allowedDirectories?: readonly string[];
}

export interface PolicyEngineOptions {
  // Operator denylist floor (DEFAULT_TOOL_DENYLIST + KEELSON_WORKFLOW_TOOL_DENYLIST),
  // folded into a single builtin `tool_denylist` policy so there's one source of truth.
  denylist?: readonly string[];
  // Rib-declared policies, collected at activation (see Rib.contributePolicies).
  ribPolicies?: readonly RibPolicyContribution[];
  // Opt-in `ask_on_shell` builtin: ASK before any keelson tool call whose name
  // denotes a shell or file-mutating action. Off by default (an unprompted
  // floor would surprise). Operator-toggled via KEELSON_ASK_ON_SHELL.
  askOnShell?: boolean;
  // Opt-in `turn_budget` builtin: cap model-calling turns per session. A
  // positive ceiling enables it; at the ceiling it denies a turn only while on
  // an expensive model (downgrade-gate, see `isExpensiveModel`). Operator-set
  // via KEELSON_TURN_BUDGET.
  turnBudget?: number;
  // Opt-in `cost_budget` builtin: cap accumulated input+output tokens per
  // session, same downgrade-gate semantics as `turnBudget`. Operator-set via
  // KEELSON_COST_BUDGET.
  costBudget?: number;
  // Opt-in `redact` builtin: a regex whose matches are replaced with [REDACTED]
  // in every `tool_result` and `response` text before the model (or a downstream
  // workflow node) consumes it. Off by default — an unset/blank/invalid pattern
  // leaves it off. Operator-set via KEELSON_REDACT_PATTERN.
  redactPattern?: string;
  // The approval round-trip an `ask` decision rides. When wired, a per-call
  // `ask` pauses here until this resolves accept/reject; when absent, `ask`
  // degrades to deny-with-reason (the pre-Phase-3 behavior). Injected by the
  // composition root from the server's ApprovalRegistry.
  requestApproval?: (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
}

export interface ToolProjection<T> {
  // Candidates that survived every policy, order-preserved.
  readonly allowed: T[];
  // Candidates dropped, with the deciding policy's reason (for logging/telemetry).
  readonly denied: readonly { tool: string; reason: string }[];
}

// The per-call decision the engine emits: allow, or deny-with-reason. An `ask`
// is resolved INSIDE the engine via the approval round-trip (accept→allow,
// reject/timeout→deny) — callers never see an `ask` and so never have to handle
// one. Providers' ToolCallGate mirrors this allow/deny shape.
export type ToolCallDecision = { outcome: "allow" } | { outcome: "deny"; reason: string };

// The per-result/response decision the engine emits. Like ToolCallDecision but
// an allow can carry a string `data` SUBSTITUTION — the redacted text that
// replaces the result/response the model (or a downstream node) sees. An `ask`
// is resolved INSIDE the engine (degraded to deny — a result that already ran
// has no round-trip), so callers never see one. Providers' ToolResultGate
// mirrors this shape.
export type ResultDecision =
  | { outcome: "allow"; data?: string }
  | { outcome: "deny"; reason: string };

export interface PolicyEngine {
  // Projection-time tool gate: evaluate a synthetic `tool_call` event per
  // candidate (no args yet) and drop any whose first matching policy returns
  // deny. An `ask` lets the tool THROUGH projection (so the per-call seam can
  // ask when it's actually called) when an approval channel is wired, and
  // degrades to deny-with-reason when none is. Order: builtin floor first, then
  // rib-declared; first-deny-wins so a future session tier prepends.
  projectTools<T extends { name: string }>(
    candidates: readonly T[],
    base: PolicyScopeBase,
  ): Promise<ToolProjection<T>>;
  // Per-call tool gate: the same ordered stack and first-deny-wins semantics as
  // projectTools, but for ONE call with its (validated) args. Providers invoke
  // it inside their custom-tool handler before the tool executes; a `deny`
  // short-circuits the call. Tools cleared at projection can still be denied
  // here on the strength of their args. An `ask` pauses for human approval via
  // the round-trip (accept→allow, reject/timeout→deny). `signal` cancels a
  // pending approval when the turn is torn down (→ deny).
  evaluateToolCall(
    call: { tool: string; args?: unknown },
    base: PolicyScopeBase & { signal?: AbortSignal },
  ): Promise<ToolCallDecision>;
  // Request-phase gate: evaluate the stack once before a turn runs, carrying the
  // session's accumulated `usage` and the about-to-run `model`. Backs the budget
  // builtins (deny when over a ceiling on an expensive model). A rib request-phase
  // policy that returns `ask` rides the same round-trip as the per-call seam.
  evaluateRequest(base: {
    surface: PolicySurface;
    ribId?: string;
    provider?: string;
    model?: ModelCostHint;
    usage?: SessionUsage;
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<ToolCallDecision>;
  // True when at least one policy in the stack can match a `request` event (a
  // budget builtin, or a self-selecting rib policy). Lets a seam skip the
  // request gate — and the model-tier / usage lookups it needs — entirely when
  // nothing would consult them.
  readonly requestPhaseActive: boolean;
  // Result-phase gate: evaluate the stack against ONE tool result, after the
  // tool ran but before the result returns to the model. Walks the same ordered
  // stack with first-deny-wins, but an `allow` carrying a string `data`
  // substitutes the result and FEEDS the substituted text to later policies (a
  // redaction pipeline). Providers invoke it inside their custom-tool handler.
  evaluateToolResult(
    call: { tool: string; result: unknown },
    base: PolicyScopeBase,
  ): Promise<ResultDecision>;
  // Response-phase gate: same stack walk as evaluateToolResult, for a turn's
  // complete buffered response text (today the workflow `prompt` node output). A
  // deny fails the consumer; a string-`data` allow substitutes the text.
  evaluateResponse(base: {
    surface: PolicySurface;
    ribId?: string;
    provider?: string;
    cwd?: string;
    allowedDirectories?: readonly string[];
    text: string;
  }): Promise<ResultDecision>;
  // True when at least one policy can match a `tool_result` event. Lets a seam
  // skip wiring the per-result gate into the provider when nothing consumes it.
  readonly resultPhaseActive: boolean;
  // True when at least one policy can match a `response` event. Lets a seam skip
  // the response gate (and assembling/buffering text for it) when nothing reads
  // the phase.
  readonly responsePhaseActive: boolean;
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

const CONFINE_PATH_KEYS = new Set(["file_path", "path", "notebook_path"]);

function expandConfinedPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return resolve(homedir());
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(cwd, trimmed);
}

function looksLikeFilesystemPath(token: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return false;
  if (/^[^/\s@]+@[^/\s:]+:[^/\s]+$/.test(token)) return false;
  return (
    isAbsolute(token) ||
    token.startsWith("~") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

function stripShellWrapping(token: string): string {
  return token.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>,;]+$/, "");
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      if (quote !== "'") {
        escaping = true;
        continue;
      }
      current += ch;
      continue;
    }
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function collectCommandTokenPathCandidates(token: string, out: string[]): void {
  const clean = stripShellWrapping(token);
  if (clean.length === 0) return;
  // Split on shell redirect operators (optional fd number) so an inline no-space
  // `ok.txt>/etc/passwd` exposes the target — anchoring to the token start let it escape.
  const redirectSegments = clean.split(/(?:\d+)?(?:>>?|<<?)/);
  if (redirectSegments.length > 1) {
    for (const segment of redirectSegments) {
      const part = stripShellWrapping(segment);
      if (part.length > 0 && looksLikeFilesystemPath(part)) out.push(part);
    }
    return;
  }
  const eq = clean.indexOf("=");
  if (eq > 0) {
    const left = stripShellWrapping(clean.slice(0, eq));
    const right = stripShellWrapping(clean.slice(eq + 1));
    if (left.length > 0 && looksLikeFilesystemPath(left)) out.push(left);
    if (right.length > 0 && looksLikeFilesystemPath(right)) out.push(right);
    return;
  }
  if (looksLikeFilesystemPath(clean)) out.push(clean);
}

function collectPathCandidates(value: unknown, key?: string, out: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return out;
    if (key !== undefined && CONFINE_PATH_KEYS.has(key)) {
      out.push(trimmed);
      return out;
    }
    if (key === "command") {
      for (const token of tokenizeShellCommand(trimmed)) {
        collectCommandTokenPathCandidates(token, out);
      }
      return out;
    }
    if (looksLikeFilesystemPath(trimmed)) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidates(item, undefined, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      collectPathCandidates(childValue, childKey, out);
    }
  }
  return out;
}

function makePathConfinementPolicy(): Policy {
  return {
    id: "builtin:path_confinement",
    on: [{ phase: "tool_call" }],
    evaluate(event, ctx): PolicyDecision {
      if (event.phase !== "tool_call") return { outcome: "allow" };
      if (!ctx.allowedDirectories || ctx.allowedDirectories.length === 0)
        return { outcome: "allow" };
      if (event.args === undefined || event.args === null) return { outcome: "allow" };

      const cwd = ctx.cwd ?? process.cwd();
      // Canonicalize (realpath) both sides so a symlink inside an allowed root
      // that points outside can't be traversed to escape confinement.
      const roots = ctx.allowedDirectories.map((root) =>
        canonicalPath(expandConfinedPath(root, cwd)),
      );
      for (const candidate of collectPathCandidates(event.args, undefined)) {
        const resolved = canonicalPath(expandConfinedPath(candidate, cwd));
        const confined = roots.some((root) => isPathInside(root, resolved));
        if (!confined) {
          return {
            outcome: "deny",
            reason: `path '${candidate}' resolves outside the confinement root`,
          };
        }
      }
      return { outcome: "allow" };
    },
  };
}

// Tool names that denote a shell or file-mutating action. These match keelson
// MCP/rib/workflow tool calls AND the canonical names a provider's built-in
// capabilities map to (shell→Bash, write→Write). Copilot routes its built-in
// permission requests through this engine, and the claude provider's PreToolUse
// hook calls the same gate, so `ask_on_shell` gates the agent's own shell/file
// writes whichever provider runs the turn.
const ASK_ON_SHELL_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "shell",
  "shell_exec",
  "exec",
  "run_shell",
]);

// Opt-in `ask_on_shell` builtin — ASK before any tool call whose name is in the
// shell/file-mutating set above. Returns `ask`, which the engine resolves via
// the approval round-trip (or degrades to deny when no channel is wired).
function makeAskOnShellPolicy(): Policy {
  return {
    id: "builtin:ask_on_shell",
    on: [{ phase: "tool_call" }],
    evaluate(event): PolicyDecision {
      if (event.phase === "tool_call" && ASK_ON_SHELL_TOOLS.has(event.tool)) {
        return { outcome: "ask", reason: `'${event.tool}' runs shell or file-mutating actions` };
      }
      return { outcome: "allow" };
    },
  };
}

// Is the about-to-run model expensive enough that a reached budget should deny?
// The downgrade-gate's whole point is to push spend onto a cheaper model, not to
// kill the session — so a flat-rate subscription login (no marginal token cost)
// is the safe fallback we never gate, while a premium tier or a metered (real
// per-token money) login is. An unknown model fails closed: honor the cap.
function isExpensiveModel(model: ModelCostHint | undefined): boolean {
  if (model?.billing === "subscription") return false;
  if (model?.costTier === "mid" || model?.costTier === "high") return true;
  if (model?.billing === "metered") return true;
  if (model?.costTier === "free" || model?.costTier === "low") return false;
  return true;
}

// Opt-in budget builtins — request-phase policies that deny a turn once the
// session's accumulated turns/tokens reach the ceiling, but ONLY while on an
// expensive model (so the user can keep going by switching to a cheaper one).
// Under the ceiling, or on a cheap/subscription model, they're a no-op.
function makeTurnBudgetPolicy(maxTurns: number): Policy {
  return {
    id: "builtin:turn_budget",
    on: [{ phase: "request" }],
    evaluate(event, ctx): PolicyDecision {
      if (event.phase !== "request") return { outcome: "allow" };
      if ((ctx.usage?.turns ?? 0) < maxTurns) return { outcome: "allow" };
      if (!isExpensiveModel(ctx.model)) return { outcome: "allow" };
      return {
        outcome: "deny",
        reason: `session turn budget of ${maxTurns} reached; switch to a cheaper model to continue`,
      };
    },
  };
}

function makeCostBudgetPolicy(maxTokens: number): Policy {
  return {
    id: "builtin:cost_budget",
    on: [{ phase: "request" }],
    evaluate(event, ctx): PolicyDecision {
      if (event.phase !== "request") return { outcome: "allow" };
      if ((ctx.usage?.totalTokens ?? 0) < maxTokens) return { outcome: "allow" };
      if (!isExpensiveModel(ctx.model)) return { outcome: "allow" };
      return {
        outcome: "deny",
        reason: `session token budget of ${maxTokens} reached; switch to a cheaper model to continue`,
      };
    },
  };
}

// Opt-in `redact` builtin — replaces every match of `pattern` with [REDACTED]
// in a `tool_result` / `response` text and returns it as an allow-with-`data`
// substitution. `pattern` must carry the global flag so `.replace` redacts all
// matches (createPolicyEngine compiles it that way). A non-string result (or no
// match) is a no-op allow.
function makeRedactPolicy(pattern: RegExp): Policy {
  return {
    id: "builtin:redact",
    on: [{ phase: "tool_result" }, { phase: "response" }],
    evaluate(event): PolicyDecision {
      let text: string | undefined;
      if (event.phase === "tool_result") {
        text = typeof event.result === "string" ? event.result : undefined;
      } else if (event.phase === "response") {
        text = event.text;
      }
      if (text === undefined) return { outcome: "allow" };
      const redacted = text.replace(pattern, "[REDACTED]");
      return redacted === text ? { outcome: "allow" } : { outcome: "allow", data: redacted };
    },
  };
}

// How an `ask` outcome is resolved for this seam. Returns "allow" to KEEP
// evaluating the stack (the policy approved or — at projection — deferred to the
// per-call seam) and `{ deny }` to short-circuit. Lets projection and per-call
// interpret `ask` differently without forking the stack walk.
type AskResolver = (ask: {
  policyId: string;
  reason: string;
  tool?: string;
}) => Promise<"allow" | { deny: string }>;

// Run the ordered policy stack against one event; first-deny-wins. Returns
// `allow` when no matching policy denies, else `deny` with the deciding
// policy's reason. An `ask` is handed to `onAsk` (the seam decides whether to
// round-trip, defer, or degrade). Shared by projectTools (per candidate, no
// args) and evaluateToolCall (one call, with args) so precedence and
// fail-open-per-policy behavior can't drift between the two seams.
async function evaluateStack(
  ordered: readonly { id: string; policy: Policy }[],
  event: PolicyEvent,
  ctx: PolicyContext,
  onAsk: AskResolver,
): Promise<ToolCallDecision> {
  // tool_call events carry the tool name; other phases label by phase.
  const label = event.phase === "tool_call" ? event.tool : event.phase;
  // ASK dedup (first-ask-wins): once one policy's ask is approved for THIS
  // event, a later policy's ask is coalesced into that single decision instead
  // of opening a second prompt for the same call. A reject still short-circuits
  // below, so this only suppresses redundant prompts on the accept path.
  let askApproved = false;
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
        // Already approved by an earlier ask on this event — don't re-prompt.
        if (askApproved) continue;
        const why = typeof reason === "string" && reason.length > 0 ? reason : "approval required";
        const resolved = await onAsk({
          policyId: entry.id,
          reason: why,
          ...(event.phase === "tool_call" ? { tool: event.tool } : {}),
        });
        // `{ deny }` short-circuits; "allow" means accepted (or, at projection,
        // deferred to the per-call seam) so a LATER policy can still deny.
        if (resolved !== "allow") {
          return { outcome: "deny", reason: resolved.deny };
        }
        askApproved = true;
        continue;
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

// Run the ordered stack against a result/response event, CHAINING string `data`
// substitutions: each policy sees the (possibly already-redacted) text from the
// prior one, and the final accumulated text is returned as the substitution.
// First-deny-wins short-circuits; an `ask` degrades to deny (a result/response
// that already ran has no approval round-trip). Per-policy try/catch containment
// matches evaluateStack — a single throwing policy contributes no opinion.
async function evaluateResultStack(
  ordered: readonly { id: string; policy: Policy }[],
  makeEvent: (text: string) => PolicyEvent,
  originalText: string,
  ctx: PolicyContext,
): Promise<ResultDecision> {
  let current = originalText;
  for (const entry of ordered) {
    const event = makeEvent(current);
    const label = event.phase;
    try {
      if (!matches(entry.policy, event)) continue;
      const decision = (await entry.policy.evaluate(event, ctx)) as
        | { outcome?: unknown; reason?: unknown; data?: unknown }
        | null
        | undefined;
      const outcome = decision?.outcome;
      const reason = decision?.reason;
      if (outcome === "deny") {
        return {
          outcome: "deny",
          reason: typeof reason === "string" && reason.length > 0 ? reason : "withheld",
        };
      }
      if (outcome === "ask") {
        // No round-trip for a result/response that already ran — fail closed.
        return {
          outcome: "deny",
          reason:
            typeof reason === "string" && reason.length > 0
              ? reason
              : "approval is not supported for this phase",
        };
      }
      if (outcome === "allow") {
        // Substitute only on a string `data`; feed it to later policies so
        // redactions compose. A non-string `data` is ignored (warned) — it can't
        // replace text the model reads, so the text passes through unchanged.
        if (decision?.data !== undefined && typeof decision.data !== "string") {
          console.warn(
            `[policy] '${entry.id}' returned a non-string substitution for '${label}'; ignoring`,
          );
        } else if (typeof decision?.data === "string") {
          current = decision.data;
        }
        continue;
      }
      // An unrecognized/malformed/missing outcome is treated as allow (like a
      // throw) but warned, so it isn't a silent fail-open — matching evaluateStack.
      console.warn(
        `[policy] '${entry.id}' returned an unrecognized decision for '${label}'; treating as allow`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[policy] '${entry.id}' threw evaluating '${label}': ${msg}`);
    }
  }
  return current === originalText ? { outcome: "allow" } : { outcome: "allow", data: current };
}

export function createPolicyEngine(opts: PolicyEngineOptions = {}): PolicyEngine {
  const requestApproval = opts.requestApproval;
  // Compile the opt-in `redact` builtin's pattern with the global flag (so
  // `.replace` redacts every match). A blank or invalid pattern leaves the
  // builtin off rather than crashing boot — a typo'd KEELSON_REDACT_PATTERN
  // shouldn't take the server down.
  const redactBuiltin: { id: string; policy: Policy } | undefined = (() => {
    const raw = opts.redactPattern;
    if (raw === undefined || raw.length === 0) return undefined;
    try {
      const compiled = new RegExp(raw, "g");
      // The builtin runs this against tool/response text an external system can
      // influence (a tool's fetched output, a model's reply), so a pattern with
      // catastrophic backtracking (ReDoS) could block the event loop. Reject it
      // up front — fail safe by disabling redaction with a warning, exactly like
      // an invalid pattern, rather than wedging the server later.
      if (!safeRegex(compiled)) {
        console.warn(
          "[policy] redact pattern risks catastrophic backtracking (ReDoS); redaction disabled",
        );
        return undefined;
      }
      return { id: "builtin:redact", policy: makeRedactPolicy(compiled) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[policy] invalid redact pattern; redaction disabled: ${msg}`);
      return undefined;
    }
  })();
  // Builtin floor first, then the opt-in ask_on_shell builtin, then rib-declared
  // — first-deny-wins. A denylisted shell tool is therefore denied (not asked),
  // and a rib policy can still deny a call ask_on_shell would have allowed. Rib
  // ids are namespaced so two ribs' identically-named policies stay distinct. The
  // redact builtin matches only the result/response phases, so its position
  // among the tool_call builtins is immaterial.
  const ordered: { id: string; policy: Policy }[] = [
    { id: "builtin:tool_denylist", policy: makeDenylistPolicy(opts.denylist ?? []) },
    { id: "builtin:path_confinement", policy: makePathConfinementPolicy() },
    ...(opts.askOnShell ? [{ id: "builtin:ask_on_shell", policy: makeAskOnShellPolicy() }] : []),
    ...(opts.turnBudget && opts.turnBudget > 0
      ? [{ id: "builtin:turn_budget", policy: makeTurnBudgetPolicy(opts.turnBudget) }]
      : []),
    ...(opts.costBudget && opts.costBudget > 0
      ? [{ id: "builtin:cost_budget", policy: makeCostBudgetPolicy(opts.costBudget) }]
      : []),
    ...(redactBuiltin ? [redactBuiltin] : []),
    ...(opts.ribPolicies ?? []).map((c) => ({
      id: `rib:${c.ribId}:${c.policy.id}`,
      policy: c.policy,
    })),
  ];

  // A policy can match a phase if it self-selects (no `on`) or lists that phase.
  // Precomputed per phase so a seam can skip its work — request usage/model
  // lookups, wiring the per-result provider gate, buffering response text — when
  // the stack holds nothing that would read the phase.
  const phaseActive = (phase: PolicyEvent["phase"]): boolean =>
    ordered.some(
      ({ policy }) =>
        policy.on === undefined ||
        (Array.isArray(policy.on) && policy.on.some((m) => m?.phase === phase)),
    );
  const requestPhaseActive = phaseActive("request");
  const resultPhaseActive = phaseActive("tool_result");
  const responsePhaseActive = phaseActive("response");

  // Projection seam: an `ask` lets the tool through (so the per-call seam can
  // ask when it's actually called) when a channel is wired; otherwise it
  // degrades to deny-with-reason — prompting once per offered tool would be
  // wrong, and a tool dropped here could never be asked for per-call.
  const projectionAsk: AskResolver = async ({ reason }) =>
    requestApproval ? "allow" : { deny: `requires approval (deferred): ${reason}` };

  // Per-call seam: run the real round-trip. accept→allow, reject/timeout/abort→
  // deny; with no channel wired, degrade to deny-with-reason. A throwing channel
  // fails closed (deny), never open.
  const perCallAsk =
    (base: PolicyScopeBase & { signal?: AbortSignal }): AskResolver =>
    async ({ policyId, reason, tool }) => {
      if (!requestApproval) return { deny: `requires approval (deferred): ${reason}` };
      try {
        const req: ApprovalRequest = {
          surface: base.surface,
          policyId,
          reason,
          ...(tool !== undefined ? { tool } : {}),
          ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
          ...(base.provider !== undefined ? { provider: base.provider } : {}),
        };
        const decision = await requestApproval(req, base.signal);
        return decision === "accept" ? "allow" : { deny: `approval rejected: ${reason}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[policy] approval channel threw for '${policyId}': ${msg}`);
        return { deny: `approval unavailable: ${reason}` };
      }
    };

  const makeCtx = (base: PolicyScopeBase): PolicyContext => ({
    surface: base.surface,
    ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
    ...(base.targetRibId !== undefined ? { targetRibId: base.targetRibId } : {}),
    ...(base.provider !== undefined ? { provider: base.provider } : {}),
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    ...(base.allowedDirectories !== undefined
      ? { allowedDirectories: base.allowedDirectories }
      : {}),
  });

  const toolCallEvent = (
    tool: string,
    base: Omit<PolicyScopeBase, "surface">,
    args?: unknown,
  ): PolicyEvent => ({
    phase: "tool_call",
    tool,
    ...(args !== undefined ? { args } : {}),
    ...(base.ribId !== undefined ? { ribId: base.ribId } : {}),
    ...(base.targetRibId !== undefined ? { targetRibId: base.targetRibId } : {}),
    ...(base.provider !== undefined ? { provider: base.provider } : {}),
  });

  return {
    async projectTools(candidates, base) {
      const ctx = makeCtx(base);
      const allowed: (typeof candidates)[number][] = [];
      const denied: { tool: string; reason: string }[] = [];
      for (const candidate of candidates) {
        const decision = await evaluateStack(
          ordered,
          toolCallEvent(candidate.name, base),
          ctx,
          projectionAsk,
        );
        if (decision.outcome === "deny") {
          denied.push({ tool: candidate.name, reason: decision.reason });
        } else {
          allowed.push(candidate);
        }
      }
      return { allowed, denied };
    },

    async evaluateToolCall(call, base) {
      return evaluateStack(
        ordered,
        toolCallEvent(call.tool, base, call.args),
        makeCtx(base),
        perCallAsk(base),
      );
    },

    requestPhaseActive,
    resultPhaseActive,
    responsePhaseActive,

    async evaluateRequest(base) {
      const ctx: PolicyContext = {
        ...makeCtx(base),
        ...(base.model !== undefined ? { model: base.model } : {}),
        ...(base.usage !== undefined ? { usage: base.usage } : {}),
      };
      return evaluateStack(
        ordered,
        { phase: "request", prompt: base.prompt ?? "" },
        ctx,
        perCallAsk(base),
      );
    },

    async evaluateToolResult(call, base) {
      return evaluateResultStack(
        ordered,
        (text) => ({ phase: "tool_result", tool: call.tool, result: text }),
        typeof call.result === "string" ? call.result : String(call.result),
        makeCtx(base),
      );
    },

    async evaluateResponse(base) {
      return evaluateResultStack(
        ordered,
        (text) => ({ phase: "response", text }),
        base.text,
        makeCtx(base),
      );
    },
  };
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { tmpdir } from "node:os";
import {
  getAgentProvider,
  getProviderInfoList,
  type IAgentProvider,
  isRegisteredProvider as registryHasProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import {
  coerceTokenUsage,
  type MessageChunk,
  type RibAgentTurn,
  type RibAgentTurnRequest,
  type RibAgentTurnResult,
  type TokenUsage,
  type ToolDefinition,
} from "@keelson/shared";
import { getRegisteredTools as liveRegisteredTools } from "@keelson/skills";
import { DEFAULT_TOOL_DENYLIST } from "@keelson/workflows";
import type { PolicyEngine } from "./policy-engine.ts";
import type { UsageStore } from "./usage-store.ts";

// Registry-routed `runAgentTurn` seam (packages/shared/src/rib.ts): resolve a
// provider the same way workflow `prompt` nodes do (req.provider hint →
// KEELSON_WORKFLOW_PROVIDER → first non-stub) and drive one turn through
// `IAgentProvider.sendQuery`, adapting its chunk stream into the settled
// `{ stream, result }` dual-handle. The result is the source of truth; the
// stream is derived from it (a rib that drains the stream then awaits the
// result — the room loop — sees the same settled outcome).
//
// Invariants the seam owns, not each rib:
//   - a turn never inherits the host repo cwd: an omitted `cwd` defaults
//     to a neutral non-repo directory;
//   - an empty/whitespace prompt is rejected with a clear seam-level error
//     rather than leaking the CLI's "Input must be provided" wording;
//   - provider routing honors configuration — `providerId` reflects the
//     provider actually used.

export interface MakeRibAgentTurnDeps {
  // Test seams: default to the live provider registry.
  getProvider?: (id: string) => IAgentProvider;
  isRegisteredProvider?: (id: string) => boolean;
  listProviderIds?: () => string[];
  // Neutral cwd for turns that don't pin one. Defaults to the OS temp dir so a
  // rib turn never runs in the server's (host repo) cwd.
  defaultCwd?: string;
  // Resolve a turn's requested tool NAMES to full registered tool defs so
  // permitted rib tools project to the provider. Defaults to the live
  // @keelson/skills registry.
  getRegisteredTools?: () => readonly ToolDefinition[];
  getToolOwner?: (name: string) => string | undefined;
  isTurnToolGranted?: (callerRibId: string, targetRibId: string, name: string) => boolean;
  // Operator denylist floor (KEELSON_WORKFLOW_TOOL_DENYLIST): names removed from
  // the projection even when requested, matching the workflow prompt path. Used
  // only on the no-engine fallback path; when `getPolicyEngine` resolves an
  // engine, that engine's `tool_denylist` builtin owns this floor instead.
  denylist?: readonly string[];
  // Lazy resolver for the unified policy engine. When it returns an engine, the
  // turn's projected tools are gated through it (denylist builtin + rib
  // policies, scoped to this rib's id); when absent (tests / boot race), the
  // local `denied` floor applies. Lazy because the engine is built after the
  // ribs that use it activate.
  getPolicyEngine?: () => PolicyEngine | undefined;
  // Lazy resolver for the usage ledger. When it returns a store, a turn that
  // carries real spend records a `rib`-sourced event on settle; undefined (or
  // no store returned) skips capture. Lazy for the same reason as
  // getPolicyEngine: the store is built by the composition root after the
  // ribs that use it activate.
  getUsageStore?: () => UsageStore | undefined;
}

interface ResolvedDeps {
  getProvider: (id: string) => IAgentProvider;
  hasProvider: (id: string) => boolean;
  listProviderIds: () => string[];
  neutralCwd: string;
  getRegisteredTools: () => readonly ToolDefinition[];
  denied: ReadonlySet<string>;
  getToolOwner?: (name: string) => string | undefined;
  isTurnToolGranted?: (callerRibId: string, targetRibId: string, name: string) => boolean;
  getPolicyEngine?: () => PolicyEngine | undefined;
  getUsageStore?: () => UsageStore | undefined;
}

export function makeRibAgentTurn(
  deps: MakeRibAgentTurnDeps = {},
): (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn {
  const resolved: ResolvedDeps = {
    getProvider: deps.getProvider ?? getAgentProvider,
    hasProvider: deps.isRegisteredProvider ?? registryHasProvider,
    listProviderIds: deps.listProviderIds ?? (() => getProviderInfoList().map((p) => p.id)),
    neutralCwd: deps.defaultCwd ?? tmpdir(),
    getRegisteredTools: deps.getRegisteredTools ?? (() => liveRegisteredTools()),
    // The shared operator floor (DEFAULT_TOOL_DENYLIST) always applies, plus the
    // env / injected denylist — so a tool the workflow path forbids can't slip
    // through a room turn even if DEFAULT_TOOL_DENYLIST gains entries later.
    denied: new Set([
      ...DEFAULT_TOOL_DENYLIST,
      ...(deps.denylist ?? parseToolDenylist(process.env.KEELSON_WORKFLOW_TOOL_DENYLIST)),
    ]),
    ...(deps.getToolOwner ? { getToolOwner: deps.getToolOwner } : {}),
    ...(deps.isTurnToolGranted ? { isTurnToolGranted: deps.isTurnToolGranted } : {}),
    ...(deps.getPolicyEngine ? { getPolicyEngine: deps.getPolicyEngine } : {}),
    ...(deps.getUsageStore ? { getUsageStore: deps.getUsageStore } : {}),
  };
  // `ribId` scopes the turn's tool gate: it rides the policy event so a rib
  // policy can govern its own (or another rib's) turn. Provider routing stays
  // global.
  return (ribId, req) => {
    const result = runTurn(resolved, req, ribId);
    return { result, stream: toStream(result) };
  };
}

// req.provider hint → KEELSON_WORKFLOW_PROVIDER → first registered non-stub
// (skipping the synthetic 'workflow' provider) → any non-'workflow' provider.
// A named-but-unregistered id is an error rather than a silent fallback so a
// misconfigured pin fails loudly.
function resolveProviderId(
  hint: string | undefined,
  deps: ResolvedDeps,
): { id: string } | { error: string } {
  const requested = hint?.trim();
  if (requested) {
    return deps.hasProvider(requested)
      ? { id: requested }
      : { error: `Provider '${requested}' is not registered.` };
  }
  const pinned = process.env.KEELSON_WORKFLOW_PROVIDER?.trim();
  if (pinned) {
    return deps.hasProvider(pinned)
      ? { id: pinned }
      : { error: `Provider '${pinned}' (KEELSON_WORKFLOW_PROVIDER) is not registered.` };
  }
  const ids = deps.listProviderIds();
  const real = ids.find((id) => id !== "stub" && id !== "workflow");
  if (real) return { id: real };
  const fallback = ids.find((id) => id !== "workflow");
  if (fallback) return { id: fallback };
  return { error: "no agent provider is registered" };
}

async function runTurn(
  deps: ResolvedDeps,
  req: RibAgentTurnRequest,
  ribId: string,
): Promise<RibAgentTurnResult> {
  // Reject an empty/whitespace prompt at the seam, before touching a
  // provider, so a transiently-empty prompt is a legible contract violation.
  if (!req.prompt || req.prompt.trim().length === 0) {
    return { status: "error", text: "", error: "prompt must be non-empty" };
  }
  if (req.abortSignal?.aborted) {
    return { status: "aborted", text: "" };
  }

  const resolved = resolveProviderId(req.provider, deps);
  if ("error" in resolved) {
    return { status: "error", text: "", error: resolved.error };
  }
  const providerId = resolved.id;

  let provider: IAgentProvider;
  try {
    provider = deps.getProvider(providerId);
  } catch (err) {
    return { status: "error", text: "", error: errMessage(err), providerId };
  }

  // Never inherit the server's (host repo) cwd; a turn that omits `cwd`
  // runs in the neutral directory.
  const cwd = req.cwd ?? deps.neutralCwd;

  // Combine the caller's abort signal with our own timeout so a turn honors
  // both `req.abortSignal` and `req.timeoutMs`.
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (req.abortSignal) {
    if (req.abortSignal.aborted) controller.abort();
    else req.abortSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer =
    req.timeoutMs && req.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, req.timeoutMs)
      : undefined;

  const options: SendQueryOptions = {
    abortSignal: controller.signal,
    ...(req.system ? { systemPrompt: req.system } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.allowedDirectories !== undefined ? { allowedDirectories: req.allowedDirectories } : {}),
    ...(await toolOptions(req, deps, { ribId, providerId }, cwd, controller.signal)),
  };

  let assistantText = "";
  let providerError: string | undefined;
  let turnUsage: TokenUsage | undefined;
  // Provider-reported served model (the `model` chunk), preferred over
  // req.model in the ledger row so an "auto"-style hint records what ran —
  // mirrors the chat and workflow-prompt seams.
  let resolvedModel: string | undefined;
  // Records a `rib`-sourced usage event (when the turn actually carried spend)
  // and folds `turnUsage` onto the settled result. Called from every return
  // point after `providerId` is known — mirrors the chat/workflow seams' "only
  // when the turn carried real spend" rule so a content-only or zero-total
  // turn doesn't add a row.
  const settle = (result: RibAgentTurnResult): RibAgentTurnResult => {
    if (turnUsage !== undefined && turnUsage.inputTokens + turnUsage.outputTokens > 0) {
      deps.getUsageStore?.()?.record({
        source: "rib",
        provider: providerId,
        model: resolvedModel ?? req.model ?? "unknown",
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        ...(turnUsage.cacheReadInputTokens !== undefined
          ? { cacheReadTokens: turnUsage.cacheReadInputTokens }
          : {}),
        ...(turnUsage.cacheCreationInputTokens !== undefined
          ? { cacheWriteTokens: turnUsage.cacheCreationInputTokens }
          : {}),
        status: result.status,
        ribId,
      });
    }
    return turnUsage !== undefined ? { ...result, usage: turnUsage } : result;
  };
  try {
    const stream = provider.sendQuery(req.prompt, cwd, req.resumeSessionId, options);
    for await (const chunk of stream) {
      if (controller.signal.aborted) break;
      if (chunk.type === "text") assistantText += chunk.content;
      else if (chunk.type === "error") providerError = chunk.message;
      else if (chunk.type === "usage") {
        const coerced = coerceTokenUsage(chunk.usage);
        if (coerced !== undefined) turnUsage = coerced;
      } else if (chunk.type === "model") {
        // Blank reports are ignored so they can't null out a real requested model.
        if (typeof chunk.model === "string" && chunk.model.trim().length > 0) {
          resolvedModel = chunk.model;
        }
      }
    }
  } catch (err) {
    if (timedOut)
      return settle({ status: "timeout", text: assistantText, error: errMessage(err), providerId });
    if (controller.signal.aborted || isAbortError(err)) {
      return settle({ status: "aborted", text: assistantText, providerId });
    }
    const msg = errMessage(err);
    return settle({
      status: /timed?\s*out|timeout/i.test(msg) ? "timeout" : "error",
      text: assistantText,
      error: msg,
      providerId,
    });
  } finally {
    if (timer) clearTimeout(timer);
    req.abortSignal?.removeEventListener("abort", onCallerAbort);
  }

  if (timedOut) return settle({ status: "timeout", text: assistantText, providerId });
  if (controller.signal.aborted)
    return settle({ status: "aborted", text: assistantText, providerId });
  if (providerError !== undefined) {
    return settle({ status: "error", text: assistantText, error: providerError, providerId });
  }

  // Response-phase policy gate on the COMPLETE assembled prose — the same
  // KEELSON_REDACT_PATTERN scrub the workflow `prompt` surface runs before its
  // output persists (prompt.ts). Without it a room turn's reply, which a rib
  // (chamber) writes to on-disk transcripts and broadcasts over snapshot WS,
  // escapes redaction even though rib tool results don't. Runs only on the
  // clean-completion path (skipped above on cancel/timeout/provider error). A
  // deny drops the text and fails the turn; an allow+data substitutes. Fail open
  // on a gate fault — a response-gate bug must not take the turn down.
  const engine = deps.getPolicyEngine?.();
  if (engine?.responsePhaseActive) {
    try {
      const decision = await engine.evaluateResponse({
        surface: "rib",
        ribId,
        provider: providerId,
        text: assistantText,
      });
      if (decision.outcome === "deny") {
        return settle({ status: "error", text: "", error: decision.reason, providerId });
      }
      if (typeof decision.data === "string") assistantText = decision.data;
    } catch (err) {
      console.warn(`[rib-agent-turn] response gate threw for rib '${ribId}': ${errMessage(err)}`);
    }
  }

  return settle({ status: "ok", text: assistantText, providerId });
}

// Map the request's tool rails onto SendQueryOptions:
// `tools`/`allowedTools` present (even empty) means "these and no others", and a
// turn with no tool fields at all is text-only (the room default — no Bash/Edit
// between turns), expressed as an empty allow-list. A `disallowedTools`-only
// request is a deny rail that leaves the rest of the catalog available.
//
// `req.tools` is a loose `{ name }[]`, so it contributes the allow-list by name.
// To make a named tool actually CALLABLE we resolve it against the live registry
// to its full validated def and forward those as `options.tools` (plus the
// catalog as `registeredMcpToolNames`) — the same projection workflow prompt
// nodes use. A requested name with no registered def (an SDK built-in like Read)
// resolves to nothing, so it stays allow-list-only and is never projected; the
// text-only and built-in rails are unchanged.
async function toolOptions(
  req: RibAgentTurnRequest,
  deps: ResolvedDeps,
  meta: { ribId: string; providerId: string },
  cwd: string,
  // The turn's teardown signal (caller abort + timeout), threaded into the
  // per-call gate so a pending `ask` cancels with the turn.
  signal?: AbortSignal,
): Promise<Partial<SendQueryOptions>> {
  const out: Partial<SendQueryOptions> = {};
  const engine = deps.getPolicyEngine?.();

  let allowedTools: string[] | undefined;
  if (req.allowedTools !== undefined) {
    allowedTools = [...req.allowedTools];
  } else if (req.tools !== undefined) {
    allowedTools = req.tools.map((t) => t.name);
  } else if (req.disallowedTools === undefined) {
    // text-only: lock the turn down so it can't reach ambient built-ins.
    allowedTools = [];
  }
  if (allowedTools !== undefined) out.allowedTools = allowedTools;
  if (req.disallowedTools !== undefined) out.disallowedTools = [...req.disallowedTools];

  if (req.tools !== undefined && req.tools.length > 0) {
    const requested = new Set(req.tools.map((t) => t.name));
    const catalog = deps.getRegisteredTools();
    const matched = catalog
      .filter((t) => requested.has(t.name))
      .filter((t) => isToolReachableByRib(t, deps, meta.ribId));
    // Gate through the unified policy engine when wired (denylist builtin + this
    // rib's policies); otherwise fall back to the local denylist floor. A gate
    // fault falls back to the denylist floor (not the whole turn) — this seam's
    // contract is to never throw, mirroring the workflow prompt gate.
    // The requested tools that survive the local denylist floor — used as the
    // no-engine / gate-fault fallback.
    const withoutDenied = (): ToolDefinition[] => matched.filter((t) => !deps.denied.has(t.name));
    let projected: ToolDefinition[];
    if (engine) {
      try {
        projected = (
          await engine.projectTools(matched, {
            surface: "rib",
            ribId: meta.ribId,
            provider: meta.providerId,
          })
        ).allowed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[rib-agent-turn] policy gate threw for rib '${meta.ribId}': ${msg}`);
        projected = withoutDenied();
      }
    } else {
      projected = withoutDenied();
    }
    if (projected.length > 0) out.tools = [...projected];
    // Forward the FULL catalog whenever any rib tool was requested — even if the
    // denylist dropped every match — so the provider still recognizes a registered
    // MCP name left in `allowedTools` and doesn't mis-send it to the SDK `--tools`
    // built-in gate (which the CLI rejects, failing the whole turn). Mirrors the
    // prompt handler, which sets this unconditionally.
    if (catalog.length > 0) out.registeredMcpToolNames = catalog.map((t) => t.name);
  }

  // Per-call args-aware gate, bound to this rib's scope. Wired whenever the
  // engine is present and the turn can actually run a gated tool — keelson tools
  // (projected above) OR built-ins (the claude PreToolUse hook routes
  // Bash/Edit/Write through this same gate). A text-only turn (allowedTools: [])
  // can run neither, so it stays ungated. A tool cleared into the projection can
  // still be denied here on its args; the thunk closes over the turn's teardown
  // signal so a pending ASK cancels with the turn.
  const textOnly = allowedTools !== undefined && allowedTools.length === 0;
  if (engine && !textOnly) {
    out.evaluateToolCall = (call) =>
      engine.evaluateToolCall(call, {
        surface: "rib",
        ribId: meta.ribId,
        provider: meta.providerId,
        cwd,
        ...(req.allowedDirectories !== undefined
          ? { allowedDirectories: req.allowedDirectories }
          : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
  }
  // Per-result gate, same rib scope — runs the `tool_result` phase on each rib
  // tool's output before the model consumes it. Wired only when a policy reads
  // the phase and the turn can run a gated tool (a text-only turn runs none).
  if (engine?.resultPhaseActive && !textOnly) {
    out.evaluateToolResult = (call) =>
      engine.evaluateToolResult(call, {
        surface: "rib",
        ribId: meta.ribId,
        provider: meta.providerId,
      });
  }
  return out;
}

function isToolReachableByRib(
  tool: ToolDefinition,
  deps: ResolvedDeps,
  callerRibId: string,
): boolean {
  if (!deps.getToolOwner) return true;
  const owner = deps.getToolOwner(tool.name);
  if (owner === undefined || owner === callerRibId) return true;
  return deps.isTurnToolGranted?.(callerRibId, owner, tool.name) === true;
}

// KEELSON_WORKFLOW_TOOL_DENYLIST → tool names to drop from the projection.
// Comma-separated, trimmed, empties removed. Unset → no env names (the shared
// DEFAULT_TOOL_DENYLIST floor is layered on separately at construction).
function parseToolDenylist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The result is the source of truth; synthesize the stream from it — the full
// text as one chunk (an error chunk on failure), then a terminal done.
async function* toStream(result: Promise<RibAgentTurnResult>): AsyncGenerator<MessageChunk> {
  const r = await result;
  if (r.text) yield { type: "text", content: r.text };
  // Emit an error chunk whenever the result carries one, so a failed turn never
  // looks clean on the stream (an empty-message provider error included).
  if (r.error !== undefined) yield { type: "error", message: r.error };
  yield { type: "done" };
}

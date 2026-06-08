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
import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
  ToolDefinition,
} from "@keelson/shared";

// Registry-routed C1 `runAgentTurn` seam (packages/shared/src/rib.ts): resolve a
// provider the same way workflow `prompt` nodes do (req.provider hint →
// KEELSON_WORKFLOW_PROVIDER → first non-stub) and drive one turn through
// `IAgentProvider.sendQuery`, adapting its chunk stream into the settled
// `{ stream, result }` dual-handle. The result is the source of truth; the
// stream is derived from it (a rib that drains the stream then awaits the
// result — the room loop — sees the same settled outcome).
//
// Invariants the seam owns, not each rib:
//   - a turn never inherits the host repo cwd (#114): an omitted `cwd` defaults
//     to a neutral non-repo directory;
//   - an empty/whitespace prompt is rejected with a clear seam-level error
//     (#115) rather than leaking the CLI's "Input must be provided" wording;
//   - provider routing honors configuration (#111) — `providerId` reflects the
//     provider actually used.

export interface MakeRibAgentTurnDeps {
  // Test seams: default to the live provider registry.
  getProvider?: (id: string) => IAgentProvider;
  isRegisteredProvider?: (id: string) => boolean;
  listProviderIds?: () => string[];
  // Neutral cwd for turns that don't pin one. Defaults to the OS temp dir so a
  // rib turn never runs in the server's (host repo) cwd.
  defaultCwd?: string;
}

interface ResolvedDeps {
  getProvider: (id: string) => IAgentProvider;
  hasProvider: (id: string) => boolean;
  listProviderIds: () => string[];
  neutralCwd: string;
}

export function makeRibAgentTurn(
  deps: MakeRibAgentTurnDeps = {},
): (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn {
  const resolved: ResolvedDeps = {
    getProvider: deps.getProvider ?? getAgentProvider,
    hasProvider: deps.isRegisteredProvider ?? registryHasProvider,
    listProviderIds: deps.listProviderIds ?? (() => getProviderInfoList().map((p) => p.id)),
    neutralCwd: deps.defaultCwd ?? tmpdir(),
  };
  // ribId is accepted for future per-rib policy/logging; provider routing is
  // global, so it does not scope the turn today.
  return (_ribId, req) => {
    const result = runTurn(resolved, req);
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

async function runTurn(deps: ResolvedDeps, req: RibAgentTurnRequest): Promise<RibAgentTurnResult> {
  // #115 — reject an empty/whitespace prompt at the seam, before touching a
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

  // #114 — never inherit the server's (host repo) cwd; a turn that omits `cwd`
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
    ...toolOptions(req),
  };

  let assistantText = "";
  let providerError: string | undefined;
  try {
    const stream = provider.sendQuery(req.prompt, cwd, req.resumeSessionId, options);
    for await (const chunk of stream) {
      if (controller.signal.aborted) break;
      if (chunk.type === "text") assistantText += chunk.content;
      else if (chunk.type === "error") providerError = chunk.message;
    }
  } catch (err) {
    if (timedOut)
      return { status: "timeout", text: assistantText, error: errMessage(err), providerId };
    if (controller.signal.aborted || isAbortError(err)) {
      return { status: "aborted", text: assistantText, providerId };
    }
    const msg = errMessage(err);
    return {
      status: /timed?\s*out|timeout/i.test(msg) ? "timeout" : "error",
      text: assistantText,
      error: msg,
      providerId,
    };
  } finally {
    if (timer) clearTimeout(timer);
    req.abortSignal?.removeEventListener("abort", onCallerAbort);
  }

  if (timedOut) return { status: "timeout", text: assistantText, providerId };
  if (controller.signal.aborted) return { status: "aborted", text: assistantText, providerId };
  if (providerError !== undefined) {
    return { status: "error", text: assistantText, error: providerError, providerId };
  }
  return { status: "ok", text: assistantText, providerId };
}

// Map the request's tool rails onto SendQueryOptions, preserving the C1 intent:
// `tools`/`allowedTools` present (even empty) means "these and no others", and a
// turn with no tool fields at all is text-only (the room default — no Bash/Edit
// between turns), expressed as an empty allow-list. A `disallowedTools`-only
// request is a deny rail that leaves the rest of the catalog available.
function toolOptions(req: RibAgentTurnRequest): Partial<SendQueryOptions> {
  const out: Partial<SendQueryOptions> = {};

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
  // The loose rib `tools` shape carries names for the allow-list above; only a
  // full ToolDefinition is projectable, so forward it as such when present.
  if (req.tools !== undefined) out.tools = req.tools as unknown as ToolDefinition[];
  return out;
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
  if (r.status !== "ok" && r.error) yield { type: "error", message: r.error };
  yield { type: "done" };
}

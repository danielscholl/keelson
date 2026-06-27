// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  disposeAllProviders,
  getAgentProvider,
  getProviderInfoList,
  UnknownProviderError,
} from "@keelson/providers";
import type { MessageChunk, ReasoningEffortLevel, TokenUsage } from "@keelson/shared";
import { coerceTokenUsage } from "@keelson/shared";
import { getRegisteredTools } from "@keelson/skills";

import {
  bootstrapCliProviders,
  bootstrapCliTools,
  isRegisteredProvider,
  pickDefaultProvider,
} from "./providers.ts";

export interface ChatHeadlessOptions {
  message: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  abortSignal?: AbortSignal;
  onChunk?: (chunk: MessageChunk) => void;
}

export interface ChatHeadlessResult {
  providerId: string;
  // Aggregated text content streamed from the provider — useful for tests
  // and callers that want the response without re-subscribing to onChunk.
  text: string;
  // Provider-reported turn usage; absent when the provider emitted none.
  usage?: TokenUsage;
}

// Lightweight identity prompt for one-shot chats. Server's chat-handler.ts
// builds a richer version with GitLab handle for the possessive-pronoun shim;
// one-shot CLI calls skip that since there's no conversation row holding the
// lane seed. Keep this terse — heavy system prompts dominate short queries.
function buildOneShotSystemPrompt(): string | undefined {
  // No identity scaffolding for the CLI's one-shot path; the operator passes
  // an explicit prompt and isn't relying on "my MRs" disambiguation. Return
  // undefined so the SDK default fires instead.
  return undefined;
}

// One-shot chat turn against the provider registry. Does not touch SQLite —
// an in-process write would race a concurrent `keelson start`, so one-shot
// stdout is the contract. The HTTP path (chat-client.ts) is the one that
// persists.
export async function chatHeadless(opts: ChatHeadlessOptions): Promise<ChatHeadlessResult> {
  bootstrapCliProviders();
  // No in-tree ribs; in-process tool catalog is empty. Operators wanting
  // chat-side tools embed their ribs from a custom entry point.
  bootstrapCliTools();
  const providerId = opts.provider ?? pickDefaultProvider();
  if (!isRegisteredProvider(providerId)) {
    throw new UnknownProviderError(
      providerId,
      getProviderInfoList().map((p) => p.id),
    );
  }
  const provider = getAgentProvider(providerId);
  const tools = getRegisteredTools();
  const systemPrompt = buildOneShotSystemPrompt();
  // Match the SPA picker (apps/web/src/views/Chat.tsx:126-129): when
  // --model is omitted, forward the provider's configured defaultModel
  // (Claude's pinned tag, Copilot's curated id, etc.). Empty string is
  // the "let the SDK decide" sentinel — leave the wire field unset for
  // that case.
  const providerDefault = provider.getCapabilities().defaultModel;
  const effectiveModel = opts.model ?? (providerDefault.length > 0 ? providerDefault : undefined);

  let text = "";
  let usage: TokenUsage | undefined;
  try {
    for await (const chunk of provider.sendQuery(opts.message, opts.cwd, undefined, {
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    })) {
      if (chunk.type === "usage") {
        const coerced = coerceTokenUsage(chunk.usage);
        if (coerced !== undefined) usage = coerced;
      }
      if (opts.abortSignal?.aborted) break;
      if (chunk.type === "text") text += chunk.content;
      opts.onChunk?.(chunk);
      if (chunk.type === "done") break;
    }
  } finally {
    // One-shot path: no server outlives this turn to drain providers, so reap
    // any warm subprocess here before the CLI exits rather than orphaning it.
    await disposeAllProviders();
  }

  return { providerId, text, ...(usage !== undefined ? { usage } : {}) };
}

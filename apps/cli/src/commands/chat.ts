// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { UnknownProviderError } from "@keelson/providers";
import type { MessageChunk, ReasoningEffortLevel } from "@keelson/shared";

import {
  chatViaServer,
  createConversation,
  getConversation,
  listProviders,
  type ProviderInfoRow,
} from "../http/chat-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { chatHeadless } from "../in-process/chat.ts";
import { probeServer } from "../server-probe.ts";
import {
  EXIT_BAD_ARGS,
  EXIT_FAIL,
  EXIT_NOT_FOUND,
  EXIT_NO_SERVER,
  EXIT_OK,
} from "../exit.ts";
import { emit } from "../output.ts";

export interface ChatOptions {
  json: boolean;
  provider?: string;
  model?: string;
  conversationId?: string;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  baseUrl?: string;
}

// Stream policy: human + TTY → live text chunks to stdout; `--json` or piped
// stdout buffers and emits a single envelope on completion so a downstream
// `jq` gets a single JSON object instead of mid-stream noise.
function shouldStreamLive(opts: ChatOptions): boolean {
  if (opts.json) return false;
  return process.stdout.isTTY === true;
}

function writeChunkLive(chunk: MessageChunk): void {
  if (chunk.type === "text") process.stdout.write(chunk.content);
}

function aggregateText(chunks: readonly MessageChunk[]): string {
  let out = "";
  for (const c of chunks) {
    if (c.type === "text") out += c.content;
  }
  return out;
}

// Mirror the SPA's pickInitialRef (apps/web/src/views/Chat.tsx:131):
// copilot → stub → first registered non-workflow. The synthetic `workflow`
// provider is registered for run-as-conversation rows but rejects chat
// turns, so we skip it in the fallback.
function pickDefaultHttpProvider(providers: readonly ProviderInfoRow[]): string {
  const ids = new Set(providers.map((p) => p.id));
  if (ids.has("copilot")) return "copilot";
  if (ids.has("stub")) return "stub";
  const first = providers.find((p) => p.id !== "workflow");
  if (first) return first.id;
  throw new Error(
    "no chat-capable provider registered on the server; run `keelson serve` with KEELSON_PROVIDERS unset or include stub/copilot/claude",
  );
}

async function runChatViaHttp(
  baseUrl: string,
  message: string,
  opts: ChatOptions,
): Promise<never> {
  let conversationId = opts.conversationId;
  let providerId: string;
  // Inherit the conversation's stored model only when the provider did NOT
  // change — Copilot's "gpt-4.1" and Claude's "claude-sonnet-…" aren't
  // interchangeable, so a `--provider` switch must drop the prior model.
  let modelFromConv: string | undefined;
  // Cache the providers list so we only round-trip /api/providers once even
  // when we need it for both provider-fallback and default-model resolution.
  let providersCache: ProviderInfoRow[] | undefined;
  const loadProviders = async (): Promise<ProviderInfoRow[]> => {
    if (!providersCache) providersCache = await listProviders(baseUrl);
    return providersCache;
  };

  if (conversationId) {
    // Resolve the existing conversation so the turn routes through the same
    // provider the SPA sees. The SPA locks the provider picker once a row
    // exists (apps/web/src/views/Chat.tsx ModelPicker), and the server's WS
    // path only updates `model` on mismatch — `providerId` stays the
    // creation-time value. Allowing a CLI swap would drift the row's
    // providerId from the live turn's provider, so reject the override.
    const conv = await getConversation(baseUrl, conversationId);
    if (opts.provider && opts.provider !== conv.providerId) {
      emit(
        {
          error: `--provider '${opts.provider}' conflicts with conversation '${conversationId}' (created with '${conv.providerId}'); omit --provider to continue, or start a new conversation`,
          code: "BAD_INPUTS",
        },
        { json: opts.json },
      );
      process.exit(EXIT_BAD_ARGS);
    }
    providerId = conv.providerId;
    modelFromConv = conv.model;
  } else if (opts.provider) {
    providerId = opts.provider;
  } else {
    // Mirror the SPA's fallback chain instead of hard-coding copilot, which
    // would 400 against KEELSON_PROVIDERS=stub/claude servers.
    providerId = pickDefaultHttpProvider(await loadProviders());
  }

  // Resolve the wire `model` precedence: explicit --model > conv-stored
  // model (same provider only) > provider's configured defaultModel.
  // Matches the SPA's pickInitialRef (apps/web/src/views/Chat.tsx:126-129).
  let effectiveModel = opts.model ?? modelFromConv;
  if (effectiveModel === undefined) {
    const providers = await loadProviders();
    const provider = providers.find((p) => p.id === providerId);
    const def = provider?.capabilities.defaultModel;
    if (def && def.length > 0) effectiveModel = def;
  }

  // Create a fresh conversation when --conversation isn't provided so the
  // turn appears in the SPA sidebar. Reusing an existing id continues that
  // conversation instead. Persist `effectiveModel` so the SPA's sidebar /
  // resume path sees the same model the CLI used (per chat-handler.ts:330
  // the WS path already updates conv.model on mismatch — being explicit at
  // creation time avoids the implicit second write).
  if (!conversationId) {
    const conv = await createConversation(baseUrl, {
      providerId,
      ...(effectiveModel ? { model: effectiveModel } : {}),
    });
    conversationId = conv.id;
  }

  const live = shouldStreamLive(opts);
  const chunks: MessageChunk[] = [];
  const result = await chatViaServer({
    baseUrl,
    conversationId,
    providerId,
    message,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(opts.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {}),
    onChunk: (chunk) => {
      chunks.push(chunk);
      if (live) writeChunkLive(chunk);
    },
  });
  if (live) process.stdout.write("\n");
  if (result.errored) {
    emit(
      {
        error: result.errorMessage ?? "chat stream errored",
        code: "PROVIDER_ERROR",
      },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  if (!live) {
    const text = aggregateText(chunks);
    if (opts.json) {
      emit(
        {
          data: {
            mode: "http",
            conversationId,
            providerId,
            text,
            chunks,
          },
        },
        { json: true },
      );
    } else {
      // Non-TTY human mode: emit ONLY the assistant text so pipes like
      // `keelson chat ... | pbcopy` capture the answer. Metadata
      // (conversationId, provider, mode) stays exclusively in --json mode.
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    }
  }
  process.exit(EXIT_OK);
}

async function runChatInProcess(message: string, opts: ChatOptions): Promise<never> {
  const live = shouldStreamLive(opts);
  const chunks: MessageChunk[] = [];
  try {
    const result = await chatHeadless({
      message,
      cwd: process.cwd(),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      ...(opts.reasoningEffort !== undefined
        ? { reasoningEffort: opts.reasoningEffort }
        : {}),
      onChunk: (chunk) => {
        chunks.push(chunk);
        if (live) writeChunkLive(chunk);
      },
    });
    if (live) process.stdout.write("\n");
    if (!live) {
      if (opts.json) {
        emit(
          {
            data: {
              mode: "in-process",
              providerId: result.providerId,
              text: result.text,
              chunks,
            },
          },
          { json: true },
        );
      } else {
        // See HTTP branch — non-TTY human mode is plain text only so
        // shell pipes get just the answer.
        process.stdout.write(result.text);
        if (!result.text.endsWith("\n")) process.stdout.write("\n");
      }
    }
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      emit({ error: err.message, code: "UNKNOWN_PROVIDER" }, { json: opts.json });
      process.exit(EXIT_FAIL);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: message, code: "CHAT_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
}

export async function runChat(message: string, opts: ChatOptions): Promise<never> {
  if (!message || message.trim().length === 0) {
    emit(
      { error: "chat <message> must be non-empty", code: "BAD_INPUTS" },
      { json: opts.json },
    );
    process.exit(EXIT_BAD_ARGS);
  }

  const baseUrl = opts.baseUrl;
  const info = baseUrl ? null : await probeServer();
  const effectiveBase = baseUrl ?? info?.baseUrl;

  if (effectiveBase) {
    try {
      return await runChatViaHttp(effectiveBase, message, opts);
    } catch (err) {
      if (isServerDownError(err)) {
        // Explicit --base-url unreachable: don't silently downgrade — the
        // operator picked HTTP for a reason (e.g. SPA visibility).
        emit(
          { error: `server at ${effectiveBase} is not reachable`, code: "NO_SERVER" },
          { json: opts.json },
        );
        process.exit(EXIT_NO_SERVER);
      }
      if (err instanceof HttpError) {
        // 404 typically means `--conversation <id>` named a deleted row.
        // Mirror workflow-run/status: exit EXIT_NOT_FOUND so shell scripts
        // can distinguish "no such resource" from generic HTTP failures.
        if (err.status === 404) {
          emit({ error: err.message, code: "NOT_FOUND" }, { json: opts.json });
          process.exit(EXIT_NOT_FOUND);
        }
        emit({ error: err.message, code: "HTTP_ERROR" }, { json: opts.json });
        process.exit(EXIT_FAIL);
      }
      const message = err instanceof Error ? err.message : String(err);
      emit({ error: message, code: "CHAT_FAILED" }, { json: opts.json });
      process.exit(EXIT_FAIL);
    }
  }

  // Server-down path: `--conversation <id>` is meaningless because the
  // in-process executor has no conversation store. Silently dropping it
  // would exit success after a context-free one-shot — surface NO_SERVER so
  // scripts can decide whether to retry or pivot to a fresh turn.
  if (opts.conversationId) {
    emit(
      {
        error:
          "--conversation requires a running server (start with `keelson serve`); the in-process path has no conversation store",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  return await runChatInProcess(message, opts);
}

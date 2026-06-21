// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { UnknownProviderError } from "@keelson/providers";
import type { MessageChunk, ReasoningEffortLevel, TokenUsage } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import {
  chatViaServer,
  createConversation,
  getConversation,
  listProviders,
  type ProviderInfoRow,
  pickDefaultHttpProvider,
} from "../http/chat-client.ts";
import { listProjects } from "../http/projects-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { chatHeadless } from "../in-process/chat.ts";
import { emit } from "../output.ts";
import { gateSchemaSkew } from "../schema-gate.ts";
import { probeServer } from "../server-probe.ts";

export interface ChatOptions {
  json: boolean;
  provider?: string;
  model?: string;
  conversationId?: string;
  // Named project the new conversation binds to. One-shots deliberately do NO
  // cwd→project resolution (that's the interactive TUI's binding rule);
  // omitted means the server's default project.
  project?: string;
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

function lastUsage(chunks: readonly MessageChunk[]): TokenUsage | undefined {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]!;
    if (c.type === "usage") return c.usage;
  }
  return undefined;
}

async function runChatViaHttp(baseUrl: string, message: string, opts: ChatOptions): Promise<never> {
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
    let projectId: string | undefined;
    if (opts.project) {
      const match = (await listProjects(baseUrl)).find((p) => p.name === opts.project);
      if (!match) {
        emit(
          {
            error: `no project named '${opts.project}' (see \`keelson project list\`)`,
            code: "PROJECT_NOT_FOUND",
          },
          { json: opts.json },
        );
        process.exit(EXIT_NOT_FOUND);
      }
      projectId = match.id;
    }
    const conv = await createConversation(baseUrl, {
      providerId,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(projectId ? { projectId } : {}),
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
    ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
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
      const usage = lastUsage(chunks);
      emit(
        {
          data: {
            mode: "http",
            conversationId,
            providerId,
            text,
            ...(usage !== undefined ? { usage } : {}),
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
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
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
              ...(result.usage !== undefined ? { usage: result.usage } : {}),
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

// Entry for `keelson chat [message]`: a message runs the one-shot paths; no
// message on a TTY opens the interactive TUI (server required).
export async function runChatEntry(message: string | undefined, opts: ChatOptions): Promise<never> {
  if (message !== undefined) return runChat(message, opts);
  if (opts.project !== undefined) {
    // The TUI binds via its cwd rule and rebinds with /project; seeding the
    // initial interactive binding from this flag is a tracked follow-up.
    emit(
      {
        error: "--project applies to one-shot chat; in interactive chat use /project <name>",
        code: "BAD_INPUTS",
      },
      { json: opts.json },
    );
    process.exit(EXIT_BAD_ARGS);
  }
  if (opts.json) {
    emit(
      {
        error: "--json requires a one-shot message; interactive mode is TTY-only",
        code: "BAD_INPUTS",
      },
      { json: true },
    );
    process.exit(EXIT_BAD_ARGS);
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    emit(
      {
        error: "chat <message> is required when not attached to a terminal",
        code: "BAD_INPUTS",
      },
      { json: false },
    );
    process.exit(EXIT_BAD_ARGS);
  }
  const baseUrl = opts.baseUrl;
  const info = baseUrl ? null : await probeServer();
  const effectiveBase = baseUrl ?? info?.baseUrl;
  if (!effectiveBase) {
    emit(
      {
        error: "interactive chat requires a running server; start it with `keelson start`",
        code: "NO_SERVER",
      },
      { json: false },
    );
    process.exit(EXIT_NO_SERVER);
  }
  await gateSchemaSkew(effectiveBase, info?.schemaVersion, false);
  // Dynamic import keeps the TUI dependency off the one-shot and scripted
  // paths entirely.
  const { runInteractiveChat } = await import("../interactive/run.ts");
  return runInteractiveChat({
    baseUrl: effectiveBase,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
  });
}

export async function runChat(message: string, opts: ChatOptions): Promise<never> {
  if (!message || message.trim().length === 0) {
    emit({ error: "chat <message> must be non-empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }

  // A conversation's project binding is creation-time only (like its
  // provider), so rebinding an existing conversation is a conflict, not a
  // merge. Static check — no server round-trip needed.
  if (opts.project && opts.conversationId) {
    emit(
      {
        error: `--project conflicts with --conversation '${opts.conversationId}'; the conversation keeps the project it was created with`,
        code: "BAD_INPUTS",
      },
      { json: opts.json },
    );
    process.exit(EXIT_BAD_ARGS);
  }

  const baseUrl = opts.baseUrl;
  const info = baseUrl ? null : await probeServer();
  const effectiveBase = baseUrl ?? info?.baseUrl;

  if (effectiveBase) {
    await gateSchemaSkew(effectiveBase, info?.schemaVersion, opts.json);
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

  // Server-down path: `--project <name>` is meaningless because the project
  // store lives behind the server. Same reasoning as `--conversation` below.
  if (opts.project) {
    emit(
      {
        error:
          "--project requires a running server (start it with `keelson start`); the in-process path has no project store",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  // Server-down path: `--conversation <id>` is meaningless because the
  // in-process executor has no conversation store. Silently dropping it
  // would exit success after a context-free one-shot — surface NO_SERVER so
  // scripts can decide whether to retry or pivot to a fresh turn.
  if (opts.conversationId) {
    emit(
      {
        error:
          "--conversation requires a running server (start it with `keelson start`); the in-process path has no conversation store",
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  return await runChatInProcess(message, opts);
}

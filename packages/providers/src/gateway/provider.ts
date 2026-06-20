// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";

// A provider that targets any OpenAI-compatible Chat Completions endpoint
// (OpenRouter, a local Ollama / vLLM, Azure OpenAI, a LiteLLM proxy) at a
// configurable base URL. Built on raw fetch + SSE so it pulls in no SDK; the
// `fetchImpl` seam lets tests feed canned streams without a network.
export interface GatewayProviderOptions {
  // The registered provider id (the gateway name); used only in error messages.
  id: string;
  // Endpoint base including the OpenAI version segment, e.g.
  // `http://localhost:11434/v1`. `/chat/completions` and `/models` hang off it.
  baseUrl: string;
  // Resolved lazily per turn — gateways may be keyless (local Ollama) so a
  // missing key is normal and simply omits the Authorization header.
  getApiKey: () => Promise<string | undefined>;
  // Seeds the default model + the picker. Without it the picker relies on
  // listModels() and the user must choose one before a turn can run.
  model?: string;
  // Defaults to global fetch; injected in tests.
  fetchImpl?: typeof fetch;
}

interface OpenAiDelta {
  content?: unknown;
  reasoning_content?: unknown;
}

interface OpenAiStreamEvent {
  choices?: Array<{ delta?: OpenAiDelta }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

// Collect an SSE event's `data:` fields into one payload. Per the SSE spec a
// single event may carry multiple `data:` lines that the client concatenates
// with `\n` before processing — so a gateway that frames one JSON across lines
// parses correctly instead of each fragment being dropped. Returns null when
// the event has no data field (a comment / id / event-type-only block).
function sseDataPayload(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const rawLine of rawEvent.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    // Strip the field name and the one optional leading space after the colon.
    dataLines.push(rawLine.slice("data:".length).replace(/^ /, ""));
  }
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

type ParsedSseEvent = {
  chunks: MessageChunk[];
  usage?: { inputTokens: number; outputTokens: number };
};

// Parse one event payload's JSON into message chunks. A non-JSON payload yields
// nothing (a partial/garbled frame is skipped, never fatal to the turn).
function parseSseData(payload: string): ParsedSseEvent {
  let event: OpenAiStreamEvent;
  try {
    event = JSON.parse(payload) as OpenAiStreamEvent;
  } catch {
    return { chunks: [] };
  }
  const chunks: MessageChunk[] = [];
  const delta = event.choices?.[0]?.delta;
  if (delta) {
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      chunks.push({ type: "thinking", content: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      chunks.push({ type: "text", content: delta.content });
    }
  }
  const inp = nonNegInt(event.usage?.prompt_tokens);
  const out = nonNegInt(event.usage?.completion_tokens);
  if (inp !== undefined && out !== undefined) {
    return { chunks, usage: { inputTokens: inp, outputTokens: out } };
  }
  return { chunks };
}

async function bodyTail(res: Response): Promise<string> {
  try {
    return (await res.text()).trim().slice(0, 500);
  } catch {
    return "";
  }
}

export class GatewayProvider implements IAgentProvider {
  private readonly id: string;
  private readonly baseUrl: string;
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly model: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly capabilities: ProviderCapabilities;

  constructor(opts: GatewayProviderOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl;
    this.getApiKey = opts.getApiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.capabilities = {
      sessionResume: false,
      streaming: true,
      // OpenAI function-calling -> keelson tools is deferred; start conservative
      // so the picker doesn't advertise tool support we don't wire.
      tools: false,
      models: opts.model ? [opts.model] : [],
      defaultModel: opts.model ?? "",
    };
  }

  getType(): string {
    return "gateway";
  }

  getCapabilities(): ProviderCapabilities {
    return this.capabilities;
  }

  // Never throws (IAgentProvider contract): a gateway that can't enumerate
  // models falls back to the configured-model projection so the picker is never
  // empty for a gateway with a model, and merely sparse for one without.
  async listModels(): Promise<ModelInfo[]> {
    const fallback: ModelInfo[] = this.capabilities.models.map((id) => ({ id }));
    try {
      const key = await this.getApiKey();
      const res = await this.fetchImpl(joinUrl(this.baseUrl, "models"), {
        headers: {
          accept: "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
      });
      if (!res.ok) return fallback;
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) return fallback;
      const ids = body.data
        .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return ids.length > 0 ? ids.map((id) => ({ id })) : fallback;
    } catch {
      return fallback;
    }
  }

  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    const model = options?.model || this.model;
    if (!model) {
      yield {
        type: "error",
        message: `gateway '${this.id}' has no model configured; set one on the gateway or pick a model`,
      };
      yield { type: "done" };
      return;
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) messages.push({ role: "system", content: options.systemPrompt });
    messages.push({ role: "user", content: prompt });

    let res: Response;
    try {
      const key = await this.getApiKey();
      res = await this.fetchImpl(joinUrl(this.baseUrl, "chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          // Ask the endpoint to emit a final usage-bearing chunk; gateways that
          // don't support it ignore the field, and parseSseData stays tolerant.
          stream_options: { include_usage: true },
        }),
        ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      });
    } catch (err) {
      if (options?.abortSignal?.aborted) return;
      yield { type: "error", message: `gateway '${this.id}' request failed: ${errMessage(err)}` };
      yield { type: "done" };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = res.body ? await bodyTail(res) : "";
      yield {
        type: "error",
        message: `gateway '${this.id}' HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      };
      yield { type: "done" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Events are separated by a blank line (\n\n or \r\n\r\n); split on that so
    // multi-line `data:` events are reassembled rather than parsed per-fragment.
    const boundary = /\r?\n\r?\n/;
    let buffer = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finished = false;
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const match = boundary.exec(buffer);
          if (!match) break;
          const rawEvent = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const payload = sseDataPayload(rawEvent);
          if (payload === null) continue;
          if (payload === "[DONE]") {
            finished = true;
            break;
          }
          const parsed = parseSseData(payload);
          for (const chunk of parsed.chunks) yield chunk;
          if (parsed.usage) usage = parsed.usage;
        }
      }
      // Flush a final event that arrived without a trailing blank line.
      if (!finished) {
        const payload = sseDataPayload(buffer);
        if (payload !== null && payload !== "[DONE]") {
          const parsed = parseSseData(payload);
          for (const chunk of parsed.chunks) yield chunk;
          if (parsed.usage) usage = parsed.usage;
        }
      }
    } catch (err) {
      if (options?.abortSignal?.aborted) return;
      yield { type: "error", message: `gateway '${this.id}' stream error: ${errMessage(err)}` };
    }

    if (usage) yield { type: "usage", usage };
    yield { type: "done" };
  }
}

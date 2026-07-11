// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import { toTokenCount } from "../token-count.ts";
import type { MessageChunk, ProviderFinishReason } from "../types.ts";

// Loose view of pi's AgentSessionEvent — only the fields the bridge reads. The
// real session emits richer, strongly-typed objects; the SDK adapter forwards
// them through this shape so the mapping stays unit-testable with plain data.
export interface PiRawEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// pi tool results are AgentToolResult-shaped ({ content: [{type:"text",text}…],
// details }); render the text items rather than JSON-dumping the envelope.
// Anything else — older shapes, plain values, a content array with no text
// items (e.g. image-only) — falls back to stringify so the payload survives.
function toolResultText(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const texts = result.content
      .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "text")
      .map((c) => (typeof c.text === "string" ? c.text : ""));
    if (texts.length > 0) return texts.join("\n");
  }
  return stringify(result);
}

// pi Usage { input, output, cacheRead, cacheWrite, ... } → keelson TokenUsage.
// Counts are sanitized through toTokenCount (drops non-numbers / negatives), and
// when pi reports no usable count at all (e.g. an empty `{}`) we emit nothing
// rather than a fabricated zero row. Cache fields are kept only when positive so
// a cache-miss turn's 0 doesn't render as a "Cache read 0" row. Mirrors the
// claude path's policy.
function mapPiUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const input = toTokenCount(u.input);
  const output = toTokenCount(u.output);
  const cacheRead = toTokenCount(u.cacheRead);
  const cacheWrite = toTokenCount(u.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const usage: TokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (cacheRead !== undefined && cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  if (cacheWrite !== undefined && cacheWrite > 0) usage.cacheCreationInputTokens = cacheWrite;
  return usage;
}

// Pure: a pi AgentSessionEvent (loosely typed) → keelson MessageChunk[].
// Streaming text/thinking, the completion usage, and mid-stream errors arrive
// inside message_update's assistantMessageEvent; tool calls arrive as
// tool_execution_* events; a turn that fails before streaming surfaces on
// agent_end (see mapTerminalError). Everything else maps to nothing.
export function mapPiEvent(event: PiRawEvent): MessageChunk[] {
  switch (event.type) {
    case "message_update":
      return isRecord(event.assistantMessageEvent)
        ? mapAssistantEvent(event.assistantMessageEvent)
        : [];
    case "agent_end":
      return mapTerminalError(event);
    case "tool_execution_start": {
      // Drop a call with no id: a tool_use without an id can never pair with its
      // tool_result, so it would render an orphan row. pi always supplies one.
      const id = nonEmptyString(event.toolCallId);
      if (!id) return [];
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = isRecord(event.args) ? event.args : undefined;
      const base: MessageChunk = { type: "tool_use", id, toolName };
      return [args ? { ...base, toolInput: args } : base];
    }
    case "tool_execution_end": {
      // toolUseId is required for pairing; skip an unpairable result rather than
      // emit one with an empty id.
      const toolUseId = nonEmptyString(event.toolCallId);
      if (!toolUseId) return [];
      const chunk: MessageChunk = {
        type: "tool_result",
        toolUseId,
        content: toolResultText(event.result),
        ...(event.isError === true ? { isError: true } : {}),
      };
      return [chunk];
    }
    default:
      return [];
  }
}

// A turn that fails before any assistant text (e.g. a github-copilot endpoint
// 421) emits no message_update — its error rides on the final assistant message
// of agent_end, so mapping it here is what turns a silent dead turn into a
// visible error. willRetry means pi will rerun the turn, so only a terminal
// failure is surfaced, and only an assistant message (not the echoed user turn)
// with stopReason "error". Usage rides along only on real spend (no zero row).
function mapTerminalError(event: PiRawEvent): MessageChunk[] {
  if (event.willRetry === true) return [];
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const last = messages[messages.length - 1];
  if (!isRecord(last) || last.role !== "assistant" || last.stopReason !== "error") return [];
  const out: MessageChunk[] = [];
  const usage = mapPiUsage(last.usage);
  if (usage && usage.inputTokens + usage.outputTokens > 0) out.push({ type: "usage", usage });
  out.push({
    type: "error",
    message: nonEmptyString(last.errorMessage) ?? "pi turn ended with an error",
  });
  return out;
}

function mapAssistantEvent(e: Record<string, unknown>): MessageChunk[] {
  switch (e.type) {
    case "text_delta":
      return typeof e.delta === "string" && e.delta.length > 0
        ? [{ type: "text", content: e.delta }]
        : [];
    case "thinking_delta":
      return typeof e.delta === "string" && e.delta.length > 0
        ? [{ type: "thinking", content: e.delta }]
        : [];
    case "done": {
      const usage = isRecord(e.message) ? mapPiUsage(e.message.usage) : undefined;
      return usage ? [{ type: "usage", usage }] : [];
    }
    case "error": {
      const err = isRecord(e.error) ? e.error : undefined;
      const message =
        err && typeof err.errorMessage === "string" && err.errorMessage.length > 0
          ? err.errorMessage
          : "pi turn ended with an error";
      const out: MessageChunk[] = [];
      const usage = err ? mapPiUsage(err.usage) : undefined;
      if (usage) out.push({ type: "usage", usage });
      out.push({ type: "error", message });
      return out;
    }
    default:
      return [];
  }
}

// The terminal finish reason for the rib-turn contract: only a terminal
// agent_end (not a willRetry) whose final assistant message carries a
// recognized stopReason maps; everything else reports nothing.
export function mapPiFinishReason(event: PiRawEvent): ProviderFinishReason | undefined {
  if (event.type !== "agent_end" || event.willRetry === true) return undefined;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const last = messages[messages.length - 1];
  if (!isRecord(last) || last.role !== "assistant") return undefined;
  switch (last.stopReason) {
    case "stop":
      return "end";
    case "max_tokens":
    case "length":
      return "max_tokens";
    default:
      return undefined;
  }
}

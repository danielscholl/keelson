// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import type { MessageChunk } from "../types.ts";

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

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// pi Usage { input, output, cacheRead, cacheWrite, ... } → keelson TokenUsage.
// Cache fields are emitted only when positive so a cache-miss turn's 0 doesn't
// render as a "Cache read 0" row (same gate the claude path applies).
function mapPiUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const input = typeof u.input === "number" ? u.input : 0;
  const output = typeof u.output === "number" ? u.output : 0;
  const usage: TokenUsage = { inputTokens: input, outputTokens: output };
  if (typeof u.cacheRead === "number" && u.cacheRead > 0) usage.cacheReadInputTokens = u.cacheRead;
  if (typeof u.cacheWrite === "number" && u.cacheWrite > 0) {
    usage.cacheCreationInputTokens = u.cacheWrite;
  }
  return usage;
}

// Pure: a pi AgentSessionEvent (loosely typed) → keelson MessageChunk[].
// Streaming text/thinking, the completion usage, and errors all arrive inside
// message_update's assistantMessageEvent; tool calls arrive as tool_execution_*
// events. Everything else maps to nothing.
export function mapPiEvent(event: PiRawEvent): MessageChunk[] {
  switch (event.type) {
    case "message_update":
      return isRecord(event.assistantMessageEvent)
        ? mapAssistantEvent(event.assistantMessageEvent)
        : [];
    case "tool_execution_start": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const args = isRecord(event.args) ? event.args : undefined;
      const base: MessageChunk = id
        ? { type: "tool_use", id, toolName }
        : { type: "tool_use", toolName };
      return [args ? { ...base, toolInput: args } : base];
    }
    case "tool_execution_end": {
      const toolUseId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const chunk: MessageChunk = {
        type: "tool_result",
        toolUseId,
        content: stringify(event.result),
        ...(event.isError === true ? { isError: true } : {}),
      };
      return [chunk];
    }
    default:
      return [];
  }
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

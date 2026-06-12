// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import { toTokenCount } from "../token-count.ts";
import type { MessageChunk } from "../types.ts";

// Loose view of codex-sdk's ThreadEvent — only the fields the bridge reads. The
// real SDK emits strongly-typed objects; the adapter forwards them through this
// shape so the mapping stays unit-testable with plain data.
export interface CodexRawEvent {
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

// codex Usage { input_tokens, cached_input_tokens, output_tokens,
// reasoning_output_tokens } → keelson TokenUsage. Counts are sanitized through
// toTokenCount; when codex reports no usable count we emit nothing rather than a
// fabricated zero row. cacheRead is kept only when positive so a cache-miss
// turn's 0 doesn't render a "Cache read 0" row. Mirrors the claude/pi policy.
// reasoning_output_tokens is left off outputTokens — codex bills it inside
// output_tokens, so adding it would double-count.
function mapCodexUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const input = toTokenCount(u.input_tokens);
  const output = toTokenCount(u.output_tokens);
  const cacheRead = toTokenCount(u.cached_input_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined) {
    return undefined;
  }
  const usage: TokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (cacheRead !== undefined && cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  return usage;
}

// Pure: a codex ThreadEvent (loosely typed) → keelson MessageChunk[]. Assistant
// text and reasoning arrive whole on item.completed (codex streams events, not
// token deltas, for these); tool activity arrives as command_execution /
// file_change / mcp_tool_call / web_search items; the per-turn usage rides on
// turn.completed; turn.failed and the fatal stream `error` event surface as
// error chunks. thread.started carries only the resumable id (read by the
// provider). Everything else maps to nothing.
export function mapCodexEvent(event: CodexRawEvent): MessageChunk[] {
  switch (event.type) {
    case "item.completed":
      return isRecord(event.item) ? mapItem(event.item) : [];
    case "turn.completed": {
      const usage = mapCodexUsage(event.usage);
      return usage ? [{ type: "usage", usage }] : [];
    }
    case "turn.failed": {
      const err = isRecord(event.error) ? event.error : undefined;
      const message = (err ? nonEmptyString(err.message) : undefined) ?? "codex turn failed";
      return [{ type: "error", message }];
    }
    case "error":
      // Fatal stream error emitted directly by codex exec.
      return [{ type: "error", message: nonEmptyString(event.message) ?? "codex stream error" }];
    default:
      return [];
  }
}

function mapItem(item: Record<string, unknown>): MessageChunk[] {
  switch (item.type) {
    case "agent_message": {
      const text = nonEmptyString(item.text);
      return text ? [{ type: "text", content: text }] : [];
    }
    case "reasoning": {
      const text = nonEmptyString(item.text);
      return text ? [{ type: "thinking", content: text }] : [];
    }
    case "command_execution":
      return mapCommandExecution(item);
    case "file_change":
      return mapFileChange(item);
    case "mcp_tool_call":
      return mapMcpToolCall(item);
    case "web_search":
      return mapWebSearch(item);
    case "todo_list":
      return mapTodoList(item);
    case "error": {
      // A non-fatal error surfaced as an item (distinct from the fatal stream
      // `error` event); show it without ending the turn.
      const message = nonEmptyString(item.message);
      return message ? [{ type: "system", content: `⚠️ ${message}` }] : [];
    }
    default:
      return [];
  }
}

function mapCommandExecution(item: Record<string, unknown>): MessageChunk[] {
  const id = nonEmptyString(item.id);
  const command = nonEmptyString(item.command);
  // id pairs the tool_use with its tool_result; a command-less item has nothing
  // to render. codex always supplies both.
  if (!id || !command) return [];
  const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
  const isError = exit !== undefined && exit !== 0;
  const aggregated = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  const exitSuffix = isError ? `\n[exit code: ${exit}]` : "";
  return [
    { type: "tool_use", id, toolName: "shell", toolInput: { command } },
    {
      type: "tool_result",
      toolUseId: id,
      content: aggregated + exitSuffix,
      ...(isError ? { isError: true } : {}),
    },
  ];
}

function mapFileChange(item: Record<string, unknown>): MessageChunk[] {
  const id = nonEmptyString(item.id);
  if (!id) return [];
  const isError = nonEmptyString(item.status) === "failed";
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const summary = changes
    .map((c) => {
      const change = isRecord(c) ? c : {};
      const kind = nonEmptyString(change.kind) ?? "update";
      const path = nonEmptyString(change.path) ?? "(unknown file)";
      const icon = kind === "add" ? "➕" : kind === "delete" ? "➖" : "📝";
      return `${icon} ${path}`;
    })
    .join("\n");
  return [
    { type: "tool_use", id, toolName: "apply_patch", toolInput: { changes } },
    {
      type: "tool_result",
      toolUseId: id,
      content: summary || (isError ? "patch failed" : "no changes"),
      ...(isError ? { isError: true } : {}),
    },
  ];
}

function mapMcpToolCall(item: Record<string, unknown>): MessageChunk[] {
  const id = nonEmptyString(item.id);
  if (!id) return [];
  const server = nonEmptyString(item.server);
  const tool = nonEmptyString(item.tool);
  const toolName = server && tool ? `${server}/${tool}` : (tool ?? server ?? "mcp_tool");
  const toolUse: MessageChunk = {
    type: "tool_use",
    id,
    toolName,
    ...(item.arguments !== undefined ? { toolInput: { arguments: item.arguments } } : {}),
  };
  if (nonEmptyString(item.status) === "failed") {
    const err = isRecord(item.error) ? item.error : undefined;
    const message = (err ? nonEmptyString(err.message) : undefined) ?? "MCP tool failed";
    return [toolUse, { type: "tool_result", toolUseId: id, content: message, isError: true }];
  }
  const result = isRecord(item.result) ? item.result : undefined;
  const content = result?.content !== undefined ? stringify(result.content) : "";
  return [toolUse, { type: "tool_result", toolUseId: id, content }];
}

function mapWebSearch(item: Record<string, unknown>): MessageChunk[] {
  const id = nonEmptyString(item.id);
  const query = nonEmptyString(item.query);
  if (!id || !query) return [];
  // codex surfaces the query but not the results inline; the empty result keeps
  // the row pairable.
  return [
    { type: "tool_use", id, toolName: "web_search", toolInput: { query } },
    { type: "tool_result", toolUseId: id, content: "" },
  ];
}

function mapTodoList(item: Record<string, unknown>): MessageChunk[] {
  const items = Array.isArray(item.items) ? item.items : [];
  if (items.length === 0) return [];
  const lines = items
    .map((t) => {
      const todo = isRecord(t) ? t : {};
      const text = nonEmptyString(todo.text) ?? "(unnamed task)";
      return `${todo.completed === true ? "✅" : "⬜"} ${text}`;
    })
    .join("\n");
  return [{ type: "system", content: `📋 Tasks:\n${lines}` }];
}

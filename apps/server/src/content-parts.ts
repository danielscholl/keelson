// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ContentBlock, MessageChunk } from "@keelson/shared";

// Accumulates a provider's streaming MessageChunk feed into the persisted
// shape: a denormalized assistant text string + a structured ContentBlock[]
// projection that survives reload.
//
// Thinking chunks are intentionally excluded — reasoning traces stay
// live-only and never durably store.
export interface ContentPartsAccumulator {
  ingest(chunk: MessageChunk): void;
  text(): string;
  parts(): ContentBlock[];
}

export function createContentPartsAccumulator(): ContentPartsAccumulator {
  let assistantText = "";
  const parts: ContentBlock[] = [];
  return {
    ingest(chunk: MessageChunk): void {
      if (chunk.type === "text") {
        assistantText += chunk.content;
        appendTextBlock(parts, chunk.content);
      } else if (chunk.type === "tool_use") {
        parts.push(toolUseBlockFromChunk(chunk));
      } else if (chunk.type === "tool_result") {
        parts.push({
          type: "tool_result",
          toolUseId: chunk.toolUseId,
          content: chunk.content,
          ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
        });
      }
      // system / thinking / error / done are not durable.
    },
    text(): string {
      return assistantText;
    },
    parts(): ContentBlock[] {
      return parts;
    },
  };
}

// Collapse consecutive text chunks into one block on the persisted turn; the
// chunk channel still streams every delta to the UI.
function appendTextBlock(parts: ContentBlock[], text: string): void {
  if (text.length === 0) return;
  const last = parts[parts.length - 1];
  if (last && last.type === "text") {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}

// `id` is optional on the chunk but required on the persisted block;
// synthesize when absent so reload still pairs the row.
function toolUseBlockFromChunk(chunk: Extract<MessageChunk, { type: "tool_use" }>): ContentBlock {
  return {
    type: "tool_use",
    id: chunk.id ?? crypto.randomUUID(),
    toolName: chunk.toolName,
    ...(chunk.toolInput !== undefined ? { toolInput: chunk.toolInput } : {}),
  };
}

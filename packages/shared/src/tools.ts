// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Tool-layer contract. Lives here because inputSchema needs a zod runtime
// import that packages/providers cannot carry.

import { z } from "zod";
import type { MessageChunk } from "./chat.ts";

export type { MessageChunk };

// Per-execution context for a tool's `execute()`. Skills MUST check
// `abortSignal.aborted` at every meaningful await.
export interface ToolContext {
  cwd: string;
  emit: (chunk: MessageChunk) => void;
  abortSignal: AbortSignal;
}

// Provider adapters MUST `inputSchema.parse(input)` before calling
// `execute`. Execute returns nothing — results travel as `tool_result`
// chunks so the same code path serves chat and workflow `prompt` nodes.
// Implementations should emit `tool_result` with `isError: true` rather
// than letting throws bubble through the SDK.
//
// `state_changing` / `requires_confirmation` are advisory metadata —
// surfaced through `/api/tools` so UI gates and reviewers can see intent.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  state_changing?: boolean;
  requires_confirmation?: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<void>;
}

// Family is the substring before the first underscore in the tool name
// (e.g. `kube_get` → `kube`). Tools with no underscore get the literal
// family `other` so /api/tools and UI chips have a stable bucket.
export const toolFamilySchema = z.string().min(1);
export type ToolFamily = z.infer<typeof toolFamilySchema>;

export const registeredToolInfoSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    family: toolFamilySchema,
    state_changing: z.boolean().default(false),
    requires_confirmation: z.boolean().default(false),
  })
  .strict();
export type RegisteredToolInfo = z.infer<typeof registeredToolInfoSchema>;

export function inferToolFamily(name: string): ToolFamily {
  const idx = name.indexOf("_");
  if (idx <= 0) return "other";
  return name.slice(0, idx);
}

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

// Action-oriented view of a `tool_use` chunk for a chat/transcript surface.
// Each provider bridge surfaces its own raw tool names — Copilot's Windows shell
// is `powershell`, Codex's is `shell`, Claude's is `Bash` — so a renderer needs
// a provider-agnostic way to pick a leading marker and the one argument worth
// showing. `inferToolFamily` buckets by name prefix for the /api/tools chips;
// this maps the cross-provider vocabulary onto a small action kind plus the
// salient field, so `powershell command: …, description: …` can render as
// `$ <command>` instead of a key:value dump.
export type ToolPresentationKind = "shell" | "read" | "edit" | "search" | "web" | "tool";

export interface ToolPresentation {
  kind: ToolPresentationKind;
  // Leading marker: "$" for shell (the universal prompt), the kind word for
  // read/edit/search/web, or the raw tool name for an unrecognized "tool".
  marker: string;
  // The single salient argument: the command for shell, the path for
  // read/edit, the pattern/query for search/web. Undefined when no known field
  // is present (the caller falls back to a compact arg dump).
  primary?: string;
  // A human description the call carried (e.g. Copilot's shell `description`),
  // surfaced only for recognized kinds so the "tool" fallback can dump it as a
  // plain arg instead.
  description?: string;
}

const TOOL_NAME_TO_KIND: Readonly<Record<string, ToolPresentationKind>> = {
  bash: "shell",
  sh: "shell",
  shell: "shell",
  zsh: "shell",
  cmd: "shell",
  powershell: "shell",
  pwsh: "shell",
  run_command: "shell",
  run_in_terminal: "shell",
  read: "read",
  read_file: "read",
  view: "read",
  cat: "read",
  open: "read",
  notebookread: "read",
  edit: "edit",
  write: "edit",
  create: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  apply_patch: "edit",
  git_apply_patch: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  insert_edit_into_file: "edit",
  grep: "search",
  glob: "search",
  ls: "search",
  search: "search",
  file_search: "search",
  grep_search: "search",
  semantic_search: "search",
  fetch: "web",
  web_fetch: "web",
  webfetch: "web",
  web_search: "web",
  websearch: "web",
};

// First matching field per kind, in priority order, mirroring the arg names the
// Copilot / Codex / Claude shells and editors emit.
const PRIMARY_FIELDS: Readonly<Record<ToolPresentationKind, readonly string[]>> = {
  shell: ["command", "cmd", "script"],
  read: ["path", "file_path", "filePath", "filename", "file"],
  edit: ["path", "file_path", "filePath", "filename", "file"],
  search: ["pattern", "query", "regex", "glob", "q"],
  web: ["url", "query", "q"],
  tool: [],
};

function firstStringField(
  input: Record<string, unknown> | undefined,
  fields: readonly string[],
): string | undefined {
  if (!input) return undefined;
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function toolPresentation(
  toolName: string,
  toolInput?: Record<string, unknown>,
): ToolPresentation {
  const kind = TOOL_NAME_TO_KIND[toolName.toLowerCase()] ?? "tool";
  const marker = kind === "shell" ? "$" : kind === "tool" ? toolName : kind;
  const primary = firstStringField(toolInput, PRIMARY_FIELDS[kind]);
  const rawDescription = toolInput?.description;
  const description =
    kind !== "tool" && typeof rawDescription === "string" && rawDescription.length > 0
      ? rawDescription
      : undefined;
  return {
    kind,
    marker,
    ...(primary !== undefined ? { primary } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

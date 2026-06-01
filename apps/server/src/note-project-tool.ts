// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Chat-callable tool that lets the agent grow the current project's notebook as
// it works. Constructed per chat request closing over the resolved projectId, so
// it can only ever write to the project the conversation is bound to.

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { DEFAULT_NOTEBOOK_SECTION, type ProjectNotebookStore } from "./project-notebook-store.ts";

const noteInputSchema = z
  .object({
    entry: z.string().min(1),
    section: z.string().min(1).default(DEFAULT_NOTEBOOK_SECTION),
  })
  .strict();

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  // toolUseId is a placeholder — Claude ignores it, Copilot rewrites it to the
  // real call id. Mirrors workflow-tools.ts.
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

export interface CreateNoteProjectToolDeps {
  store: ProjectNotebookStore;
  projectId: string;
}

export function createNoteProjectTool(deps: CreateNoteProjectToolDeps): ToolDefinition {
  const { store, projectId } = deps;
  return {
    name: "note_project",
    description:
      'Append a durable note to the current project\'s notebook — a persistent, always-on markdown doc fed back into every future chat about this project. Call it when the user states, or you confirm, a lasting fact, convention, decision, or gotcha about THIS project that should survive across sessions. Do NOT use it for transient chatter, task status, or secrets. `entry` is one line of prose; optional `section` (default "Log") groups related notes, e.g. "Conventions" or "Gotchas".',
    inputSchema: noteInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = noteInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const result = store.appendEntry(projectId, parsed.data.entry, parsed.data.section);
      if (!result.ok) {
        emitResult(
          ctx,
          "The project notebook is full; compact it (Tidy) before adding more.",
          true,
        );
        return;
      }
      emitResult(ctx, `Noted under "## ${parsed.data.section}" in the project notebook.`);
    },
  };
}

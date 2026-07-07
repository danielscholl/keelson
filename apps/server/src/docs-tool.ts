// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The keelson_docs tool: the agent's read-only window into Keelson's own docs
// and any installed rib's docs. Progressive by design — list sources, then a
// source's table of contents, then one topic — so context holds only what was
// asked for.

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import type { DocsCatalog, DocsTopic } from "./docs-catalog.ts";

const docsInputSchema = z
  .object({
    source: z.string().min(1).optional(),
    section: z.string().min(1).optional(),
  })
  .strict()
  // `section` names a topic within a source, so it's meaningless without one —
  // reject the malformed call rather than silently listing sources.
  .refine((v) => v.source !== undefined || v.section === undefined, {
    message: "`section` requires a `source`",
  });

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  // toolUseId is a placeholder — Claude ignores it, Copilot rewrites it to the
  // real call id. Mirrors workflow-tools.ts / note-project-tool.ts.
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

function renderTopics(topics: readonly DocsTopic[]): string {
  if (topics.length === 0) return "(this source has no topics)";
  return topics.map((t) => (t.summary ? `- ${t.slug} — ${t.summary}` : `- ${t.slug}`)).join("\n");
}

export interface CreateDocsToolDeps {
  catalog: DocsCatalog;
}

export function createDocsTool({ catalog }: CreateDocsToolDeps): ToolDefinition {
  return {
    name: "keelson_docs",
    description:
      "Read Keelson's own documentation and any installed rib's documentation. Use it whenever you need to know how Keelson behaves or how to do something in Keelson (workflows, ribs, the CLI, config, providers) instead of guessing — most users can't see Keelson's source, but these docs are the contract. Progressive: call with NO arguments to list documentation sources; with `source` (a source id) to get that source's table of contents; with `source` and `section` (a topic name from the table of contents) to read one topic. Only the requested topic is returned, never the whole corpus.",
    inputSchema: docsInputSchema,
    async execute(input, ctx) {
      const parsed = docsInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const { source, section } = parsed.data;

      if (!source) {
        const sources = catalog.list();
        if (sources.length === 0) {
          emitResult(ctx, "No documentation sources are registered.");
          return;
        }
        const lines = sources.map((s) => `- ${s.id} — ${s.title}: ${s.summary}`).join("\n");
        emitResult(
          ctx,
          `Keelson documentation sources (call keelson_docs with a \`source\` id for its table of contents):\n\n${lines}`,
        );
        return;
      }

      // Pass only the caller's own signal; the corpus fetch's timeout is owned by
      // the catalog so one caller's cancellation can't fail a concurrent reader.
      if (!section) {
        const result = await catalog.toc(source, ctx.abortSignal);
        if (!result.ok) {
          emitResult(ctx, result.error, true);
          return;
        }
        emitResult(
          ctx,
          `${result.source.title} (${result.source.id}) — table of contents. Call keelson_docs with source '${result.source.id}' and one of these section names:\n\n${renderTopics(result.topics)}`,
        );
        return;
      }

      const result = await catalog.readSection(source, section, ctx.abortSignal);
      if (!result.ok) {
        const toc = result.topics ? `\n\nAvailable sections:\n${renderTopics(result.topics)}` : "";
        emitResult(ctx, `${result.error}${toc}`, true);
        return;
      }
      emitResult(ctx, `# ${result.source.title} › ${result.topic.title}\n\n${result.content}`);
    },
  };
}

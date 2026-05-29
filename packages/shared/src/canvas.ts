// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// CanvasDocument — the contract for content opened in the canvas surface (a
// right-side drawer in the SPA). The harness owns the surface; producers
// (workflow trace, chat, memory, ribs) hand it a document. v1 implements
// `markdown` + `inline`/`artifact`; `view` / `html` / `snapshot` are reserved
// so later stages fill in renderers without changing this contract.
export const canvasKindSchema = z.enum(["markdown", "view", "html"]);
export type CanvasKind = z.infer<typeof canvasKindSchema>;

// Discriminated on `type`. `snapshot` rides the existing SnapshotManager and
// is wired in a later stage; v1 never emits it.
export const canvasSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("artifact"),
      runId: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("snapshot"), key: z.string().min(1) }).strict(),
]);
export type CanvasSource = z.infer<typeof canvasSourceSchema>;

export const canvasDocumentSchema = z
  .object({
    kind: canvasKindSchema,
    source: canvasSourceSchema,
    title: z.string().optional(),
  })
  .strict();
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

// Wire shape for the sandboxed run-artifact endpoint. `path` echoes the
// requested relative path; `content` is the file's UTF-8 text.
export const getRunArtifactResponseSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();
export type GetRunArtifactResponse = z.infer<typeof getRunArtifactResponseSchema>;

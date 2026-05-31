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
// (workflow trace, chat, memory, ribs) hand it a document. `markdown` and
// `view` (see canvasViewSchema) have renderers; `html` stays reserved until
// the iframe-origin security pass.
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

// Payload contract for a `kind: "view"` canvas. The data carries its own `view`
// discriminant — the producer (a workflow or a rib) bakes it in; the base picks
// a renderer from a closed catalog. Domain-free on purpose: `node.kind` is a
// generic category a rib colours by, never a base-side enum. The catalog ships
// `table` + `graph`; new members are additive union variants.
const canvasCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const canvasTableViewSchema = z
  .object({
    view: z.literal("table"),
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().optional() })).min(1),
    rows: z.array(z.record(z.string(), canvasCellSchema)),
    caption: z.string().optional(),
  })
  .strict();

export const canvasGraphViewSchema = z
  .object({
    view: z.literal("graph"),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().optional(),
            kind: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    edges: z.array(
      z
        .object({
          source: z.string().min(1),
          target: z.string().min(1),
          label: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

// Uniqueness lives on the union (a `.refine` on a member would break the
// discriminator). A duplicate column key / node id fails the parse, so the
// fail-closed gate rejects it before a renderer keys on a non-unique value.
export const canvasViewSchema = z
  .discriminatedUnion("view", [canvasTableViewSchema, canvasGraphViewSchema])
  .superRefine((view, ctx) => {
    if (view.view === "table") {
      const keys = view.columns.map((c) => c.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: "custom", message: "column keys must be unique", path: ["columns"] });
      }
      return;
    }
    const ids = view.nodes.map((n) => n.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "node ids must be unique", path: ["nodes"] });
    }
  });
export type CanvasView = z.infer<typeof canvasViewSchema>;
export type CanvasTableView = z.infer<typeof canvasTableViewSchema>;
export type CanvasGraphView = z.infer<typeof canvasGraphViewSchema>;

// Wire shape for the sandboxed run-artifact endpoint. `path` echoes the
// requested relative path; `content` is the file's UTF-8 text.
export const getRunArtifactResponseSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();
export type GetRunArtifactResponse = z.infer<typeof getRunArtifactResponseSchema>;

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
//
// `tone` is a generic visual category (never a domain enum) the renderer maps
// to a colour. Shared by table cells and every board primitive below.
const canvasToneSchema = z.enum(["ok", "warn", "error", "neutral"]);
export type CanvasTone = z.infer<typeof canvasToneSchema>;

// A cell is a bare scalar, or a scalar wrapped with a `tone`.
const canvasCellScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const canvasCellSchema = z.union([
  canvasCellScalarSchema,
  z.object({ value: canvasCellScalarSchema, tone: canvasToneSchema.optional() }).strict(),
]);
export type CanvasCell = z.infer<typeof canvasCellSchema>;

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

// Composite "board" view — an ordered stack of generic dashboard sections, so
// one payload renders KPI tiles, summary pulses, bars, a table, cards, and
// status rows together. Every piece is domain-free; a rib supplies the data.
const canvasSegmentSchema = z
  .object({ label: z.string().min(1), n: z.number(), tone: canvasToneSchema.optional() })
  .strict();
const canvasPillSchema = z
  .object({ label: z.string().min(1), tone: canvasToneSchema.optional() })
  .strict();

// A card field / status cell that can link out (`href`) or expose a copy button
// (`copyable`) — for portal URLs and credentials.
const canvasFieldSchema = z
  .object({
    label: z.string().optional(),
    value: canvasCellScalarSchema,
    tone: canvasToneSchema.optional(),
    href: z.string().optional(),
    copyable: z.boolean().optional(),
  })
  .strict();

// An action button a board offers; clicking dispatches `type` to the owning
// rib's onAction, resolved from the board's snapshot-key namespace. `type` is a
// rib-defined verb the base never enumerates (mirrors ribActionSchema).
const canvasActionItemSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
    tone: canvasToneSchema.optional(),
    destructive: z.boolean().optional(),
  })
  .strict();

const canvasBoardSectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stats"),
      title: z.string().optional(),
      items: z.array(
        z
          .object({
            label: z.string().min(1),
            value: canvasCellScalarSchema,
            sub: z.string().optional(),
            tone: canvasToneSchema.optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("segments"),
      title: z.string().optional(),
      items: z.array(canvasSegmentSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bars"),
      title: z.string().optional(),
      items: z.array(
        z
          .object({
            label: z.string().min(1),
            value: z.number(),
            total: z.number(),
            tone: canvasToneSchema.optional(),
            trailing: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("table"),
      title: z.string().optional(),
      columns: z.array(z.object({ key: z.string().min(1), label: z.string().optional() })).min(1),
      rows: z.array(z.record(z.string(), canvasCellSchema)),
      caption: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cards"),
      title: z.string().optional(),
      items: z.array(
        z
          .object({
            title: z.string().min(1),
            pill: canvasPillSchema.optional(),
            href: z.string().optional(),
            bar: z.object({ value: z.number(), total: z.number() }).strict().optional(),
            fields: z.array(canvasFieldSchema).optional(),
            footnote: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rows"),
      title: z.string().optional(),
      items: z.array(
        z
          .object({
            glyph: canvasToneSchema.optional(),
            chip: canvasPillSchema.optional(),
            text: z.string().min(1),
            href: z.string().optional(),
            trailing: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("actions"),
      title: z.string().optional(),
      items: z.array(canvasActionItemSchema),
    })
    .strict(),
]);

export const canvasBoardViewSchema = z
  .object({
    view: z.literal("board"),
    title: z.string().optional(),
    header: z
      .object({ chip: z.string().optional(), segments: z.array(canvasSegmentSchema).optional() })
      .strict()
      .optional(),
    sections: z.array(canvasBoardSectionSchema),
  })
  .strict();

// Uniqueness lives on the union (a `.refine` on a member would break the
// discriminator). A duplicate column key / node id fails the parse, so the
// fail-closed gate rejects it before a renderer keys on a non-unique value.
function assertUniqueColumnKeys(
  columns: { key: string }[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  const keys = columns.map((c) => c.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "column keys must be unique", path });
  }
}

export const canvasViewSchema = z
  .discriminatedUnion("view", [canvasTableViewSchema, canvasGraphViewSchema, canvasBoardViewSchema])
  .superRefine((view, ctx) => {
    if (view.view === "table") {
      assertUniqueColumnKeys(view.columns, ctx, ["columns"]);
      return;
    }
    if (view.view === "graph") {
      const ids = view.nodes.map((n) => n.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: "node ids must be unique", path: ["nodes"] });
      }
      return;
    }
    view.sections.forEach((section, i) => {
      if (section.kind === "table") {
        assertUniqueColumnKeys(section.columns, ctx, ["sections", i, "columns"]);
      }
    });
  });
export type CanvasView = z.infer<typeof canvasViewSchema>;
export type CanvasTableView = z.infer<typeof canvasTableViewSchema>;
export type CanvasGraphView = z.infer<typeof canvasGraphViewSchema>;
export type CanvasBoardView = z.infer<typeof canvasBoardViewSchema>;
export type CanvasActionItem = z.infer<typeof canvasActionItemSchema>;

// Wire shape for the sandboxed run-artifact endpoint. `path` echoes the
// requested relative path; `content` is the file's UTF-8 text.
export const getRunArtifactResponseSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();
export type GetRunArtifactResponse = z.infer<typeof getRunArtifactResponseSchema>;

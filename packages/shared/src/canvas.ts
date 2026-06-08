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
// ok/warn/error/neutral are the semantic core; info (cyan), caution (orange),
// brand (violet), and accent (indigo) extend the ramp for decorative identity
// (lane glyphs), multi-step scales (an A–E grade chip: ok·info·warn·caution·error),
// and hash-keyed category hues where neighbouring items need distinct colours.
export const canvasToneSchema = z.enum([
  "ok",
  "warn",
  "error",
  "neutral",
  "info",
  "caution",
  "brand",
  "accent",
]);
export type CanvasTone = z.infer<typeof canvasToneSchema>;

// A cell is a bare scalar, or a scalar wrapped with a `tone` and/or small toned
// `badges` — a coverage % beside R/S/M grade chips, a filled pass/skip/fail count
// chip. Badges carry their own tone so they ride the full ramp the bare `td` tone
// (ok/warn/error only) can't express.
const canvasCellScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const canvasCellBadgeSchema = z
  .object({ text: z.string().min(1), tone: canvasToneSchema.optional() })
  .strict();
const canvasCellSchema = z.union([
  canvasCellScalarSchema,
  z
    .object({
      value: canvasCellScalarSchema.optional(),
      tone: canvasToneSchema.optional(),
      badges: z.array(canvasCellBadgeSchema).optional(),
    })
    .strict()
    // A wrapped cell must render something: a value, or at least one badge.
    .refine((c) => c.value !== undefined || (c.badges?.length ?? 0) > 0, {
      message: "a cell needs a value or at least one badge",
    }),
]);
export type CanvasCell = z.infer<typeof canvasCellSchema>;
export type CanvasCellBadge = z.infer<typeof canvasCellBadgeSchema>;

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
// (`copyable` for a value already in the payload; `copyAction` to fetch the
// value on demand) — for portal URLs and credentials.
const canvasFieldSchema = z
  .object({
    label: z.string().optional(),
    value: canvasCellScalarSchema,
    tone: canvasToneSchema.optional(),
    href: z.string().optional(),
    copyable: z.boolean().optional(),
    // Reveal-on-copy: the field's copy button dispatches this action to the
    // owning rib and writes the returned `data` to the clipboard, so a secret is
    // fetched on click and never rides in the board payload, React state, or a
    // snapshot. Mirrors ribActionSchema's `{ type, payload }`.
    copyAction: z
      .object({ type: z.string().min(1), payload: z.unknown().optional() })
      .strict()
      .optional(),
  })
  .strict()
  // The two copy modes are mutually exclusive: a field with both would render
  // two same-label copy buttons (one copying the visible value, one revealing
  // via the rib), so a producer could silently copy the wrong value.
  .refine((f) => !(f.copyable && f.copyAction), {
    message: "a field sets at most one of copyable / copyAction",
  });

// One free-text input an action collects before it dispatches. The base renders
// a labelled field; the typed value is merged into the dispatched payload under
// `name`, so the rib reads it the same way it reads any other payload key.
const canvasActionFieldSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    // Render a multi-line textarea rather than a single-line input.
    multiline: z.boolean().optional(),
  })
  .strict();
export type CanvasActionField = z.infer<typeof canvasActionFieldSchema>;

// An action button a board offers; clicking dispatches `type` to the owning
// rib's onAction, resolved from the board's snapshot-key namespace. `type` is a
// rib-defined verb the base never enumerates (mirrors ribActionSchema).
const canvasActionItemSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
    glyph: z.string().optional(),
    tone: canvasToneSchema.optional(),
    destructive: z.boolean().optional(),
    // Opaque rib-defined context dispatched with the action (mirrors
    // ribActionSchema's `payload`), e.g. the cluster the board was built against
    // so the rib can reject a stale action. The base never inspects it.
    payload: z.unknown().optional(),
    // Input the action collects from the operator before dispatching. When set,
    // clicking the button opens a small form; the collected `{ name: value }`
    // map is merged into the dispatched payload (over any static object payload).
    // Names must be unique — the UI keys form state and JSX by `name`, so a
    // duplicate would silently overwrite a sibling's value.
    fields: z
      .array(canvasActionFieldSchema)
      .min(1)
      .refine((f) => new Set(f.map((x) => x.name)).size === f.length, {
        message: "action field names must be unique",
      })
      .optional(),
  })
  .strict();

// The leaf board sections — every primitive except the layout-only `columns`.
// Named so the same members compose both `leafBoardSectionSchema` (what a column
// may nest) and the full `canvasBoardSectionSchema` below.
const statsSectionSchema = z
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
  .strict();
const segmentsSectionSchema = z
  .object({
    kind: z.literal("segments"),
    title: z.string().optional(),
    items: z.array(canvasSegmentSchema),
  })
  .strict();
const barsSectionSchema = z
  .object({
    kind: z.literal("bars"),
    title: z.string().optional(),
    // Lay each bar out as one compact row (label · fixed-width track · trailing)
    // instead of a stacked head-over-track, for a dense offender/meter list.
    inline: z.boolean().optional(),
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
  .strict();
const tableSectionSchema = z
  .object({
    kind: z.literal("table"),
    title: z.string().optional(),
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().optional() })).min(1),
    rows: z.array(z.record(z.string(), canvasCellSchema)),
    caption: z.string().optional(),
  })
  .strict();
const cardsSectionSchema = z
  .object({
    kind: z.literal("cards"),
    title: z.string().optional(),
    // Render each card's fields as stacked inset pills (value + copy) rather
    // than inline text — for credential/address lists where each field is its
    // own copyable affordance.
    boxed: z.boolean().optional(),
    items: z.array(
      z
        .object({
          title: z.string().min(1),
          // Colour + monospace the title for code-like identifiers (a CVE id, a
          // ref) so the salient token reads as status, not prose.
          titleTone: canvasToneSchema.optional(),
          mono: z.boolean().optional(),
          dot: canvasToneSchema.optional(),
          pill: canvasPillSchema.optional(),
          href: z.string().optional(),
          bar: z.object({ value: z.number(), total: z.number() }).strict().optional(),
          fields: z.array(canvasFieldSchema).optional(),
          footnote: z.string().optional(),
          // A labelled annotation line under the card body (dashed rule), e.g.
          // `why flagged: stale-61d` — the label is dimmed, the text muted.
          reason: z
            .object({ label: z.string().optional(), text: z.string().min(1) })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
const rowsSectionSchema = z
  .object({
    kind: z.literal("rows"),
    title: z.string().optional(),
    // Render each row as an inset card (a status list) instead of a borderless
    // feed: the tone glyph reads as a check/mark and the trailing value is
    // left-aligned after a fixed label column.
    boxed: z.boolean().optional(),
    items: z.array(
      z
        .object({
          // A leading glyph character (e.g. a feed-row category icon). Distinct
          // from `glyph`, which is a tone rendered as a status dot.
          icon: z.string().min(1).optional(),
          glyph: canvasToneSchema.optional(),
          chip: canvasPillSchema.optional(),
          text: z.string().min(1),
          href: z.string().optional(),
          trailing: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const actionsSectionSchema = z
  .object({
    kind: z.literal("actions"),
    title: z.string().optional(),
    items: z.array(canvasActionItemSchema),
  })
  .strict();
// A dense grid of labelled cells, each carrying a small toned badge — for a
// compact at-a-glance matrix (a per-service grade grid, a status board) where
// `cards` would be too heavy. Cells link out via `href`.
const gridSectionSchema = z
  .object({
    kind: z.literal("grid"),
    title: z.string().optional(),
    cells: z.array(
      z
        .object({
          label: z.string().min(1),
          href: z.string().optional(),
          badge: z.object({ text: z.string().min(1), tone: canvasToneSchema.optional() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();

const leafBoardSectionSchema = z.discriminatedUnion("kind", [
  statsSectionSchema,
  segmentsSectionSchema,
  barsSectionSchema,
  tableSectionSchema,
  cardsSectionSchema,
  rowsSectionSchema,
  actionsSectionSchema,
  gridSectionSchema,
]);

// `columns` lays leaf sections side by side (a two-column Lifecycle | Actions
// body, etc.). Recursion is one level deep on purpose — a column nests leaf
// sections only, never another `columns` — to keep the schema and renderer
// simple. `weight` is a relative grid-track size (default 1).
const columnsBoardSectionSchema = z
  .object({
    kind: z.literal("columns"),
    title: z.string().optional(),
    columns: z
      .array(
        z
          .object({
            weight: z.number().positive().optional(),
            sections: z.array(leafBoardSectionSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const canvasBoardSectionSchema = z.discriminatedUnion("kind", [
  statsSectionSchema,
  segmentsSectionSchema,
  barsSectionSchema,
  tableSectionSchema,
  cardsSectionSchema,
  rowsSectionSchema,
  actionsSectionSchema,
  gridSectionSchema,
  columnsBoardSectionSchema,
]);

export const canvasBoardViewSchema = z
  .object({
    view: z.literal("board"),
    title: z.string().optional(),
    header: z
      .object({
        status: canvasPillSchema.optional(),
        chip: z.string().optional(),
        segments: z.array(canvasSegmentSchema).optional(),
      })
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
      } else if (section.kind === "columns") {
        section.columns.forEach((col, c) => {
          col.sections.forEach((leaf, s) => {
            if (leaf.kind === "table") {
              const path = ["sections", i, "columns", c, "sections", s, "columns"];
              assertUniqueColumnKeys(leaf.columns, ctx, path);
            }
          });
        });
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

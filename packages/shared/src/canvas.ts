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
// `view` (see canvasViewSchema) render directly; `html` renders untrusted markup
// in a sandboxed iframe (see canvasHtmlActionSchema for its action back-channel).
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

// Action posted from a sandboxed `html` canvas back to the host. The iframe is a
// unique opaque origin (sandbox without allow-same-origin), so its messages
// arrive with origin "null" — the host gates on `event.source` identity, then
// parses through this schema before dispatch. `channel` is a fixed discriminant
// so unrelated postMessage traffic is ignored. It deliberately carries no
// rib/target id: an action can only reach the rib that owns the canvas's
// snapshot key (host-derived), never one named by the untrusted frame. Frame
// script can post without a user gesture, so a rib must render only markup it
// authored here — never externally-controlled HTML — as the back-channel
// dispatches straight to the rib's own action handler.
export const CANVAS_HTML_ACTION_CHANNEL = "keelson:canvas:html:action";
export const canvasHtmlActionSchema = z
  .object({
    channel: z.literal(CANVAS_HTML_ACTION_CHANNEL),
    type: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .strict();
export type CanvasHtmlAction = z.infer<typeof canvasHtmlActionSchema>;

// Host→frame counterpart: the SPA pushes its resolved theme into a sandboxed
// `html` canvas so token-level markup (styled through `:root[data-theme]`
// overrides) re-themes live without an iframe reload — the opaque-origin frame
// cannot observe the parent's data-theme itself. The shell stamps the initial
// theme at compose time; this message carries subsequent toggles.
export const CANVAS_HTML_THEME_CHANNEL = "keelson:canvas:html:theme";
export const canvasHtmlThemeSchema = z
  .object({
    channel: z.literal(CANVAS_HTML_THEME_CHANNEL),
    theme: z.enum(["light", "dark"]),
  })
  .strict();
export type CanvasHtmlThemeMessage = z.infer<typeof canvasHtmlThemeSchema>;

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
//
// id-* are reserved identity slots for actors a rib renders repeatedly (squad
// members, chamber minds): assign one per actor at creation in a fixed order and
// persist it — never hash per render, and never seat an actor in a status hue.
// The five hues were validated as a categorical set (CVD separation + contrast)
// against both SPA card surfaces; an actor's name must always accompany the
// colour (the chip renderer keeps identity text in ink for this reason). A sixth
// actor folds to `neutral` + name rather than minting a hue.
export const canvasToneSchema = z.enum([
  "ok",
  "warn",
  "error",
  "neutral",
  "info",
  "caution",
  "brand",
  "accent",
  "id-blue",
  "id-amber",
  "id-teal",
  "id-rose",
  "id-olive",
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
      href: z.string().optional(),
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

// One entry in a `people` field — a name wearing a tone (canonically an id-*
// identity hue). The name is required so identity colour never renders without
// it (the id-* accompaniment rule); a bare dot can't be authored.
const canvasPersonSchema = z
  .object({ name: z.string().min(1), tone: canvasToneSchema.optional() })
  .strict();
export type CanvasPerson = z.infer<typeof canvasPersonSchema>;

// A card field / status cell that can link out (`href`) or expose a copy button
// (`copyable` for a value already in the payload; `copyAction` to fetch the
// value on demand) — for portal URLs and credentials. A field carries either a
// scalar `value` or `people` (identity-toned names in the value slot — a room's
// cast, a change's reviewers), never both.
const canvasFieldSchema = z
  .object({
    label: z.string().optional(),
    value: canvasCellScalarSchema.optional(),
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
    people: z.array(canvasPersonSchema).min(1).optional(),
  })
  .strict()
  // The two copy modes are mutually exclusive: a field with both would render
  // two same-label copy buttons (one copying the visible value, one revealing
  // via the rib), so a producer could silently copy the wrong value.
  .refine((f) => !(f.copyable && f.copyAction), {
    message: "a field sets at most one of copyable / copyAction",
  })
  .refine((f) => (f.value === undefined) !== (f.people === undefined), {
    message: "a field carries exactly one of value / people",
  })
  // The link/copy/tone affordances all act on the scalar value; on a people
  // field they would dangle off a value that doesn't exist.
  .refine(
    (f) =>
      !f.people || (f.tone === undefined && f.href === undefined && !f.copyable && !f.copyAction),
    { message: "a people field carries only a label" },
  );

// One free-text input an action collects before it dispatches. The base renders
// a labelled field; the typed value is merged into the dispatched payload under
// `name`, so the rib reads it the same way it reads any other payload key.
const canvasActionFieldSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    // Pre-fills the control so the form opens on a current value rather than
    // blank. For a select, it must name one of `options` (or "" to open on the
    // empty/clear option). Without it a form always opens empty, so an idle
    // submit dispatches nothing for this field — which a producer that reads
    // absent-as-clear (e.g. a model pin) would treat as a wipe.
    defaultValue: z.string().optional(),
    // Render a multi-line textarea rather than a single-line input.
    multiline: z.boolean().optional(),
    // A fixed choice set renders a <select> instead of a free-text input; the
    // dispatched value is the chosen option's `value`. A non-required select
    // offers `placeholder` as an empty "none" option, so an unset optional
    // select dispatches "". Mutually exclusive with `multiline`.
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
      .min(1)
      .optional(),
    // Render the host's live provider/model catalog picker (searchable, grouped
    // by provider) instead of a producer-supplied choice set — so a board never
    // hardcodes a model list. The dispatched value is the chosen model id;
    // `providerField`, when set, names a companion payload key that carries the
    // chosen model's provider id (and is seeded from `providerDefault` so an
    // untouched submit re-affirms the current provider rather than clearing it).
    // A non-required picker offers `placeholder` as its clear row, dispatching ""
    // (and "" for `providerField`). `defaultValue` may be any model id, on- or
    // off-catalog — a hand-pinned model stays visible rather than clearing.
    // Mutually exclusive with `multiline` and `options`.
    modelPicker: z
      .object({
        providerField: z.string().min(1).optional(),
        providerDefault: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((f) => !(f.multiline && f.options), {
    message: "a field is either multiline or a select, not both",
  })
  .refine((f) => !(f.modelPicker && (f.multiline || f.options)), {
    message: "a modelPicker field carries neither multiline nor options",
  })
  // providerDefault seeds the companion key, so without providerField it has
  // nowhere to land — reject at publish rather than silently dropping it.
  .refine((f) => !(f.modelPicker?.providerDefault && !f.modelPicker.providerField), {
    message: "modelPicker.providerDefault requires modelPicker.providerField",
  })
  // The companion key rides the same dispatched payload as the field's own
  // value; sharing the name would make one overwrite the other.
  .refine((f) => f.modelPicker?.providerField !== f.name, {
    message: "modelPicker.providerField must differ from the field's own name",
  })
  // An option's `value` is both the dispatched value and the renderer's list key,
  // so duplicates make the selection ambiguous and collide React keys.
  .refine((f) => !f.options || new Set(f.options.map((o) => o.value)).size === f.options.length, {
    message: "select option values must be unique",
  })
  // A select can only open on a value it offers; "" opens on the empty/clear
  // option. A non-empty default outside the option set would render nothing
  // selected — fail closed so the producer catches it at publish, not on screen.
  .refine(
    (f) =>
      f.defaultValue === undefined ||
      f.defaultValue === "" ||
      !f.options ||
      f.options.some((o) => o.value === f.defaultValue),
    { message: "a select field's defaultValue must match one of its option values" },
  );
export type CanvasActionField = z.infer<typeof canvasActionFieldSchema>;

const canvasActionConfirmSchema = z
  .object({
    // Irreversible actions can require a typed subject before confirm enables.
    irreversible: z.boolean().optional(),
    subject: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    confirmLabel: z.string().min(1).optional(),
    cancelLabel: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => !c.irreversible || c.subject !== undefined, {
    message: "irreversible confirms require a subject",
  });

// An action button a board offers; clicking dispatches `type` to the owning
// rib's onAction, resolved from the board's snapshot-key namespace. `type` is a
// rib-defined verb the base never enumerates (mirrors ribActionSchema).
// Exported: surfaceRegionSchema reuses it for a region's headActions.
export const canvasActionItemSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
    // A second muted line under the label, rendered only by the `tabs` layout so
    // a mode picker's one-line description reads inline instead of hiding in a
    // hover tooltip. Other layouts ignore it; `hint` stays the hover explanation.
    subtitle: z.string().min(1).max(200).optional(),
    glyph: z.string().optional(),
    tone: canvasToneSchema.optional(),
    destructive: z.boolean().optional(),
    // A destructive card action normally hides in the card's overflow (⋯) menu; set
    // `inline` to surface it as a visible, still-confirm-guarded button on the card
    // instead. Inert on a non-destructive action (those always render inline).
    inline: z.boolean().optional(),
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
      // A picker's companion key lands in the same dispatched map as every
      // field's own value, so it must not shadow a sibling field's name or
      // another picker's companion — either would silently overwrite on pick.
      .refine(
        (f) => {
          const taken = new Set(f.map((x) => x.name));
          for (const x of f) {
            const companion = x.modelPicker?.providerField;
            if (companion === undefined) continue;
            if (taken.has(companion)) return false;
            taken.add(companion);
          }
          return true;
        },
        {
          message: "a modelPicker providerField must not collide with any field name or companion",
        },
      )
      .optional(),
    // Render `fields` as an always-open form whose submit button carries the
    // action's label/glyph/tone — no disclosure click — for a hero action whose
    // input IS the affordance. Inert without `fields`.
    expanded: z.boolean().optional(),
    // The `fields` form's submit button text, when `label` names the tab/mode
    // rather than the verb (a "Debate" tab submitting as "Convene"). Defaults to
    // `label`; inert without `fields`.
    submitLabel: z.string().min(1).max(40).optional(),
    // Confirmation presentation metadata. `destructive` still marks dangerous
    // actions; this only controls whether the confirm dialog is simple or typed.
    confirm: canvasActionConfirmSchema.optional(),
    // A short descriptive hover tooltip — what the action does — surfaced
    // regardless of enabled/disabled state, so a producer can remind the operator
    // what an unfamiliar action is for. Distinct from `reason` (which explains why
    // a disabled action can't run): on a disabled action the UI shows both, the
    // hint then the reason.
    hint: z.string().min(1).optional(),
    // Render the action non-interactive — dimmed and unclickable, its form sealed
    // — when a precondition the state can't satisfy fails (a capability-gated tab
    // whose current cast can't run it). `reason` is the human explanation of WHY
    // it's disabled, surfaced as a tooltip — so it's only valid alongside
    // `disabled: true` (a reason on a clickable action would be ambiguous). A
    // producer that recomputes preconditions re-emits these on each recompose, so a
    // state change flips the gate.
    disabled: z.boolean().optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((a) => !a.reason || a.disabled === true, {
    message: "reason explains why an action is disabled — set disabled: true alongside it",
  });

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
          href: z.string().optional(),
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
    // Lay the cards out side by side as an auto-fit grid instead of the stacked
    // full-width column — for fixed-capacity rosters where the row IS the bench.
    // The host owns the responsive column count; an open fields-form stays
    // inside its card's column.
    grid: z.boolean().optional(),
    items: z.array(
      z
        .object({
          title: z.string().min(1),
          // Colour + monospace the title for code-like identifiers (a CVE id, a
          // ref) so the salient token reads as status, not prose.
          titleTone: canvasToneSchema.optional(),
          mono: z.boolean().optional(),
          // Render this card's fields as a stacked column (one field per line)
          // instead of the inline `·`-joined meta row — for line-oriented
          // readouts (a boot sequence, a log tail) where the break IS the shape.
          stacked: z.boolean().optional(),
          dot: canvasToneSchema.optional(),
          pill: canvasPillSchema.optional(),
          href: z.string().optional(),
          bar: z.object({ value: z.number(), total: z.number() }).strict().optional(),
          fields: z.array(canvasFieldSchema).optional(),
          actions: z.array(canvasActionItemSchema).optional(),
          footnote: z.string().optional(),
          // Render as an open-seat placeholder — dashed border, centered body —
          // the "empty seat" affordance in a grid bench (an authoring launchpad,
          // an unfilled casting slot).
          ghost: z.boolean().optional(),
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
          // Long-form body disclosed under the row on demand (pre-wrapped plain
          // text, not markdown) — the full record behind a capped one-line `text`.
          detail: z.string().min(1).max(4000).optional(),
        })
        .strict(),
    ),
  })
  .strict();
const actionsSectionSchema = z
  .object({
    kind: z.literal("actions"),
    title: z.string().optional(),
    // Lay the buttons out as an inline wrapping row of compact chips instead of a
    // full-width stacked column — for a selection strip (a toggle set, a shape
    // picker) where a stacked column wastes the surface's width. An action that
    // opens a `fields` form breaks to its own full-width line so the form still
    // reads as a panel beneath the row. Default (absent) stays stacked.
    wrap: z.boolean().optional(),
    // Render the buttons as a single-select tab strip: opening one item's
    // `fields` form closes its siblings', and the open form renders as one
    // stable full-width panel beneath the whole strip (never mid-row) — for a
    // mode picker where at most one form should exist. At rest no tab is
    // active; clicking the active tab closes it. Items without `fields` still
    // dispatch on click. Takes precedence over `wrap` (the strip wraps on its
    // own); `expanded` is inert inside a tabs section.
    tabs: z.boolean().optional(),
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

// A deterministic line/timeseries plot the base renders itself. The 6-series
// cap is the fixed-order `--s1..--s6` palette's never-cycle rule made
// structural; `x` may be numbers (linear scale) or strings (ordered
// categories), and mixing across the section falls back to categories.
const chartSectionSchema = z
  .object({
    kind: z.literal("chart"),
    title: z.string().optional(),
    yLabel: z.string().optional(),
    series: z
      .array(
        z
          .object({
            label: z.string().min(1),
            points: z
              .array(z.object({ x: z.union([z.number(), z.string()]), y: z.number() }).strict())
              .min(1),
          })
          .strict()
          // Duplicate x within a series would silently collapse to one plotted
          // point (stringified — the renderer's slot identity), so reject it.
          .refine((s) => new Set(s.points.map((p) => String(p.x))).size === s.points.length, {
            message: "series x values must be unique",
            path: ["points"],
          }),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type CanvasChartSection = z.infer<typeof chartSectionSchema>;

// A fixed-capacity identity row: labelled seats render as named items, while
// unlabelled seats stay decorative so regions do not invent identities.
const seatsSectionSchema = z
  .object({
    kind: z.literal("seats"),
    title: z.string().optional(),
    items: z
      .array(
        z
          .object({
            tone: canvasToneSchema.optional(),
            filled: z.boolean().optional(),
            label: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CanvasSeatsSection = z.infer<typeof seatsSectionSchema>;

const journeySectionSchema = z
  .object({
    kind: z.literal("journey"),
    title: z.string().optional(),
    items: z
      .array(
        z
          .object({
            title: z.string().min(1),
            text: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CanvasJourneySection = z.infer<typeof journeySectionSchema>;

const leafBoardSectionSchema = z.discriminatedUnion("kind", [
  statsSectionSchema,
  segmentsSectionSchema,
  barsSectionSchema,
  tableSectionSchema,
  cardsSectionSchema,
  rowsSectionSchema,
  actionsSectionSchema,
  gridSectionSchema,
  chartSectionSchema,
  seatsSectionSchema,
  journeySectionSchema,
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
  chartSectionSchema,
  seatsSectionSchema,
  journeySectionSchema,
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
        // An identity-toned roster peek for the region head: a dot per person, with
        // the names revealed on hover of the status count. Reuses canvasPerson (name
        // required — a bare dot can't be authored, the id-* accompaniment rule), so
        // the colour is always one hover away from its name.
        people: z.array(canvasPersonSchema).optional(),
        // Hint that the region head may start collapsed because the board is
        // "populated" (a producer sets it once it has real content). The host
        // collapses once on the first false->true transition; a manual toggle wins
        // after, and a return to false (emptied) re-arms it. Absent = never auto-collapse.
        defaultCollapsed: z.boolean().optional(),
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

// Series labels key the legend, the tooltip rows, and the fixed-order palette
// assignment — a duplicate would seat two lines in one identity.
function assertUniqueSeriesLabels(
  series: { label: string }[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  const labels = series.map((s) => s.label);
  if (new Set(labels).size !== labels.length) {
    ctx.addIssue({ code: "custom", message: "series labels must be unique", path });
  }
}

// One place lists the leaf kinds carrying a cross-item uniqueness rule, so the
// top-level walk and the columns-nested walk can't drift apart.
function assertLeafSectionUniqueness(
  leaf: z.infer<typeof leafBoardSectionSchema>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (leaf.kind === "table") {
    assertUniqueColumnKeys(leaf.columns, ctx, [...path, "columns"]);
  } else if (leaf.kind === "chart") {
    assertUniqueSeriesLabels(leaf.series, ctx, [...path, "series"]);
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
      if (section.kind === "columns") {
        section.columns.forEach((col, c) => {
          col.sections.forEach((leaf, s) => {
            assertLeafSectionUniqueness(leaf, ctx, ["sections", i, "columns", c, "sections", s]);
          });
        });
      } else {
        assertLeafSectionUniqueness(section, ctx, ["sections", i]);
      }
    });
  });
export type CanvasView = z.infer<typeof canvasViewSchema>;
export type CanvasTableView = z.infer<typeof canvasTableViewSchema>;
export type CanvasGraphView = z.infer<typeof canvasGraphViewSchema>;
export type CanvasBoardView = z.infer<typeof canvasBoardViewSchema>;
export type CanvasActionItem = z.infer<typeof canvasActionItemSchema>;

// Producer-side guard for ribs publishing a snapshot frame: parse `data` through
// the full canvas view union (not a bare member schema) so the node-id /
// column-key uniqueness checks the SPA render gate runs are enforced before a
// frame is broadcast, then assert it is the expected discriminant.
export function expectView(key: string, kind: CanvasView["view"]) {
  return (data: unknown): CanvasView => {
    const view = canvasViewSchema.parse(data);
    if (view.view !== kind) throw new Error(`${key} expects a ${kind} view, got "${view.view}"`);
    return view;
  };
}

// Wire shape for the sandboxed run-artifact endpoint. `path` echoes the
// requested relative path; `content` is the file's UTF-8 text.
export const getRunArtifactResponseSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();
export type GetRunArtifactResponse = z.infer<typeof getRunArtifactResponseSchema>;

// Harness-owned snapshot namespace for published canvas artifacts (designed
// self-contained HTML pages from `canvas_publish`). Not under `rib:*` — like
// RIBS_VERSION_SNAPSHOT_KEY these register on the base snapshot manager, and
// the SPA resolves the `html` canvas kind from this prefix rather than a rib
// manifest. Slugs are the identity: republishing a slug updates in place.
export const CANVAS_ARTIFACT_KEY_PREFIX = "canvas:artifact:";
export const canvasArtifactSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "artifact slug must be lowercase alphanumeric/dash",
  });

export function canvasArtifactKey(slug: string): string {
  return `${CANVAS_ARTIFACT_KEY_PREFIX}${slug}`;
}

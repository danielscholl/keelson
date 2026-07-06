// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Design guidance for agent-authored canvas artifacts — the knowledge layer
// over the `html` canvas kind. Three tiers of disclosure: the compact standing
// block (`buildCanvasArtifactGuidance`, injected into chat when canvas_publish
// is active), the on-demand reference sections (`CANVAS_DESIGN_GUIDE_SECTIONS`,
// served by canvas_design_guide), and the one-paragraph contract that rides the
// canvas_publish tool description everywhere the registry reaches (workflow
// prompt nodes, rib turns, MCP). Palette values come from DESIGN_TOKENS so
// guidance and the SPA can never disagree about a hex.

import { DESIGN_TOKENS } from "./design-tokens.ts";

const dark = DESIGN_TOKENS.dark;
const light = DESIGN_TOKENS.light;

// Ready-to-paste token block: dark is keelson's default (`:root`), light is the
// override — the same polarity the SPA uses, so a stamped data-theme just works.
export function designTokenCssBlock(): string {
  return `:root {
  --bg: ${dark.bg}; --card: ${dark.card}; --card-2: ${dark.card2};
  --border: ${dark.border}; --fg: ${dark.fg}; --fg-strong: ${dark.fgStrong};
  --muted: ${dark.muted}; --accent: ${dark.accent};
  --good: ${dark.green}; --warn: ${dark.yellow}; --crit: ${dark.red}; --info: ${dark.cyan};
  --s1: ${dark.series[0]}; --s2: ${dark.series[1]}; --s3: ${dark.series[2]};
  --s4: ${dark.series[3]}; --s5: ${dark.series[4]}; --s6: ${dark.series[5]};
  color-scheme: dark;
}
:root[data-theme="light"] {
  --bg: ${light.bg}; --card: ${light.card}; --card-2: ${light.card2};
  --border: ${light.border}; --fg: ${light.fg}; --fg-strong: ${light.fgStrong};
  --muted: ${light.muted}; --accent: ${light.accent};
  --good: ${light.green}; --warn: ${light.yellow}; --crit: ${light.red}; --info: ${light.cyan};
  --s1: ${light.series[0]}; --s2: ${light.series[1]}; --s3: ${light.series[2]};
  --s4: ${light.series[3]}; --s5: ${light.series[4]}; --s6: ${light.series[5]};
  color-scheme: light;
}`;
}

// One paragraph that rides the canvas_publish tool description — the minimum
// contract every surface sees even without the chat guidance section.
export const CANVAS_PUBLISH_CONTRACT = [
  "Publish a designed, self-contained HTML page to the operator's canvas.",
  "The page renders in a sandboxed iframe with no network access: inline all CSS/JS,",
  "no external scripts or stylesheets, system font stack only (font-family:",
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; never webfonts).",
  "Style through CSS custom properties: define dark values in :root (keelson's default",
  'theme) and override in :root[data-theme="light"] — the host stamps and live-updates',
  "data-theme on <html>. Declare any categorical chart palette on <body> as",
  'data-palette-dark="#hex,#hex,…" / data-palette-light="…"; publishing validates',
  "color-vision separation and surface contrast and REJECTS failing palettes — fix the",
  "colors and call again. Re-publishing the same `name` updates that artifact in place.",
  "Call canvas_design_guide first for layout, chart-form, and color rules.",
].join(" ");

// The standing chat section, injected only when canvas_publish is active this
// turn (the buildWorkflowGuidance pattern). Kept compact: depth lives behind
// canvas_design_guide.
export function buildCanvasArtifactGuidance(): string {
  return [
    "## Canvas artifacts",
    "",
    "You can publish designed, self-contained HTML pages — reports, briefings, charts, dashboards — to the operator's canvas with canvas_publish (title, html, optional name; re-publishing a name updates it in place). Reach for it when the deliverable is a page someone will read, keep, or share; answer routine questions in plain chat, and prefer the structured board/view canvas for live operational status a rib already renders.",
    "",
    "The frame contract (sandboxed iframe, enforced):",
    "- No network: fetch/XHR are blocked; inline every style and script. Images/fonts may load from data:/https:, but a page should stand alone offline.",
    "- System font stack only — never webfonts or font data URIs.",
    '- Theme through tokens: define CSS custom properties on :root with keelson\'s dark values (dark is the default theme), override them under :root[data-theme="light"], and style everything through the tokens. The host stamps data-theme on <html> and re-stamps it live on toggle. Use this exact block as the base palette so the page reads as part of keelson:',
    "",
    "```css",
    designTokenCssBlock(),
    "```",
    "",
    "Craft rules (the difference between generated-looking and designed):",
    "- Calibrate treatment: a working report gets clear hierarchy and quiet polish, not a flashy hero. Ground the page in its subject; write real copy, active voice, specific labels.",
    "- Typography carries the page: a deliberate type scale, ~65ch body measure, text-wrap: balance on headings, letter-spaced uppercase for eyebrows/labels, font-variant-numeric: tabular-nums wherever digits align.",
    "- Layout spaces siblings with flex/grid gap, never stacked margins; wide tables/code scroll inside their own overflow-x container; respect prefers-reduced-motion.",
    "",
    "Chart rules (non-negotiable):",
    "- Series identity comes from the keelson series slots (--s1…--s6) assigned in order — never invent hues, never cycle, never color by rank. A 7th series folds into 'Other'.",
    "- Status colors (--good/--warn/--crit) mean state; they never impersonate a series. One y-axis, never two. Direct-label sparingly plus a legend for 2+ series; text wears ink tokens, never the series color.",
    '- Declare every categorical palette on <body data-palette-dark="…" data-palette-light="…"> (comma-separated hex, in slot order). canvas_publish validates CVD separation and surface contrast per theme and rejects hard failures with a report — fix and retry. The token slots above already pass.',
    "",
    "Before authoring anything nontrivial, call canvas_design_guide: 'page' (layout/typography/theming in depth), 'form' (which chart fits the data — or no chart), 'color' (the four color jobs + the keelson instance), 'marks' (mark anatomy, labels, hover), 'anti-patterns' (the catalog of what goes wrong — check your draft against it).",
  ].join("\n");
}

// On-demand reference sections behind canvas_design_guide — the deep corpus,
// adapted to the keelson frame contract. Each stands alone; agents read only
// what the task needs.
export const CANVAS_DESIGN_GUIDE_SECTIONS: Readonly<Record<string, string>> = {
  page: `# Page design for canvas artifacts

Read the request first and calibrate treatment. Most artifacts are working documents — a run report, an audit, a briefing. They deserve real typographic hierarchy, considered spacing, and a proper palette, delivered quietly: no giant hero, no scattered animation. Reserve editorial flourish (an orchestrated reveal, a display-face masthead) for pages explicitly meant to impress, and even then spend boldness in one place and keep everything around it calm.

Structure:
- Open with a masthead that orients: an eyebrow label (mono, uppercase, letter-spaced), a headline that states the thesis (not the topic), and a one-paragraph BLUF with the key numbers bolded.
- Stat tiles for the 3–5 figures that matter, before any detail. Encode state in form as well as number — a left accent bar, a toned value — so what needs attention reads at a glance.
- Sections in reading order of importance; a labelled group ("P0 · do first") encodes real priority, numbered markers only when order genuinely carries information.
- End with provenance: how the content was produced, its data window, generated-at.

Typography: system sans for everything (the frame never loads webfonts); a mono stack (ui-monospace, "SF Mono", Menlo, monospace) for eyebrows, code, identifiers, and aligned figures. Set a scale and stay on it; body measure ~65ch; headings get text-wrap: balance; tabular-nums for every column of digits.

Theming: define ALL color as custom properties — dark values on :root (keelson's default), light overrides on :root[data-theme="light"]. Never style a component with a raw hex; the toggle must retheme everything. Give the second theme the same care: don't naively invert, keep contrast legible, re-tune shadows. The host stamps data-theme on <html> and updates it live; color-scheme rides the token block so form controls and scrollbars follow.

Copy is design material: name things by what the reader recognizes; controls say exactly what happens; errors say what went wrong and how to fix it. Specific beats clever. Build with real content — never lorem.

Craft floor: close every element, double-quote attributes, visible keyboard focus, prefers-reduced-motion honored, no horizontal page scroll (wide content scrolls inside its own container), overlapping/absolute positioning only with a reason.`,

  form: `# Choosing the form

The data's job picks the form — and sometimes the answer is not a chart.

- One headline figure → a stat tile / hero number with a label and delta, not a one-bar chart.
- Magnitude comparison across categories → horizontal bars, sorted by value (alphabetical only when lookup order matters). Nominal categories all wear the SAME slot-1 hue — bar length already encodes the value; color would re-encode it.
- Change over time → line (or area for cumulative). Emphasize the endpoint; label the last value directly.
- Composition of a whole → stacked bar or segmented strip. Avoid pie charts beyond 3 slices; never 3D, never donut-with-legend-soup.
- Distribution → histogram or dot strip. Correlation → scatter (validate palette with all-pairs separation).
- A process with stages → ordered gauges/funnel using an ordinal one-hue ramp (light→dark encodes the order), not categorical hues.
- Status of many items → a grid/board of labelled cells with toned badges; state is a word + tone, never color alone.
- Tri-window trends (before/mid/now) → small per-item gauge triplets with a trend arrow, like a fail-rate board.

If swapping category order would change the meaning (stages, tiers, buckets) it is ordinal — one hue, monotone lightness steps. If not (teams, services, models) it is nominal — series slots in fixed order.

Tables beat charts when the reader needs exact values or many dimensions; a chart earns its place by making one comparison obvious. When a chart has 2+ series, a legend is mandatory and ≤4 series should also be direct-labeled.`,

  color: `# Color: four jobs, one instance

Every color does exactly one job; palettes are validated, never eyeballed.

1. Categorical (which series): the keelson series slots in fixed order — dark ${dark.series.join(", ")} / light ${light.series.join(", ")}. Assign in sequence, never cycle, never reorder, never invent a 7th hue (fold into "Other"). The order is part of the validated set.
2. Sequential/ordinal (how much / which stage): one hue, monotone lightness. Build ramps from the slot-1 hue family; the palest step must still clear ~2:1 against the surface.
3. Status (what state): --good ${dark.green}/${light.green}, --warn ${dark.yellow}/${light.yellow}, --crit ${dark.red}/${light.red}, --info ${dark.cyan}/${light.cyan} (dark/light). Reserved meaning; always paired with an icon, glyph, or word — never color alone; never reused as "series 4". When a series MEANS pass/fail it wears status tokens; when it's just identity it wears series slots — never both in one chart.
4. Ink: text always wears ink tokens (--fg, --fg-strong, --muted) — a value label never wears its series color; the colored mark beside it carries identity.

Surfaces: charts render on --card (dark ${dark.card} / light ${light.card}); the app plane is --bg (${dark.bg} / ${light.bg}). Contrast is only meaningful against the actual surface.

The validation contract: declare each categorical palette on <body data-palette-dark="…" data-palette-light="…"> in slot order. canvas_publish computes OKLCH lightness band, chroma floor, CVD (protan/deutan) separation, and WCAG contrast per theme. Hard failures reject the publish with a per-check report — change the colors (usually: use the token slots), don't fight the checks. Floor-band CVD and sub-3:1 contrast pass as warnings that OBLIGATE secondary encoding: direct labels, visible gaps, or an adjacent table.

Never: rainbow ramps, dual-hue "heat" without a neutral midpoint, red/green as the only distinction between two series, series colors picked for looks.`,

  marks: `# Marks, anatomy, interaction

Marks: thin bars (rounded only at the data end, anchored to a flat baseline), 2px lines, ≥8px markers. Separate touching fills with a 2px surface-colored gap (stacked segments, adjacent bars). Grid is hairline and recessive (--border at reduced opacity); axes are quieter than data; drop the chart's outer box.

Labels: axis and tick text in --muted, 11–12px, tabular-nums. Direct-label the endpoint of each line and the largest few bars; never every point (that's a table wearing a costume). A legend accompanies 2+ series always — a single series needs none (the title names it).

The gauge/meter pattern (fits the frame with zero dependencies): a labelled track (background --card-2, 1px --border, radius) with a fill span whose width is the percentage and whose color is a status or series token, the value in mono beside it. Triplets of these with a trend arrow (▲ worsening / ▼ improving, colored by DIRECTION-AS-STATUS plus the glyph so it's never color-alone) make a compact before/mid/now board.

Stat tiles: value in mono at 28–32px with tabular-nums, label beneath in --muted at ~12px, optional left accent bar carrying tone. Tiles sit in a responsive grid (repeat(auto-fit, minmax(160px, 1fr))).

Interaction inside the frame: hover affordances are welcome (CSS :hover reveals, a title attribute for exact values, a details/summary disclosure for long tails) but must be enhancement only — every value readable without hover, since the artifact may be exported or printed. Script is available (inline only) for tabs/filters; keep state in the page, remember there is no network, and never trap keyboard focus. Actions back to the host go through keelson.action(type, payload) or data-canvas-action attributes — only meaningful when a rib owns the artifact's key and gates those verbs.`,

  "anti-patterns": `# Anti-patterns — check your draft against this list

Color:
- Series colors invented or cycled instead of taken from the slots in order.
- A palette that fails validation "fixed" by removing the data-palette declaration instead of fixing the colors.
- Status hues doing series work, or a series that means pass/fail wearing categorical hues.
- Value text tinted with its series color; identity color without an accompanying name/label.
- A sequential ramp jumping hue families; a diverging scale without a neutral midpoint; any rainbow.

Charts:
- Two y-axes. Always two charts or an indexed common base instead.
- A number on every point; a legend for a single series; gridlines louder than data.
- Pie charts past 3 slices; 3D anything; bars not anchored at zero.
- Nominal bars painted by value (length already says it) or by rank (color follows the entity, never its position).

Page:
- Raw hex scattered through component CSS instead of tokens (the theme toggle breaks).
- Webfonts or font data URIs (blocked/bloated); icon fonts (use inline SVG or glyphs).
- External scripts, stylesheets, or fetch calls — the CSP blocks them; the page must be self-contained.
- A giant editorial hero on a working report; emoji as section markers; everything centered; purple-gradient-on-white template smell.
- Numbered section markers (01/02/03) where order carries no information.
- Light theme as an afterthought: unreadable muted text, inverted shadows, washed-out accents.
- Horizontal page scroll from a wide table (wrap it in its own overflow-x: auto container).
- Motion without prefers-reduced-motion guards; hover-only information.

Process:
- Publishing without validating a declared palette, or never declaring one on a page with categorical series.
- Rebuilding an artifact under a new name for an update — re-publish the same name so the operator's canvas updates in place.`,
};

export const CANVAS_DESIGN_GUIDE_SECTION_NAMES = Object.freeze(
  Object.keys(CANVAS_DESIGN_GUIDE_SECTIONS),
) as readonly string[];

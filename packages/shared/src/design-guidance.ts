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

const SANS_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif`;
const MONO_STACK = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// Ready-to-paste token block: dark is keelson's default (`:root`), light is the
// override — the same polarity the SPA uses, so a stamped data-theme just works.
// It paints <body> too, because the frame's own ground is white.
export function designTokenCssBlock(): string {
  return `:root {
  --bg: ${dark.bg}; --card: ${dark.card}; --card-2: ${dark.card2};
  --border: ${dark.border}; --fg: ${dark.fg}; --fg-strong: ${dark.fgStrong};
  --muted: ${dark.muted}; --accent: ${dark.accent};
  --good: ${dark.green}; --warn: ${dark.yellow}; --crit: ${dark.red}; --info: ${dark.cyan};
  --s1: ${dark.series[0]}; --s2: ${dark.series[1]}; --s3: ${dark.series[2]};
  --s4: ${dark.series[3]}; --s5: ${dark.series[4]}; --s6: ${dark.series[5]};
  --id-1: ${dark.identity.blue}; --id-2: ${dark.identity.amber}; --id-3: ${dark.identity.teal};
  --id-4: ${dark.identity.rose}; --id-5: ${dark.identity.olive};
  --sans: ${SANS_STACK};
  --mono: ${MONO_STACK};
  color-scheme: dark;
}
:root[data-theme="light"] {
  --bg: ${light.bg}; --card: ${light.card}; --card-2: ${light.card2};
  --border: ${light.border}; --fg: ${light.fg}; --fg-strong: ${light.fgStrong};
  --muted: ${light.muted}; --accent: ${light.accent};
  --good: ${light.green}; --warn: ${light.yellow}; --crit: ${light.red}; --info: ${light.cyan};
  --s1: ${light.series[0]}; --s2: ${light.series[1]}; --s3: ${light.series[2]};
  --s4: ${light.series[3]}; --s5: ${light.series[4]}; --s6: ${light.series[5]};
  --id-1: ${light.identity.blue}; --id-2: ${light.identity.amber}; --id-3: ${light.identity.teal};
  --id-4: ${light.identity.rose}; --id-5: ${light.identity.olive};
  color-scheme: light;
}
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); }`;
}

// Component classes over the token block. Every color reads a token, and every
// tone class sets --c for the component it lands on.
const KIT_CSS = `.page { max-width: 1080px; margin: 0 auto; padding-block: 32px 64px; padding-inline: 20px; }
.eyebrow { margin: 0 0 8px; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
h1, h2, h3 { margin: 0; color: var(--fg-strong); text-wrap: balance; }
h1 { margin-bottom: 10px; font-size: clamp(24px, 3.4vw, 32px); line-height: 1.2; font-weight: 650; }
h2 { margin-bottom: 8px; font-size: 19px; line-height: 1.3; font-weight: 620; }
h3 { margin-bottom: 6px; font-size: 15px; font-weight: 620; }
p { margin: 0 0 10px; max-width: 68ch; }
b, strong { color: var(--fg-strong); font-weight: 600; }
.lede { font-size: 16.5px; max-width: 64ch; }
code, .mono { font-family: var(--mono); font-size: .9em; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
section { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--border); }

.good { --c: var(--good); } .warn { --c: var(--warn); } .crit { --c: var(--crit); } .info { --c: var(--info); }
.id-1 { --c: var(--id-1); } .id-2 { --c: var(--id-2); } .id-3 { --c: var(--id-3); } .id-4 { --c: var(--id-4); } .id-5 { --c: var(--id-5); }

.summary { margin-top: 20px; padding: 18px 20px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.summary p { max-width: 80ch; }
.summary p:last-child { margin-bottom: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 16px 0 0; padding: 0; list-style: none; font-size: 13.5px; }
.legend li { display: inline-flex; align-items: center; gap: 8px; }
.legend li::before { content: ""; flex: none; width: 10px; height: 10px; border-radius: 2px; background: var(--c, var(--muted)); }
.legend li.mute::before { background: none; border: 1.5px dashed var(--muted); }
.tag { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--fg); white-space: nowrap; vertical-align: middle; }
.tag::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--c, var(--muted)); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 20px; }
.stat { padding: 14px 16px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.stat:is(.good, .warn, .crit, .info) { box-shadow: inset 3px 0 0 var(--c); }
.stat .v { font-family: var(--mono); font-size: 28px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--fg-strong); }
.stat .l { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--muted); }
.meter { height: 8px; background: var(--card-2); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.meter > span { display: block; height: 100%; background: var(--c, var(--s1)); }

.scroll { margin-top: 16px; overflow-x: auto; }
.tbl { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.tbl th { padding: 9px 14px; text-align: left; background: var(--card-2); border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.tbl th:first-child { border-top-left-radius: 10px; } .tbl th:last-child { border-top-right-radius: 10px; }
.tbl td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.callout { margin-top: 16px; padding: 12px 16px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; font-size: 14px; }
.callout:is(.good, .warn, .crit, .info) { border-color: color-mix(in srgb, var(--c) 55%, var(--border)); }
.callout p:last-child { margin-bottom: 0; }
.term { margin: 16px 0 0; padding: 14px 16px; background: var(--card-2); border: 1px solid var(--border); border-radius: 10px; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; white-space: pre; overflow-x: auto; }
.term .d { color: var(--muted); } .term .ok { color: var(--good); } .term .bad { color: var(--crit); } .term .hi { color: var(--fg-strong); font-weight: 600; }

.fig { margin: 18px 0 0; padding: 16px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; }
.fig svg { display: block; width: 100%; height: auto; min-width: 720px; }
.fig figcaption { margin-top: 10px; font-size: 13px; color: var(--muted); }
.fig text { font-family: var(--sans); font-size: 12px; fill: var(--fg); }
.fig .t { font-size: 14px; font-weight: 600; fill: var(--fg-strong); }
.fig .tiny { font-size: 11px; fill: var(--muted); }
.fig .mono { font-family: var(--mono); }
.fig .box, .fig .diamond { fill: var(--card-2); stroke: var(--border); stroke-width: 1.2; }
.fig :is(.box, .pill):is(.good, .warn, .crit, .info, .id-1, .id-2, .id-3, .id-4, .id-5) { fill: color-mix(in srgb, var(--c) 16%, var(--card)); stroke: var(--c); }
.fig .box.mute { fill: none; stroke: var(--muted); stroke-dasharray: 4 3; }
.fig .pill-t { font-size: 10.5px; font-weight: 600; fill: var(--fg-strong); }
.fig .lane { fill: none; stroke: var(--border); stroke-dasharray: 3 4; }
.fig .lane-label { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; fill: var(--muted); }
.fig .edge { fill: none; stroke: var(--muted); stroke-width: 1.5; marker-end: url(#kz-ah); }
.fig .edge.good { stroke: var(--good); marker-end: url(#kz-ah-good); }
.fig .edge.crit { stroke: var(--crit); stroke-dasharray: 5 4; marker-end: url(#kz-ah-crit); }
.fig .edge-label { font-size: 11px; fill: var(--muted); }

.appendix { margin-top: 56px; padding-top: 24px; border-top: 2px solid var(--border); }
.appendix section { margin-top: 28px; padding-top: 18px; }
.provenance { max-width: none; margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
@media (max-width: 640px) { .page { padding-inline: 16px; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`;

const ARROW_MARKERS = `<defs>
  <marker id="kz-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: var(--muted)"/></marker>
  <marker id="kz-ah-good" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: var(--good)"/></marker>
  <marker id="kz-ah-crit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: var(--crit)"/></marker>
</defs>`;

// One paragraph that rides the canvas_publish tool description — the minimum
// contract every surface sees even without the chat guidance section.
export const CANVAS_PUBLISH_CONTRACT = [
  "Publish a designed, self-contained HTML page to the operator's canvas.",
  "The page renders in a sandboxed iframe that cannot fetch: inline all CSS/JS,",
  "no external scripts or stylesheets, system font stack only (font-family:",
  `${SANS_STACK}; never webfonts).`,
  "Style through CSS custom properties: define dark values in :root (keelson's default",
  'theme) and override in :root[data-theme="light"]; the host stamps and live-updates',
  "data-theme on <html>. Paint <body> from the tokens, because the frame's own ground is",
  "white. Declare any categorical chart palette on <body> as",
  'data-palette-dark="#hex,#hex,…" / data-palette-light="…"; publishing validates',
  "color-vision separation and surface contrast and REJECTS failing palettes, so fix the",
  "colors and call again. Re-publishing the same `name` updates that artifact in place.",
  "canvas_design_guide has a ready class kit, the house voice, and the layout, chart-form,",
  "color, and diagram rules.",
].join(" ");

// The standing chat section, injected only when canvas_publish is active this
// turn (the buildWorkflowGuidance pattern). Kept compact: depth lives behind
// canvas_design_guide.
export function buildCanvasArtifactGuidance(): string {
  return [
    "## Canvas artifacts",
    "",
    "You can publish designed, self-contained HTML pages (reports, briefings, charts, design explainers, dashboards) to the operator's canvas with canvas_publish (title, html, optional name; re-publishing a name updates it in place). Reach for it when the deliverable is a page someone will read, keep, or share; answer routine questions in plain chat, and prefer the structured board/view canvas for live operational status a rib already renders.",
    "",
    "The frame contract (sandboxed iframe, enforced):",
    "- No network: fetch/XHR are blocked; inline every style and script. Images/fonts may load from data:/https:, but a page should stand alone offline.",
    "- System font stack only, never webfonts or font data URIs.",
    "- Theme through tokens: define CSS custom properties on :root with keelson's dark values (dark is the default theme), override them under :root[data-theme=\"light\"], and style everything through the tokens. The host stamps data-theme on <html> and re-stamps it live on toggle. The frame's own ground is white, so <body> must paint var(--bg). Use this exact block as the base; it does that, and it carries the identity tones and font stacks:",
    "",
    "```css",
    designTokenCssBlock(),
    "```",
    "",
    "Build from the kit, not from scratch: canvas_design_guide 'kit' has ready classes for the masthead, summary box, legend, stat tiles, tags, tables, callouts, terminal output, and inline SVG diagrams, all on these tokens.",
    "",
    "Craft rules (the difference between generated-looking and designed):",
    "- Calibrate treatment: a working report gets clear hierarchy and quiet polish, not a flashy hero. Ground the page in its subject with real content and specific labels.",
    "- Typography carries the page: a deliberate type scale, ~65ch body measure, text-wrap: balance on headings, letter-spaced uppercase for eyebrows/labels, font-variant-numeric: tabular-nums wherever digits align.",
    "- Layout spaces siblings with flex/grid gap, never stacked margins; wide tables/code/diagrams scroll inside their own overflow-x container; respect prefers-reduced-motion.",
    "",
    "Copy follows keelson's house voice (canvas_design_guide 'voice'): lead with the state, use keelson's own terms (run, node, workflow, rib, project), point every claim at its evidence (run id, node id, file:line, command), write \"not measured\" rather than a zero or \"no issues\" when nothing was checked, and speak as the page, never as the agent. No em dashes.",
    "",
    "Chart rules (non-negotiable):",
    "- Series identity comes from the keelson series slots (--s1…--s6) assigned in order: never invent hues, never cycle, never color by rank. A 7th series folds into 'Other'.",
    "- Status colors (--good/--warn/--crit) mean state; they never impersonate a series. Identity tones (--id-1…--id-5) mean who; they never impersonate either. One y-axis, never two. Direct-label sparingly plus a legend for 2+ series; text wears ink tokens, never the series color.",
    '- Declare every categorical palette on <body data-palette-dark="…" data-palette-light="…"> (comma-separated hex, in slot order). canvas_publish validates CVD separation and surface contrast per theme and rejects hard failures with a report; fix and retry. The token slots above already pass.',
    "",
    "Before authoring anything nontrivial, call canvas_design_guide: 'kit' (the ready classes and markup), 'voice' (how a keelson page reads), 'page' (page types, layout, typography, theming), 'form' (which chart fits the data, or no chart), 'color' (the five color jobs and the keelson instance), 'marks' (mark anatomy, labels, hover), 'graphics' (inline SVG diagrams: which shape fits the mechanism, box rhythm), 'board' (the structured view: which section kind fits which data), 'anti-patterns' (the catalog of what goes wrong; check your draft against it).",
  ].join("\n");
}

// On-demand reference sections behind canvas_design_guide — the deep corpus,
// adapted to the keelson frame contract. Each stands alone; agents read only
// what the task needs.
export const CANVAS_DESIGN_GUIDE_SECTIONS: Readonly<Record<string, string>> = {
  kit: `# Kit: ready classes for a canvas page

Materials, not a layout. Put this whole stylesheet in the page's <style>: it opens with the keelson token block (which also paints <body>), then the classes. Compose only the pieces the content needs, and add page-specific rules after it, reading the same tokens. Every rule reads a token, so the theme toggle rethemes the whole page, diagrams included. Spend the effort on content and drawings, not on re-deriving CSS.

Tones are one vocabulary. Add .good, .warn, .crit, or .info (state) or .id-1 to .id-5 (who) to a legend item, tag, stat, callout, meter, diagram box, or pill, and it sets --c for that element. A state tone always rides with a word; an identity tone always has a legend entry.

\`\`\`css
${designTokenCssBlock()}

${KIT_CSS}
\`\`\`

Page opening. A design explainer uses the summary box; a run report swaps it for stat tiles.

\`\`\`html
<div class="page">
  <p class="eyebrow">keelson · workflows · run report</p>
  <h1>Headline that states the finding</h1>
  <p class="lede">One sentence the reader keeps, with the <b>key number</b>.</p>
  <div class="summary">
    <p>What happens today, and why it is a problem.</p>
    <p>What this change or run does.</p>
    <p>What it does not do, check, or guarantee.</p>
  </div>
  <ul class="legend">
    <li class="id-1">Server · owns state and providers</li>
    <li class="id-2">Rib · contributes the tool</li>
    <li class="mute">Dashed · present but unused</li>
  </ul>
  <section><h2>Failed nodes</h2> … </section>
  <p class="provenance">run 7f3a2c · window last 7 days · generated 2026-09-23 14:05 UTC</p>
</div>
\`\`\`

Stat tiles, tags, and a meter. A toned tile carries its word in a tag:

\`\`\`html
<div class="stats">
  <div class="stat"><div class="v">412</div><div class="l">runs, last 7 days</div></div>
  <div class="stat crit"><div class="v">9</div><div class="l">failed <span class="tag crit">needs review</span></div></div>
</div>
<div class="meter warn"><span style="width: 62%"></span></div>
\`\`\`

Table. Wrap it so a wide table scrolls inside itself, never the page:

\`\`\`html
<div class="scroll"><table class="tbl">
  <thead><tr><th>Node</th><th class="num">Duration</th><th>State</th></tr></thead>
  <tbody><tr><td><code>build</code></td><td class="num">1 min 12 s</td><td><span class="tag good">succeeded</span></td></tr></tbody>
</table></div>
\`\`\`

Callout and terminal. Reproduce a real command's output shape; never invent one:

\`\`\`html
<div class="callout warn"><p class="eyebrow">Limit</p><p>What the check does not prove.</p></div>
<pre class="term"><span class="d">$</span> keelson workflow run smoke-test
<span class="ok">✓</span> smoke-test succeeded in 4.1 s</pre>
\`\`\`

Diagram. Put the arrow markers in the first figure only; later figures reuse the ids. Boxes follow the rhythm in section "graphics":

\`\`\`html
<figure class="fig">
  <svg viewBox="0 0 1000 140" role="img" aria-label="At boot the server discovers the rib and registers its tool for agent turns.">
    ${ARROW_MARKERS.replace(/\n/g, "\n    ")}
    <rect x="8" y="8" width="984" height="124" rx="10" class="lane"/>
    <text x="24" y="30" class="lane-label">At boot</text>
    <rect x="24" y="44" width="200" height="76" rx="8" class="box id-1"/>
    <text x="36" y="68" class="t">server</text>
    <text x="36" y="88">scans installed ribs</text>
    <text x="36" y="109" class="tiny mono">@keelson/rib-*</text>
    <path d="M224 82 H292" class="edge"/>
    <text x="258" y="74" class="edge-label" text-anchor="middle">loads</text>
    <rect x="296" y="44" width="200" height="76" rx="8" class="box id-2"/>
    <text x="308" y="68" class="t">rib</text>
    <text x="308" y="88">returns its tools</text>
  </svg>
  <figcaption>Figure 1. One sentence stating what the drawing shows.</figcaption>
</figure>
\`\`\`

Close with .provenance, and put reference material (full id tables, alternatives not chosen, raw payloads) in a lettered .appendix after the body.`,

  voice: `# Voice: how a keelson page reads

A keelson page is read by the operator who ran the work, usually later and usually to decide something: merge it, rerun it, fix it, or send it on. Write practitioner to practitioner. Say what is true about the work, plainly, and make it easy to check.

State first. The headline and the first sentence say where things stand: what succeeded, what failed, what is waiting on the operator. How it got there comes after, and only as much as the reader needs to act.

Keelson's words, not synonyms. Use the names the app and the docs use, every time: run, node, workflow, rib, project, provider, board, artifact, approval gate, op. The operator matches the page to the UI by name, so "execution", "plugin", "step", or "job" for the same thing sends them looking for something that does not exist. The nautical metaphor lives in the product name; never invent a nautical name for something that already has a plain one.

Every claim carries its evidence. A sentence about the work points at what proves it: a run id, a node id, a file and line, a PR number, the exact command. A reader should be able to check any sentence without asking.

Unknown is a word, not a zero. When a collector failed, a check never ran, or a number was not measured, write "not measured" and say why. An empty result that reads as good news ("no failures") when nothing was checked is the most expensive sentence a page can carry.

Claim only what happened. Report what the run did, not what it was meant to do. A partial result says partial and names the missing part. Never promise behavior the harness does not ship.

Numbers keep their units and their window: "412 runs in the last 7 days", "p95 3.2 s", "41k tokens on copilot". Times are absolute (2026-09-23 14:05 UTC), with a relative gloss ("2 h ago") when recency is the point.

Say what the page leaves out. One line near the top or in the provenance: what was not checked, which projects or dates fall outside the window.

The page speaks, not the agent. No "I", no "we found", no narration of the work ("after analyzing the logs", "let me"), no notes about how the page was made. Results in the present tense, events in the past.

Plain verbs over grades. "3 of 12 nodes retried" beats "the run was mostly stable". Cut praise and hype (robust, seamless, powerful, comprehensive), hedges (seems, arguably), filler (simply, just, basically, leverage), and quantified hype.

Each thing once, in its best form: a table compares, a diagram shows shape, prose states behavior and limits. A paragraph never restates the table above it.

Controls say what happens: "Rerun failed nodes", not "Continue". An error says what went wrong and what to do next.

Mechanics: sentence case for headings and titles; capitals only in the small mono labels the kit sets. No em dashes or en dashes; use a comma, a colon, parentheses, or two sentences. Active voice, short sentences. Every figure gets one sentence of lead-in above it and a figcaption stating what it shows.

Rewrites:
- "The workflow executed successfully and everything looks good!" becomes "Run 7f3a2c succeeded: 12 of 12 nodes in 4 min 10 s."
- "No test failures were detected." (the tests never ran) becomes "Tests not run: node test was skipped because build failed (exit 1)."
- "I analyzed the plugin's pipeline steps and found some issues." becomes "2 of 9 nodes in the rib's refresh workflow fail on a missing credential (node fetch-token)."`,

  page: `# Page design for canvas artifacts

Read the request first and calibrate treatment. Most artifacts are working documents: a run report, an audit, a briefing. They deserve real typographic hierarchy, considered spacing, and a proper palette, delivered quietly: no giant hero, no scattered animation. Reserve editorial flourish (an orchestrated reveal, a display-size masthead) for pages explicitly meant to impress, and even then spend boldness in one place and keep everything around it calm. Start from the kit (section "kit") and write the copy in the house voice (section "voice").

Pick the page type by what the reader will do with it:
- Run report or audit (the reader checks an outcome): masthead, a lede with the key numbers, stat tiles, sections in order of importance, provenance.
- Design explainer (the reader judges or builds a change): a summary box of three short paragraphs (what happens today and why it is a problem, what the change does, what it does not do or guarantee), then a legend giving each actor one identity tone, then sections that answer the reader's next question in order, then a lettered appendix for id tables, exhaustive lists, raw payloads, and alternatives not chosen.
- Comparison or decision (the reader picks): the options in one table, or two diagrams with the same shape so the difference is the only thing that moves. Alternatives not chosen go to an appendix table of alternative and why not.
- One-pager (the reader scans once): show the whole subject first with its parts named, then a close-up of each part. One organizing set, not several competing counts.

Structure:
- Name the artifact like a product, not a caption: the title is a short, specific noun phrase (two to four words) that identifies this page among many. Never a generic category label ("Status Report"), and never a name with an appended explainer ("Keelson Audit: a review of…").
- Open with a masthead that orients: an eyebrow label (mono, uppercase, letter-spaced), a headline that states the finding (not the topic), and a lede with the key numbers bolded. Section headings below it are plain labels ("Failed nodes", "Cost by provider"); only the headline argues.
- Stat tiles for the 3 to 5 figures that matter, before any detail. Encode state in form as well as number (a toned left rule plus a status word) so what needs attention reads at a glance.
- Sections in reading order of importance; a labelled group ("P0 · do first") encodes real priority, and numbered markers appear only when order genuinely carries information.
- Counts agree everywhere: the number in the lede, the tiles, the diagram, and the table describe the same set, or the page says why they differ.
- End with provenance: how the content was produced, its data window, generated-at.

Typography: var(--sans), the system stack, for everything (the frame never loads webfonts); var(--mono) for eyebrows, code, identifiers, and aligned figures. Set a scale and stay on it; body measure ~65ch; headings get text-wrap: balance; tabular-nums for every column of digits.

Theming: define ALL color as custom properties, dark values on :root (keelson's default) and light overrides on :root[data-theme="light"]. Never style a component with a raw hex; the toggle must retheme everything. Paint <body> from the tokens (the token block does): the frame's own ground is white, so a transparent body shows dark-theme ink on a white sheet. Give the second theme the same care: don't naively invert, keep contrast legible, re-tune shadows. The host stamps data-theme on <html> and updates it live; color-scheme rides the token block so form controls and scrollbars follow.

Build with real content, never lorem.

Craft floor: close every element, double-quote attributes, visible keyboard focus, prefers-reduced-motion honored, no horizontal page scroll (wide content scrolls inside its own container), overlapping or absolute positioning only with a reason.`,

  form: `# Choosing the form

The data's job picks the form, and sometimes the answer is not a chart.

- One headline figure → a stat tile or hero number with a label and delta, not a one-bar chart.
- Magnitude comparison across categories → horizontal bars, sorted by value (alphabetical only when lookup order matters). Nominal categories all wear the SAME slot-1 hue: bar length already encodes the value, and color would re-encode it.
- Change over time → line (or area for cumulative). Emphasize the endpoint; label the last value directly.
- Composition of a whole → stacked bar or segmented strip. Avoid pie charts beyond 3 slices; never 3D, never donut-with-legend-soup.
- Distribution → histogram or dot strip. Correlation → scatter (validate palette with all-pairs separation).
- A process with stages → ordered gauges/funnel using an ordinal one-hue ramp (light→dark encodes the order), not categorical hues.
- Status of many items → a grid/board of labelled cells with toned badges; state is a word plus a tone, never color alone.
- Tri-window trends (before/mid/now) → small per-item gauge triplets with a trend arrow, like a fail-rate board.

If swapping category order would change the meaning (stages, tiers, buckets) it is ordinal: one hue, monotone lightness steps. If not (teams, services, models) it is nominal: series slots in fixed order.

Tables beat charts when the reader needs exact values or many dimensions; a chart earns its place by making one comparison obvious. When a chart has 2+ series, a legend is mandatory and ≤4 series should also be direct-labeled.`,

  color: `# Color: five jobs, one instance

Every color does exactly one job; palettes are validated, never eyeballed.

1. Categorical (which series): the keelson series slots in fixed order, dark ${dark.series.join(", ")} / light ${light.series.join(", ")}. Assign in sequence, never cycle, never reorder, never invent a 7th hue (fold into "Other"). The order is part of the validated set.
2. Sequential/ordinal (how much, which stage): one hue, monotone lightness. Build ramps from the slot-1 hue family; the palest step must still clear ~2:1 against the surface.
3. Status (what state): --good ${dark.green}/${light.green}, --warn ${dark.yellow}/${light.yellow}, --crit ${dark.red}/${light.red}, --info ${dark.cyan}/${light.cyan} (dark/light). Reserved meaning; always paired with an icon, glyph, or word, never color alone, never reused as "series 4". When a series MEANS pass/fail it wears status tokens; when it is just identity it wears series slots. Never both in one chart.
4. Identity (who): --id-1 to --id-5, dark ${Object.values(dark.identity).join(", ")} / light ${Object.values(light.identity).join(", ")}. They mark actors and owners in diagrams and tables: a repository, a role, a system, a provider. Give each actor one tone in a legend near the top, then use that tone for that actor on every figure and table, and for nothing else. Identity is never a chart series and never a state. It fills swatches, strokes, and tints; the text beside it stays in ink. --id-2 (amber) sits next to --warn, so on a page that shows warnings, assign actors --id-1, --id-3, --id-4, and --id-5 before --id-2.
5. Ink: text always wears ink tokens (--fg, --fg-strong, --muted). A value label never wears its series color; the colored mark beside it carries identity.

Surfaces: charts render on --card (dark ${dark.card} / light ${light.card}); the app plane is --bg (${dark.bg} / ${light.bg}). Contrast is only meaningful against the actual surface.

The validation contract: declare each categorical palette on <body data-palette-dark="…" data-palette-light="…"> in slot order. canvas_publish computes OKLCH lightness band, chroma floor, CVD (protan/deutan) separation, and WCAG contrast per theme. Hard failures reject the publish with a per-check report: change the colors (usually by using the token slots), don't fight the checks. Floor-band CVD and sub-3:1 contrast pass as warnings that OBLIGATE secondary encoding: direct labels, visible gaps, or an adjacent table.

Never: rainbow ramps, dual-hue "heat" without a neutral midpoint, red/green as the only distinction between two series, series colors picked for looks.`,

  marks: `# Marks, anatomy, interaction

Marks: thin bars (rounded only at the data end, anchored to a flat baseline), 2px lines, ≥8px markers. Separate touching fills with a 2px surface-colored gap (stacked segments, adjacent bars). Grid is hairline and recessive (--border at reduced opacity); axes are quieter than data; drop the chart's outer box.

Labels: axis and tick text in --muted, 11 to 12px, tabular-nums. Direct-label the endpoint of each line and the largest few bars; never every point (that is a table wearing a costume). A legend accompanies 2+ series always; a single series needs none (the title names it).

The gauge/meter pattern (fits the frame with zero dependencies; the kit's .meter): a labelled track (background --card-2, 1px --border, radius) with a fill span whose width is the percentage and whose color is a status or series token, the value in mono beside it. Triplets of these with a trend arrow (▲ worsening / ▼ improving, colored by DIRECTION-AS-STATUS plus the glyph so it is never color-alone) make a compact before/mid/now board.

Stat tiles (the kit's .stat): value in mono at 28 to 32px with tabular-nums, label beneath in --muted at ~12px, an optional left rule carrying tone. Tiles sit in a responsive grid (repeat(auto-fit, minmax(160px, 1fr))).

Interaction inside the frame: hover affordances are welcome (CSS :hover reveals, a title attribute for exact values, a details/summary disclosure for long tails) but must be enhancement only. Every value stays readable without hover, since the artifact may be exported or printed. Script is available (inline only) for tabs and filters; keep state in the page, remember there is no network, and never trap keyboard focus. Actions back to the host go through keelson.action(type, payload) or data-canvas-action attributes, which only mean something when a rib owns the artifact's key and gates those verbs.`,

  graphics: `# Inline SVG graphics and diagrams

When a picture earns its place (a topology, a pipeline, a lifecycle, a seam the prose keeps gesturing at), draw it as inline SVG in the page. A diagram earns its place by showing MECHANISM: what feeds what, where the boundary sits, which path the data takes. If it only decorates, cut it. Test it by deleting the labels: if the structure alone no longer says anything, redraw it. Never emoji-art, never an external image (the frame has no network), never an icon font.

Name the shape of the mechanism before drawing, then pick the form:
- Stages in order: boxes left to right joined by edges, or one lane per stage stacked top to bottom with one edge dropping between lanes.
- Ownership across a seam: owner, the contract between them, owner, in one row.
- A decision: a diamond holding the real condition name in mono, one leaf box per outcome; each leaf says who lands there, and a failure leaf says what happens next.
- Before and after, or two options: two lanes with the same left-to-right shape, so the difference is the only thing that moves.
- Many callers, one path: several small boxes whose edges converge on one node. One input, several consumers: the same, reversed.
- An assembly: stacked boxes inside the owner's box, each toned by who contributes it, the part that runs first on top.
- Levels of authority: a staggered ladder, with a dashed floor for the level that is not a rung.
A list of facts is a table and a single path with no branch is a sentence: draw neither.

Box rhythm (the kit's .box, .t, and .tiny classes): every box reads the same way, so a reader who parses one knows them all. Title baseline at +24 from the box top, one or two detail lines at +44 and +61, a small caveat line at +82; text starts 12 in from the left edge. A box with one detail line is 76 tall; with two plus a caveat, 96. Width budget: about 6 viewBox units per character at 12px, so a 188-wide box holds about 28 characters. When a label won't fit, shorten the label; never shrink text below 11.

Color in a diagram follows the page legend: each actor wears its --id-* tone in every figure; .good and .crit appear only on outcomes (an allowed leaf, a failing edge); a dashed .mute box means present but unused, and the legend says so in words, never by line style alone. When a mark has a recipient or owner, put it on the mark as a pill (.pill plus .pill-t); a caption the reader has to match to an element is not enough.

Edges: the kit's .edge (.edge.good for an allowed path, .edge.crit dashed for a failing one) with one set of arrow markers defined in the first figure. Label an edge with its verb (writes, polls every 30s) when its two ends don't already say it; one or two words, placed where no later shape paints over them, since SVG paints in document order.

What keeps hand-authored SVG working here:
- Theme through the page's tokens: inline SVG inherits CSS custom properties, so the kit's classes (or var(--fg), var(--border), var(--card-2), var(--id-1)… directly) do the coloring. Never hardcode a hex only one theme can read; the host re-stamps data-theme live and the diagram must follow.
- viewBox width 960 to 1120 and height fit to the content plus 12 of margin. The kit's .fig scrolls a drawing on a phone instead of shrinking it, so never design for a narrow viewBox. Text at ≥11 viewBox units in the page's font stack; tabular-nums where figures align.
- Structure over path-art: compose rects, lines, circles, and text from coordinates you compute, snapped to a grid (multiples of 8) so alignment reads as designed. Long freehand path data is where hand-authored SVG goes wrong; if a shape needs one, simplify the shape.
- Ink discipline carries over: node fills are --card/--card-2 or an identity tint, with ink-token labels; the accent marks the ONE thing the diagram exists to point at; series colors only for series identity; status colors only for state, never decoration.
- Label shapes in place; the page legend covers identity tones, so a figure needs its own legend only for an encoding the page legend lacks. Connective tissue stays quieter than nodes.
- Flows read left→right or top→bottom. Route edges around nodes, never through them; a crossing the eye must untangle costs more than a longer path.
- Wrap each drawing in <figure class="fig"> with one sentence of lead-in above it and a figcaption stating what it shows. Every <svg> carries role="img" and an aria-label saying what it shows, not "diagram".`,

  board: `# Board design: the structured view

A board (view: "board") is typed sections the host renders. The producer decides WHAT to say and which primitive says it; the host owns pixels, theme, and interaction, so a board can never go off-palette. Boards are for live operational state a producer recomposes; reach for an html artifact when the deliverable is a designed page someone keeps or shares. Board copy follows the house voice too (section "voice").

Pick the section by the data's job:
- The 3 to 5 figures that matter now → stats. A change reading is structured: delta { text, direction, tone }. Direction picks the glyph (▲ ▼ →); tone is a status tone (ok/warn/error/neutral/info/caution) saying whether the move is good (an error-rate ▲ wears error; a throughput ▲ wears ok). spark (2 to 60 numbers, oldest first) adds trend context behind the value; the value and delta must carry the reading without it. A time that should stay current ("4 min ago", "53 min left") is clock { at, mode: "since" | "until" } in place of value, on a stat or a card field; the host re-ticks it between frames, so never republish just to refresh one.
- Composition of a whole → segments (one proportional strip), never a table of percentages.
- Magnitude across categories → bars (value/total rows; inline for a dense offender list), or chart with mark: "bar" when grouped series per category matter.
- Change over time → chart: mark "line" (default); "area" for cumulative/volume emphasis (overlaid, not stacked, because composition belongs to segments); "bar" renders x as ordered categories, zero-anchored. ≤6 series, fixed-order palette slots, one y-axis. baseline "auto" (line only) releases the zero anchor so variation inside a narrow band (a 93 to 99% pass rate) fills the plot. Use it when the story is the variation, not the magnitude; bars and areas always anchor at zero.
- Exact values, many dimensions → table (toned cells; badges for grades and counts).
- Entities with identity and verbs → cards (grid + columns for benches; ghost seats for open capacity; boxed for copyable credentials). A card's bar carries per-entity progress: { value, total } for a plain fill, { segments } for stage composition at card scale. label/trailing caption the meter itself ("Turn budget used" · "18 of 80") rather than a field under it. prose flips the fields to a scrolling document (a charter, a brief) in proportional type; stacked stays the line-oriented mono readout. A card sets one, not both.
- Event feed or status checklist → rows (boxed flips it to label:value cards). Rows carry the cards click contract (action/selected for an overview list feeding an inspector, bar for a compact per-row meter), so choose cards vs rows on density alone, never because only one can be selected.
- At-a-glance matrix or link strip → grid cells with toned badges.
- A form input that depends on another → showWhen { field, equals? } on the action field holds it back until that field has a value (a workflow picker after a project); a hidden field never dispatches.
- A sequence where order is the story → journey; a fixed-capacity identity row → seats.
- Verbs → one actions section (tabs for a mode picker, wrap for a chip strip); destructive verbs confirm, disabled ones carry reason. iconOnly + align: "end" pins a glyph-only corner affordance whose label stays the accessible name. binding is the integrity-protected payload slot, merged after collected fields, so producer-stamped context (a fingerprint, a target identity) can never be shadowed by a form field. pendingLabel ("Sending…") replaces the button text while the dispatch is in flight; the rib's onAction returns data.message to word the success toast.

Unmeasured is not zero: when a collector fails, say so in the data (n: null on a segment, value: null on a bar or stat) and the host renders a hatched slot or a muted "?". Three states, three renderings: a real zero shows 0, unmeasured shows the hatch, absent is not emitted. Never substitute 0 for a failed read; that renders a broken collector as good news.

Hierarchy: summary before detail, so stats/segments first and tables and feeds after. One board answers one operator question, and header.status answers it fastest; don't repeat one fact across three sections. columns is layout only (one level deep) for genuinely side-by-side content, not a way to cram more in.

Tone discipline mirrors the color jobs: ok/warn/error/info/caution are state; id-* are actors (assigned once, always named, never status); ramp-1…5 is ordered magnitude; brand/accent are identity chrome. A number that is not a judgment wears NO tone; an all-toned board says nothing. Direction is never color-alone: the delta glyph rides regardless of tone. A card's edge (a tone) is a colored left rule for the one card that needs attention; the card still says why in text.

Board anti-patterns: a stats item per data row (stats summarize; the data is a table); tone on every value; a chart for two points (a delta says it better); segments with one segment; cards for what is really a table; verbs scattered across sections instead of one actions strip; free-text trend arrows in sub (that is what delta is for); a spark whose story the value and delta don't already tell; a 0 (or a dropped segment) standing in for a failed read, when unmeasured is null and renders hatched.`,

  "anti-patterns": `# Anti-patterns: check your draft against this list

Color:
- Series colors invented or cycled instead of taken from the slots in order.
- A palette that fails validation "fixed" by removing the data-palette declaration instead of fixing the colors.
- Status hues doing series work, or a series that means pass/fail wearing categorical hues.
- An actor wearing different tones in different figures, or an identity tone with no legend entry.
- An identity tone that reads as a state in the same figure (--id-2 amber beside a --warn outcome).
- Value text tinted with its series color; identity color without an accompanying name/label.
- A sequential ramp jumping hue families; a diverging scale without a neutral midpoint; any rainbow.

Charts:
- Two y-axes. Always two charts or an indexed common base instead.
- A number on every point; a legend for a single series; gridlines louder than data.
- Pie charts past 3 slices; 3D anything; bars not anchored at zero.
- Nominal bars painted by value (length already says it) or by rank (color follows the entity, never its position).

Page:
- Raw hex scattered through component CSS instead of tokens (the theme toggle breaks).
- A transparent <body>: dark-theme ink on the frame's white ground.
- Webfonts or font data URIs (blocked/bloated); icon fonts (use inline SVG or glyphs).
- External scripts, stylesheets, or fetch calls; the CSP blocks them and the page must be self-contained.
- A giant editorial hero on a working report; emoji as section markers; everything centered; purple-gradient-on-white template smell.
- The generated-look cluster: an accent bar/rail on every rounded card (an accent rule earns its place encoding state, not as template chrome); rounded-everything at one radius; three-column icon-feature grids; a "premium" serif display + terracotta scheme pasted onto an operational report.
- Numbered section markers (01/02/03) where order carries no information.
- A title that is a category label or carries its own explainer after a dash or colon; name the page, put the explanation in the body.
- Light theme as an afterthought: unreadable muted text, inverted shadows, washed-out accents.
- Horizontal page scroll from a wide table or diagram (wrap it in its own overflow-x: auto container).
- Motion without prefers-reduced-motion guards; hover-only information.

Copy:
- An unmeasured value shown as a zero, or an unchecked area reported as "no issues".
- Synonyms for keelson's own terms (plugin for rib, job or execution for run, step for node).
- The agent narrating its process ("I analyzed…", "let me") or grading its own result ("everything looks good").
- A claim about the work with no run id, node id, path, or command to check it against.
- Counts that disagree between the lede, the tiles, the diagram, and the table.
- The same fact explained in prose, again in a table, and again in a diagram.
- Em dashes, Title Case headings, hype adjectives.

Diagrams:
- Decorative diagrams that show no mechanism; clip-art SVG blobs behind headings.
- A caption the reader must match to an element instead of a label or pill on the mark itself.
- Hardcoded hex inside an svg (breaks the live theme re-stamp); labels in a series color instead of ink.
- Freehand path data for what rects/lines/text express; edges through nodes; arrowheads louder than the shapes they connect.
- Labels running past a box's edge; text shrunk below 11 to make it fit.

Process:
- Publishing without validating a declared palette, or never declaring one on a page with categorical series.
- Rebuilding an artifact under a new name for an update; re-publish the same name so the operator's canvas updates in place.`,
};

export const CANVAS_DESIGN_GUIDE_SECTION_NAMES = Object.freeze(
  Object.keys(CANVAS_DESIGN_GUIDE_SECTIONS),
) as readonly string[];

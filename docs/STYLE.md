# Keelson documentation style guide

This is the authoritative source of consistency for the keelson documentation
set. Read it before writing or generating any page. It is the law; when in doubt,
it wins.

This whole directory (`docs/`) is the Astro Starlight project. It has two parts
that share one identity:
- a **bespoke landing** at `public/index.html`, hand-authored static HTML on
  `public/assets/keelson.css`. It is the marketing showcase and the design source
  of truth. It is served verbatim from `public/`.
- the **docs tier** (concepts, guides, tutorials, workflows, reference, design), built with
  **Astro Starlight** under `src/content/docs/docs/`, themed to the same blueprint
  identity, authored in Markdown/MDX.

`astro build` emits both to `dist/` (the landing at `/`, the docs under `/docs/`)
for GitHub Pages. Diagrams are committed as source plus a rendered image, or
embedded as MDX components. See "Docs framework" below for how the identity maps
onto Starlight.

**Reference implementations (the design source of truth, do not start blank):**
- `public/index.html` — the landing. The blueprint drafting-sheet treatment, the
  hero pattern, and the feature tiles.
- `src/content/docs/docs/concepts/architecture.mdx` — the canonical Starlight
  topic page. Big-idea intro, the hull figure, a reference table, `<Steps>`, and
  an `<Aside>` boundary-rule callout. Copy its structure and voice for new pages.

## Voice

- Engineering-honest, practitioner to practitioner. Keelson is a harness for
  builders, not a consumer app. Say true things plainly. No marketing register,
  no quantified hype ("90% faster"), no "Generated with" footers.
- **Ship-honest.** Keelson is beta. Claim only what genuinely ships. Do not
  tout capabilities that are dormant or partial. Specifically keep out of
  headline copy: the console redaction pipeline (wired but inactive), durable
  cross-restart resume (resume is process-lifetime only), and a full offline
  story (the CLI's server-down fallback runs the stub provider only). Ground
  every claim in the actual code.
- **Keelson is useful on its own.** Never imply a rib is required for keelson to
  be useful. The built-in Chat, Workflows, and Memory surfaces ship and work
  standalone with just a provider; ribs extend the harness, they do not enable
  it. Positioning copy names that standalone value before it reaches for ribs.
  ("The agent ships with no tools until a rib registers them" is a narrower, true
  claim about tools, fine where the context is genuinely about tools.)
- Seat the nautical metaphor once, prominently, then switch to the codebase's
  own vocabulary. The keelson-is-the-backbone, ribs-are-the-frames idea earns one
  clear statement per audience entry point. Do not invent nautical names for
  things that already have plain names (snapshot, surface, region, provider,
  workflow node). The metaphor lives in the name, the tagline, and the figures,
  not in the API.
- Reference and contract pages are terse and precise. Tutorials are warmer and
  second person ("you run", "you will see"). Concept pages explain why before how.
- Prefer active voice and short sentences. Bold the lead-in of a point when it
  helps scanning.

## Hard rules

- No em dashes anywhere. Use a comma, a colon, parentheses, or two sentences.
- No ASCII-art diagrams. Use a bespoke SVG, an excalidraw figure, or a mermaid
  block.
- No point-in-time narration ("per review", "addresses issue N", "M5 shape
  evolved"). That belongs in commit messages, not in docs prose.
- American spelling. Sentence case in body prose. Display caps are only for the
  page hero h1 and the small uppercase labels the stylesheet already sets.
- Every figure gets a one-sentence lead-in in the prose above it and a numbered
  figcaption ("Figure 1. ..."). Never drop a figure in cold.
- Keelson does not document specific ribs (osdu, chamber). Those live in their
  own repositories. Document only the generic, reusable rib contract.

## Information architecture

Tiered by audience. Plain folder names; the flavor lives in the visuals and the
prose, not in cute paths.

- `index.html` — the landing. What keelson is, for an evaluator.
- `concepts/` — the mental model: `architecture`, the metaphor, a `glossary`.
- `guides/` — task-oriented operator how-tos (install, run, install a rib,
  author workflows, configuration).
- `tutorials/` — a problem-first learning rail, each page handing off to the
  next. The capstone is the multi-model "one workflow, many models" build.
- `workflows/` — the catalog of bundled starter workflows: an index that groups
  what ships by purpose, plus a node-by-node walkthrough per workflow (the shape
  as a figure, every node in a table, the patterns each one demonstrates). Worked
  examples that bridge the `guides/` recipes to the real multi-node workflows.
- `reference/` — the contract tier: `rib-contract` (the centerpiece, built on the
  contract-doc template: Overview, Terminology, Interface, Validation Rules,
  Lifecycle, Example), `snapshots`, `workflow-nodes`, `cli`, `providers`.
- `design/` — decision records and a candid `learnings` page. The right home for
  design narrative the source comment policy keeps out of code.

## The visual system: keelson blueprint

One identity carries the whole set: deep-navy structure, a single brass accent
against the cool palette, a faint blueprint grid. All of it lives in
`assets/keelson.css`. Do not fork the palette per page.

Palette tokens (CSS variables in `keelson.css`):

| Token | Value | Means |
|---|---|---|
| `--keel` | `#1e3a5f` | the harness / backbone (structure) |
| `--rib` | `#2f6fb0` | a rib / something attached |
| `--brass` / `--brass-ink` | `#b5803a` / `#8a5a1f` | emphasis and interaction |
| `--ink` / `--muted` | `#0f1b2d` / `#51607a` | body text / secondary text |
| `--green` | `#2f8f5b` | success and confirmation |

Component vocabulary (classes in `keelson.css`, reuse these, do not invent new
chrome): `site-header` / `brand` / `nav`, `hero` + `hero-card` (the big-idea
aside), `guide-layout` with sticky `side-nav`, `card-grid` + `link-card` (a hub),
`content-card`, `steps` / `step`, `callout` (brass) and `callout-keel` (blue),
`info-table`, `diagram-figure` (light frame, for diagrams) and `screenshot-figure`
(dark frame, for app screenshots), `code-sample`, `related`, `page-footer`.

### Layout widths

A wide container with a readable measure, the documentation standard.
- Doc pages (`guide-shell`) cap at 1320px; the landing sheet caps at 1480px and
  centers. Below ~1180 feels cramped, above ~1480 wastes the screen.
- Prose keeps a ~72-character measure (`.content-card > p / ul / ol` cap at
  `72ch`), so paragraphs do not run the full column. Tables, figures, and code
  use the full width. Body prose is 15px.

### The landing is a drafting sheet

The landing (`index.html`) is themed as a blueprint drawing sheet, distinct from
the calmer doc pages: a two-tier blueprint grid, L-shaped corner crop marks (no
enclosing border, which reads as a heavy box), a thin "drawing viewport" around
the hero figure with a `FIG.` tag, and an engineering title block at the foot of
the sheet (project / title / status / license / runtime / providers). Doc pages
stay calmer for reading and inherit only the shared palette and faint grid.

## Docs framework: Astro Starlight

The docs tier runs on Astro Starlight, chosen because keelson is a Bun/TypeScript
monorepo: Starlight is TS/Node-native (no second toolchain), authors in
Markdown/MDX, and ships search, sidebar nav, and dark mode. The bespoke landing
stays hand-authored; only the docs tier is framework-driven.

Keep the blueprint identity by theming, not by fighting the framework:
- Map the keelson palette onto Starlight's CSS custom properties in a custom CSS
  layer: the accent becomes brass, structural text and borders track navy
  (`--keel`), and the page carries the faint blueprint grid. `keelson.css` tokens
  are the single source of color.
- Type: Inter for prose, a monospace stack for labels and code, as on the landing.
- One custom MDX `Figure` component renders the `diagram-figure` frame plus a
  numbered caption, so the lead-in + caption rule is enforced by the component;
  the ship SVG and excalidraw exports embed through it.
- Callouts use Starlight asides restyled to the brass and blue variants; hubs use
  Starlight card grids. The contract-doc template (Overview, Terminology,
  Interface, Validation Rules, Lifecycle, Example) is an MDX page pattern.
- The `starlight-llms-txt` plugin emits `/llms.txt`, `/llms-full.txt`, and
  `/llms-small.txt` at build (the llmstxt.org convention), deployed with the site.

### Routes and navigation

The IA is the single source for both Starlight's sidebar and the landing's nav;
keep them in sync.
- Landing at `/`. Docs under `/docs/`, one folder per IA section:
  `/docs/concepts/`, `/docs/guides/`, `/docs/tutorials/`, `/docs/workflows/`,
  `/docs/reference/`, `/docs/design/`.
- The landing is the bridge into the docs: the **Read the Docs** button targets
  `/docs/`, and the header nav links the top sections a newcomer needs
  (Concepts, Guides, Reference). The brand returns to `/`; **View on GitHub** is
  the repo. These resolve once the Starlight site is scaffolded.

## The landing hero pattern

The hero splits the work between the eyebrow and the headline so product and
metaphor land together:
- **Eyebrow** states the product: "A local agent harness".
- **Headline** carries the metaphor: "Lay the keel. Raise the ribs.", sized to
  sit on two balanced lines (not the dramatic four-line stack). Both keel and
  ribs are named.
- **Copy** maps the metaphor to the product: "The harness is the keel, the part
  that ships, and it is useful on its own. Ribs are the capabilities you bolt on
  for more." It names the standalone value before reaching for ribs (the
  standalone-useful voice rule). Do not repeat "local" in the copy; the eyebrow
  carries it.

## Feature tiles

Six single-word tiles in one row, grounded in capabilities that genuinely ship
(the ship-honesty rule applies hardest here). The three built-in surfaces lead:

| Tile | Line |
|---|---|
| Chat | Talk to the agent with every rib tool on tap. |
| Workflows | Deterministic runs as readable YAML. |
| Memory | Persistent, searchable, and governed. |
| Ribs | Capabilities ship as packages, not forks. |
| Surfaces | Ribs emit JSON; the app renders live boards. |
| Providers | Copilot, Claude, Codex, Pi. Swappable, no lock-in. |

Each tile uses a custom inline line icon (see Icon family). If the set ever grows
to eight, the natural additions are Local and Governed (approval gates, the
operator tool denylist, keychain secrets), both real and currently carried by the
eyebrow and the hull figure respectively.

## Figures

Three diagram media, picked by job, plus app screenshots and one custom icon
family.

- **Bespoke SVG** for the signature hero illustration, "The Frame"
  (`assets/figures/the-frame-ship.svg`): a naval side elevation where the keelson
  beam is the harness, the frames are ribs, the CLI is the rudder (it steers from
  the shell), the browser SPA is a surface, and a dashed bridge marks a capability
  still under construction in a rib. Dashed lines mean planned or hidden detail,
  the blueprint convention. SVG gives true curve control the other tools cannot.
- **Excalidraw** for technical in-doc figures (boot sequence, snapshot streaming),
  rendered and inspected with
  `cd ~/.claude/skills/excalidraw-diagram/references && uv run python render_excalidraw.py <path>.excalidraw`,
  committed as `<name>.excalidraw` plus the rendered `<name>.png`.
- **Mermaid** for high-churn sequence and DAG diagrams, where native rendering and
  diffability matter more than bespoke styling.

Figure color legend, consistent across all media:

| Color | Means |
|---|---|
| navy `#1e3a5f` | the harness |
| brass `#b5803a` | a rib (extension) |
| ocean blue `#2f6fb0` | something attached to the harness |
| slate `#64748b`, dashed | an external system or abstract state |

Keep figures clean (no hand-drawn roughness), monospace labels, white canvas. The
`diagram-figure` frame supplies the blueprint context on the page.

### App screenshots

Screenshots of the running UI use the dark `screenshot-figure` frame, not the
light `diagram-figure` one. Two themes are in play at once: the docs render in
light and dark, and the UI itself has light and dark modes. A shot must hold up
in both. Either capture the UI in one canonical theme (state which) and frame it
so it reads against both doc backgrounds, or ship light and dark variants that
swap with the active theme. Never drop an unframed dark-UI shot onto a light page
or the reverse. Add screenshots only once a surface is visually stable, and keep
them current with the UI.

### Icon family

The feature-tile icons are inline navy line SVGs, one consistent family: 30x30
viewBox, `stroke="currentColor"` (so they inherit `--keel`), `fill="none"`,
stroke-width 2 (1.3 to 1.6 for inner detail), round caps and joins. They are
custom drawings, not unicode glyphs, so the row reads as intentional. The current
set: a chat bubble, a workflow DAG, an open ship's logbook (Memory), a hull-frame
cross-section (Ribs), a dashboard board (Surfaces), a provider swap. The brand
mark (`assets/keelson-mark.svg`) is ribs bolted onto a brass keel beam, the
identity in miniature.

## Definition of done (every new page)

Items 1 to 3 describe a hand-authored page (the landing). Starlight docs pages
get their chrome from the theme and author content in MDX; they must still
satisfy items 4 to 8.

1. Links `assets/keelson.css`; adds page-specific CSS inline only when truly
   page-specific (the landing's drafting-sheet chrome is the only example).
2. Header (brand + nav + GitHub), a hero with a `hero-card` big-idea aside, and a
   `page-footer`.
3. Topic pages use `guide-layout`: a sticky `side-nav` ("On this page") beside a
   `guide-content` column of `content-card`s, ending in a `related` block.
4. Every figure has a prose lead-in and a numbered figcaption.
5. Prose stays within the ~72ch measure; tables and figures may go full width.
6. No em dashes, no ASCII diagrams, no marketing claims, no unshipped-capability
   claims. Sentence case prose, display caps only in the hero.
7. The metaphor is seated once (if this is an entry point) and then dropped.
8. Cross-links: a `related` block and, where it fits, a "Continue to" hand-off.

## Decisions (the why, so they are not re-litigated)

- **Blueprint identity, not a chamber clone.** We adopted chamber's *toolset*
  (hand-authored HTML + one stylesheet + GitHub Pages) but reskinned it to a
  navy-plus-brass "shipwright's blueprint" so keelson reads as itself. The name
  earns this; nothing else could.
- **The hero is a literal ship.** "The Frame" is a naval side elevation, not
  abstract boxes, because the ribs genuinely are the ship's frames and the keel
  genuinely is the backbone. The shape is the meaning.
- **Corner crop marks, not an enclosing border.** A full rectangle boxed the page
  in and felt odd. Crop marks keep the drafting cue without the enclosure.
- **Eyebrow carries the product, headline carries the metaphor.** Lets the
  tagline be evocative ("Lay the keel. Raise the ribs.") while the page still
  says plainly what keelson is.
- **Six evidence-grounded tiles.** Chosen from a capability scan of the codebase,
  rated for distinctiveness and honesty. The three surfaces (Chat, Workflows,
  Memory) lead; nothing on the tiles oversells what ships.
- **Wide container, capped measure.** 1320 / 1480 px containers with a 72ch prose
  measure, the documentation standard, so the page feels substantial without long
  unreadable lines.
- **Bespoke landing, Starlight docs.** Hand-authoring suits the one-off landing
  but does not scale to the reference tier. The docs tier uses Astro Starlight
  (TS-native, fits the Bun monorepo, MDX so figures and components embed, search
  and nav out of the box), themed to the blueprint. The landing stays bespoke and
  is the design source of truth.

## Execution model

Foundation (this file, the IA, `keelson.css`, the palette, the reference pages)
is authored once and cohesively. Prose pages may be drafted in parallel against
this guide, but always follow with a single harmonization and cross-link pass so
voice and terminology stay uniform. Signature figures (the ship SVG, excalidraw)
are crafted one at a time with the render-and-inspect loop, never delegated.

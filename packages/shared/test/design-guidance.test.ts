// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import {
  buildCanvasArtifactGuidance,
  CANVAS_DESIGN_GUIDE_SECTIONS,
  CANVAS_PUBLISH_CONTRACT,
  designTokenCssBlock,
} from "../src/design-guidance.ts";
import { DESIGN_TOKENS } from "../src/design-tokens.ts";

const block = designTokenCssBlock();
const kit = CANVAS_DESIGN_GUIDE_SECTIONS.kit ?? "";

function declared(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

describe("designTokenCssBlock", () => {
  test("carries the identity tones for both themes and paints the body", () => {
    const [darkRoot, lightRoot] = block.split(':root[data-theme="light"]');
    for (const [css, theme] of [
      [darkRoot, "dark"],
      [lightRoot, "light"],
    ] as const) {
      const ids = Object.values(DESIGN_TOKENS[theme].identity);
      ids.forEach((hex, i) => {
        expect(css, `${theme} --id-${i + 1}`).toContain(`--id-${i + 1}: ${hex}`);
      });
    }
    expect(block).toMatch(/body \{[^}]*background: var\(--bg\)/);
  });
});

describe("design guide kit", () => {
  test("reads only tokens the token block or the kit declares", () => {
    const known = new Set([...declared(block), ...declared(kit)]);
    const used = new Set([...kit.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string));
    for (const name of used) expect(known.has(name), name).toBe(true);
  });

  test("opens with the token block, then styles through tokens, never a raw hex", () => {
    expect(kit).toContain(block);
    expect(kit.replace(block, "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("design guide placement", () => {
  test("describes side inspectors and centered HTML frames", () => {
    expect(CANVAS_DESIGN_GUIDE_SECTIONS.board).toContain(
      '{ effect: "open-canvas", key, placement: "side" }',
    );
    expect(CANVAS_DESIGN_GUIDE_SECTIONS.board).toContain("520px; columns stack to one");
    expect(CANVAS_DESIGN_GUIDE_SECTIONS.marks).toContain("title?, placement?");
    expect(CANVAS_DESIGN_GUIDE_SECTIONS.marks).toContain("html docs always open centered");
  });

  test("guides node-link maps toward graph sections and bounded slices", () => {
    const board = CANVAS_DESIGN_GUIDE_SECTIONS.board;
    expect(board).toContain("nodes in rank columns");
    expect(board).toContain("Cap 48 nodes / 200 edges");
    expect(board).toContain('say "showing N of M" in title');
    expect(board).toContain("Prefer it over an html region for any node-link map");
    expect(board).toContain("chain highlighting, the narrow fallback, and trusted dispatch");
    expect(board).toContain(
      "a graph whose edges carry the story better told as a journey or table",
    );
  });

  test("guides activity toward bounded timelines with host ticking and text fallback", () => {
    const board = CANVAS_DESIGN_GUIDE_SECTIONS.board;
    for (const phrase of [
      "spans on lanes over a window; a chart is for values",
      "Required arrays: lanes",
      "cap 12 lanes / 400 spans / 200 marks",
      "{ from, to } or { from, clock: { until } }",
      "single-code-point glyph",
      "open-ended dashed outline",
      "shared clock without new frames",
      "until is fixed, not a sliding window",
      "Below 720px of section width",
      "lists every span and mark as text",
      'expectView(key, "board")',
    ]) {
      expect(board).toContain(phrase);
    }
  });
});

describe("design guide voice", () => {
  test("the guidance itself uses no em or en dashes", () => {
    const texts = {
      contract: CANVAS_PUBLISH_CONTRACT,
      standing: buildCanvasArtifactGuidance(),
      ...CANVAS_DESIGN_GUIDE_SECTIONS,
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).not.toMatch(/[–—]/);
    }
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Drift guard: @keelson/shared DESIGN_TOKENS mirrors app.css so out-of-app
// producers (generated html-canvas markup can't read the app's CSS custom
// properties) inline the same palette the SPA renders. If this fails, app.css
// and packages/shared/src/design-tokens.ts were edited apart — change both.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_PALETTE_NAMES,
  DESIGN_TOKEN_CSS_VARS,
  type DesignPaletteName,
  type DesignThemeName,
  designTokenAt,
} from "@keelson/shared";

const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");

function cssVarsIn(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(`--${m[1]}`, (m[2] as string).trim().toLowerCase());
  }
  return vars;
}

const BLOCKS: Record<DesignPaletteName, Record<DesignThemeName, RegExp>> = {
  keelson: {
    dark: /(?:^|\n):root\s*\{([\s\S]*?)\}/,
    light: /:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/,
  },
  shore: {
    dark: /:root\[data-palette="shore"\]:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/,
    light: /:root\[data-theme="light"\]\[data-palette="shore"\]\s*\{([\s\S]*?)\}/,
  },
};

function themeBlock(palette: DesignPaletteName, theme: DesignThemeName): string {
  const block = BLOCKS[palette][theme].exec(css)?.[1];
  if (!block) throw new Error(`could not locate the ${palette} ${theme} block in app.css`);
  return block;
}

describe("design token drift guard", () => {
  for (const palette of DESIGN_PALETTE_NAMES) {
    for (const theme of ["dark", "light"] as DesignThemeName[]) {
      test(`${palette} ${theme}: every shared token matches its app.css custom property`, () => {
        const vars = cssVarsIn(themeBlock(palette, theme));
        for (const [path, varName] of Object.entries(DESIGN_TOKEN_CSS_VARS)) {
          expect(vars.get(varName), `${varName} (${path})`).toBe(
            designTokenAt(theme, path, palette),
          );
        }
      });
    }
  }
});

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
import { DESIGN_TOKEN_CSS_VARS, type DesignThemeName, designTokenAt } from "@keelson/shared";

const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");

function cssVarsIn(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(`--${m[1]}`, (m[2] as string).trim().toLowerCase());
  }
  return vars;
}

function themeBlock(theme: DesignThemeName): string {
  const pattern =
    theme === "dark"
      ? /(?:^|\n):root\s*\{([\s\S]*?)\}/
      : /:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/;
  const block = pattern.exec(css)?.[1];
  if (!block) throw new Error(`could not locate the ${theme} :root block in app.css`);
  return block;
}

describe("design token drift guard", () => {
  for (const theme of ["dark", "light"] as DesignThemeName[]) {
    test(`${theme}: every shared token matches its app.css custom property`, () => {
      const vars = cssVarsIn(themeBlock(theme));
      for (const [path, varName] of Object.entries(DESIGN_TOKEN_CSS_VARS)) {
        expect(vars.get(varName), `${varName} (${path})`).toBe(designTokenAt(theme, path));
      }
    });
  }
});

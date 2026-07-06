// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import {
  DESIGN_TOKEN_CSS_VARS,
  DESIGN_TOKENS,
  type DesignThemeName,
  designTokenAt,
} from "../src/design-tokens.ts";

const THEMES: DesignThemeName[] = ["dark", "light"];
const HEX = /^#[0-9a-f]{6}$/;

describe("DESIGN_TOKENS", () => {
  test("every mapped token resolves to a hex color in both themes", () => {
    for (const theme of THEMES) {
      for (const path of Object.keys(DESIGN_TOKEN_CSS_VARS)) {
        const value = designTokenAt(theme, path);
        expect(value, `${theme} ${path}`).toMatch(HEX);
      }
    }
  });

  test("the css-var map is complete: every token leaf is mapped exactly once", () => {
    const leafCount = (tokens: object): number =>
      Object.values(tokens).reduce(
        (n: number, v) =>
          typeof v === "string"
            ? n + 1
            : Array.isArray(v) || typeof v === "object"
              ? n + leafCount(v as object)
              : n,
        0,
      );
    expect(Object.keys(DESIGN_TOKEN_CSS_VARS).length).toBe(leafCount(DESIGN_TOKENS.dark));
    const vars = Object.values(DESIGN_TOKEN_CSS_VARS);
    expect(new Set(vars).size).toBe(vars.length);
  });

  test("series order is identical machinery in both themes (6 slots, fixed)", () => {
    expect(DESIGN_TOKENS.dark.series.length).toBe(6);
    expect(DESIGN_TOKENS.light.series.length).toBe(6);
  });

  test("designTokenAt returns undefined for unknown paths", () => {
    expect(designTokenAt("dark", "nope")).toBeUndefined();
    expect(designTokenAt("dark", "identity.chartreuse")).toBeUndefined();
    expect(designTokenAt("dark", "series.9")).toBeUndefined();
  });

  test("identity keys mirror the canvas id-* tone vocabulary", () => {
    for (const theme of THEMES) {
      expect(Object.keys(DESIGN_TOKENS[theme].identity).sort()).toEqual([
        "amber",
        "blue",
        "olive",
        "rose",
        "teal",
      ]);
    }
  });
});

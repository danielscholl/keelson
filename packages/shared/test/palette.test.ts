// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import { DESIGN_TOKENS } from "../src/design-tokens.ts";
import {
  formatPaletteReport,
  oklch,
  validateCategoricalPalette,
  validateOrdinalRamp,
  wcagContrast,
} from "../src/palette.ts";

describe("wcagContrast", () => {
  test("black on white is 21:1 and order-independent", () => {
    expect(wcagContrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(wcagContrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
  });

  test("identical colors are 1:1", () => {
    expect(wcagContrast("#8b7cf6", "#8b7cf6")).toBeCloseTo(1, 5);
  });

  test("rejects malformed hex", () => {
    expect(() => wcagContrast("#12345", "#ffffff")).toThrow("invalid hex color");
    expect(() => wcagContrast("blue", "#ffffff")).toThrow("invalid hex color");
  });
});

describe("oklch", () => {
  test("white is L≈1, black is L≈0, both achromatic", () => {
    expect(oklch("#ffffff").l).toBeCloseTo(1, 2);
    expect(oklch("#000000").l).toBeCloseTo(0, 2);
    expect(oklch("#ffffff").c).toBeLessThan(0.01);
  });
});

describe("validateCategoricalPalette", () => {
  test("the keelson series palettes pass in both modes (all-pairs)", () => {
    for (const mode of ["dark", "light"] as const) {
      const report = validateCategoricalPalette([...DESIGN_TOKENS[mode].series], {
        mode,
        pairs: "all",
      });
      expect(report.ok).toBe(true);
      expect(report.checks.some((c) => c.status === "fail")).toBe(false);
    }
  });

  test("the keelson identity tones pass in both modes (all-pairs)", () => {
    for (const mode of ["dark", "light"] as const) {
      const report = validateCategoricalPalette(Object.values(DESIGN_TOKENS[mode].identity), {
        mode,
        pairs: "all",
      });
      expect(report.ok).toBe(true);
    }
  });

  test("near-identical hues fail CVD separation", () => {
    const report = validateCategoricalPalette(["#4f7df0", "#5580ee", "#4a79e8"], { mode: "dark" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.check === "cvd-separation")?.status).toBe("fail");
  });

  test("a red/green pair fails CVD separation", () => {
    const report = validateCategoricalPalette(["#e04040", "#40a040"], { mode: "light" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.check === "cvd-separation")?.status).toBe("fail");
  });

  test("grays fail the chroma floor", () => {
    const report = validateCategoricalPalette(["#888888", "#666666", "#aaaaaa"], { mode: "dark" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.check === "chroma-floor")?.status).toBe("fail");
  });

  test("low contrast against the surface warns but does not fail", () => {
    // Dark identity olive sits at 2.90:1 on the dark card — the accompaniment
    // rule (name beside the color) is the documented mitigation, so it must
    // report as a warn requiring secondary encoding, never a hard fail.
    const report = validateCategoricalPalette(Object.values(DESIGN_TOKENS.dark.identity), {
      mode: "dark",
      pairs: "all",
    });
    const contrast = report.checks.find((c) => c.check === "surface-contrast");
    expect(contrast?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("adjacent pairs are the default; all-pairs is stricter or equal", () => {
    const palette = [...DESIGN_TOKENS.dark.series];
    const adjacent = validateCategoricalPalette(palette, { mode: "dark" });
    const all = validateCategoricalPalette(palette, { mode: "dark", pairs: "all" });
    const worst = (r: typeof adjacent) =>
      Number(
        /ΔE (\d+(?:\.\d+)?)/.exec(
          r.checks.find((c) => c.check === "cvd-separation")?.detail ?? "",
        )?.[1],
      );
    expect(worst(adjacent)).toBeGreaterThanOrEqual(worst(all));
  });

  test("an empty palette fails", () => {
    expect(validateCategoricalPalette([]).ok).toBe(false);
  });
});

describe("validateOrdinalRamp", () => {
  const ramp = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];

  test("a spaced one-hue ramp passes", () => {
    const report = validateOrdinalRamp(ramp, { mode: "light", surface: "#ffffff" });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("dark→light direction also reads as monotone", () => {
    const report = validateOrdinalRamp([...ramp].reverse(), { mode: "light", surface: "#ffffff" });
    expect(report.checks.find((c) => c.check === "lightness-monotone")?.status).toBe("pass");
  });

  test("a shuffled ramp fails monotone lightness", () => {
    const report = validateOrdinalRamp(["#3987e5", "#86b6ef", "#0d366b"], {
      mode: "light",
      surface: "#ffffff",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.check === "lightness-monotone")?.status).toBe("fail");
  });

  test("a multi-hue sequence fails the single-hue check", () => {
    const report = validateOrdinalRamp(["#cde2fb", "#9ec5f4", "#f59f6c"], {
      mode: "light",
      surface: "#ffffff",
    });
    expect(report.checks.find((c) => c.check === "single-hue")?.status).toBe("fail");
  });

  test("a too-pale light end fails against the surface", () => {
    const report = validateOrdinalRamp(["#cde2fb", "#3987e5", "#0d366b"], {
      mode: "light",
      surface: "#ffffff",
    });
    expect(report.checks.find((c) => c.check === "light-end-contrast")?.status).toBe("fail");
  });

  test("a single step is not a ramp", () => {
    expect(validateOrdinalRamp(["#3987e5"]).ok).toBe(false);
  });
});

describe("formatPaletteReport", () => {
  test("renders one line per check with an upper-case status tag", () => {
    const report = validateCategoricalPalette(["#888888"], { mode: "dark" });
    const text = formatPaletteReport(report);
    expect(text).toContain("[FAIL]");
    expect(text.split("\n").length).toBe(report.checks.length);
  });
});

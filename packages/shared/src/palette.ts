// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Computable palette checks for generated chart/artifact color, so "is this
// palette safe" is a function call, not a judgment: OKLCH lightness band,
// chroma floor, color-vision-deficiency separation (Machado 2009 simulation +
// CIE76 ΔE), and WCAG contrast against the rendering surface. Producers run
// these fail-closed before publishing `html`-canvas payloads; the DESIGN_TOKENS
// series/identity sets are the reference palettes expected to pass.

import { DESIGN_TOKENS, type DesignThemeName } from "./design-tokens.ts";

export type PalettePairs = "adjacent" | "all";

export interface PaletteCheck {
  readonly check: string;
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
}

export interface PaletteReport {
  /** False only on a hard fail; warns still pass but obligate secondary
   *  encoding (direct labels, gaps, or a table view). */
  readonly ok: boolean;
  readonly checks: readonly PaletteCheck[];
}

export interface PaletteOptions {
  mode?: DesignThemeName;
  /** Surface the marks render against; defaults to the mode's card token. */
  surface?: string;
  /** "adjacent" for bars/stacks/lines (only neighbors touch); "all" for
   *  scatter/maps/small-multiples where any two marks can sit side by side. */
  pairs?: PalettePairs;
}

// OKLCH lightness bands per mode, the chroma floor below which a hue reads as
// gray, the CVD ΔE target/floor, and the WCAG mark-contrast minimum. The CVD
// floor band (8–12) and sub-3:1 contrast report as warns, not fails: each is
// legal only with mandatory secondary encoding.
const LIGHTNESS_BAND: Record<DesignThemeName, readonly [number, number]> = {
  light: [0.4, 0.8],
  dark: [0.42, 0.78],
};
const CHROMA_FLOOR = 0.08;
const CVD_TARGET = 12;
const CVD_FLOOR = 8;
const CONTRAST_MIN = 3;
const ORDINAL_MIN_DELTA_L = 0.06;
const ORDINAL_LIGHT_END_MIN = 2;
const ORDINAL_MAX_HUE_SPREAD = 40;

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

function hexToSrgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  if (!HEX_PATTERN.test(h)) throw new Error(`invalid hex color: ${JSON.stringify(hex)}`);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

function linearRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToSrgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colors (order-independent). */
export function wcagContrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// OKLab per Björn Ottosson's reference implementation (public domain).
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH lightness + chroma for a hex color. */
export function oklch(hex: string): { l: number; c: number; h: number } {
  const [l, a, b] = oklab(hex);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c: Math.hypot(a, b), h };
}

// Machado, Oliveira & Fernandes (2009) dichromacy simulation matrices at
// severity 1.0, applied in linear RGB.
const CVD_MATRICES = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;
type CvdKind = keyof typeof CVD_MATRICES;

const clamp01 = (c: number): number => Math.max(0, Math.min(1, c));

function simulateCvd(hex: string, kind: CvdKind): [number, number, number] {
  const [r, g, b] = linearRgb(hex);
  const m = CVD_MATRICES[kind];
  return [
    clamp01(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp01(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp01(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

// CIELAB (D65) from linear RGB, for CIE76 ΔE.
function linearToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x / 0.95047), f(y), f(z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: string, b: string, kind?: CvdKind): number {
  const la = linearToLab(kind ? simulateCvd(a, kind) : linearRgb(a));
  const lb = linearToLab(kind ? simulateCvd(b, kind) : linearRgb(b));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

function pairList(n: number, pairs: PalettePairs): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairs === "all" || j === i + 1) out.push([i, j]);
    }
  }
  return out;
}

function resolveSurface(opts: PaletteOptions | undefined): {
  mode: DesignThemeName;
  surface: string;
  pairs: PalettePairs;
} {
  const mode = opts?.mode ?? "dark";
  return {
    mode,
    surface: opts?.surface ?? DESIGN_TOKENS[mode].card,
    pairs: opts?.pairs ?? "adjacent",
  };
}

/**
 * Validate a categorical (series-identity) palette: lightness band, chroma
 * floor, worst-pair CVD separation under protanopia/deuteranopia, and WCAG
 * contrast against the surface. Not for sequential/ordinal ramps — a correct
 * ramp fails these by design; use `validateOrdinalRamp`.
 */
export function validateCategoricalPalette(
  palette: readonly string[],
  opts?: PaletteOptions,
): PaletteReport {
  const { mode, surface, pairs } = resolveSurface(opts);
  const checks: PaletteCheck[] = [];
  if (palette.length === 0) {
    return {
      ok: false,
      checks: [{ check: "palette", status: "fail", detail: "palette is empty" }],
    };
  }

  const [bandLo, bandHi] = LIGHTNESS_BAND[mode];
  const offBand = palette
    .map((hex) => ({ hex, l: oklch(hex).l }))
    .filter(({ l }) => l < bandLo || l > bandHi);
  checks.push({
    check: "lightness-band",
    status: offBand.length ? "fail" : "pass",
    detail: offBand.length
      ? `outside OKLCH L ${bandLo}–${bandHi} (${mode}): ${offBand
          .map(({ hex, l }) => `${hex}@${l.toFixed(2)}`)
          .join(", ")}`
      : `all ${palette.length} inside OKLCH L ${bandLo}–${bandHi}`,
  });

  const lowChroma = palette
    .map((hex) => ({ hex, c: oklch(hex).c }))
    .filter(({ c }) => c < CHROMA_FLOOR);
  checks.push({
    check: "chroma-floor",
    status: lowChroma.length ? "fail" : "pass",
    detail: lowChroma.length
      ? `reads as gray (OKLCH C < ${CHROMA_FLOOR}): ${lowChroma
          .map(({ hex, c }) => `${hex}@${c.toFixed(2)}`)
          .join(", ")}`
      : `all ${palette.length} at or above C ${CHROMA_FLOOR}`,
  });

  if (palette.length >= 2) {
    let worst: { d: number; kind: CvdKind; a: string; b: string } | null = null;
    for (const kind of ["protan", "deutan"] as const) {
      for (const [i, j] of pairList(palette.length, pairs)) {
        const d = deltaE(palette[i] as string, palette[j] as string, kind);
        if (worst === null || d < worst.d) {
          worst = { d, kind, a: palette[i] as string, b: palette[j] as string };
        }
      }
    }
    const w = worst as { d: number; kind: CvdKind; a: string; b: string };
    const status = w.d >= CVD_TARGET ? "pass" : w.d >= CVD_FLOOR ? "warn" : "fail";
    checks.push({
      check: "cvd-separation",
      status,
      detail:
        `worst ${pairs} pair ${w.a}↔${w.b} ΔE ${w.d.toFixed(1)} (${w.kind})` +
        (status === "warn" ? " — floor band, requires secondary encoding" : ""),
    });
  }

  const lowContrast = palette
    .map((hex) => ({ hex, ratio: wcagContrast(hex, surface) }))
    .filter(({ ratio }) => ratio < CONTRAST_MIN);
  checks.push({
    check: "surface-contrast",
    status: lowContrast.length ? "warn" : "pass",
    detail: lowContrast.length
      ? `below ${CONTRAST_MIN}:1 on ${surface} — requires visible labels or a table view: ${lowContrast
          .map(({ hex, ratio }) => `${hex}@${ratio.toFixed(2)}`)
          .join(", ")}`
      : `all ${palette.length} at or above ${CONTRAST_MIN}:1 on ${surface}`,
  });

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/**
 * Validate an ordinal one-hue ramp (funnel stages, tiers): monotone lightness,
 * visible adjacent steps, a light end that still clears the surface, and a
 * single hue family.
 */
export function validateOrdinalRamp(
  palette: readonly string[],
  opts?: Pick<PaletteOptions, "mode" | "surface">,
): PaletteReport {
  const { mode, surface } = resolveSurface(opts);
  const checks: PaletteCheck[] = [];
  if (palette.length < 2) {
    return {
      ok: false,
      checks: [{ check: "palette", status: "fail", detail: "a ramp needs at least 2 steps" }],
    };
  }

  const ls = palette.map((hex) => oklch(hex).l);
  const ascending = ls.every((l, i) => i === 0 || l >= (ls[i - 1] as number));
  const descending = ls.every((l, i) => i === 0 || l <= (ls[i - 1] as number));
  checks.push({
    check: "lightness-monotone",
    status: ascending || descending ? "pass" : "fail",
    detail:
      ascending || descending
        ? "steps read light→dark"
        : `lightness out of order: ${ls.map((l) => l.toFixed(2)).join(", ")}`,
  });

  const thin = ls
    .slice(1)
    .map((l, i) => ({
      a: palette[i] as string,
      b: palette[i + 1] as string,
      gap: Math.abs(l - (ls[i] as number)),
    }))
    .filter(({ gap }) => gap < ORDINAL_MIN_DELTA_L);
  checks.push({
    check: "step-gap",
    status: thin.length ? "fail" : "pass",
    detail: thin.length
      ? `steps too close (ΔL < ${ORDINAL_MIN_DELTA_L}): ${thin
          .map(({ a, b, gap }) => `${a}↔${b}@${gap.toFixed(2)}`)
          .join(", ")}`
      : `all adjacent steps at or above ΔL ${ORDINAL_MIN_DELTA_L}`,
  });

  const byLightness = [...palette].sort((a, b) => oklch(a).l - oklch(b).l);
  const lightest = (
    mode === "light" ? byLightness[byLightness.length - 1] : byLightness[0]
  ) as string;
  const lightEnd = wcagContrast(lightest, surface);
  checks.push({
    check: "light-end-contrast",
    status: lightEnd >= ORDINAL_LIGHT_END_MIN ? "pass" : "fail",
    detail: `${lightest} at ${lightEnd.toFixed(2)}:1 vs ${surface}${
      lightEnd >= ORDINAL_LIGHT_END_MIN ? "" : ` — below ${ORDINAL_LIGHT_END_MIN}:1`
    }`,
  });

  const hues = palette.map((hex) => oklch(hex).h);
  let spread = Math.max(...hues) - Math.min(...hues);
  if (spread > 180) spread = 360 - spread;
  checks.push({
    check: "single-hue",
    status: spread <= ORDINAL_MAX_HUE_SPREAD ? "pass" : "fail",
    detail: `hue spread ${spread.toFixed(0)}°${
      spread <= ORDINAL_MAX_HUE_SPREAD
        ? ""
        : ` — over ${ORDINAL_MAX_HUE_SPREAD}°, not a one-hue ramp`
    }`,
  });

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/** Render a report as compact lines for a tool error / log message. */
export function formatPaletteReport(report: PaletteReport): string {
  return report.checks
    .map((c) => `[${c.status.toUpperCase().padEnd(4)}] ${c.check}: ${c.detail}`)
    .join("\n");
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Keelson's design-system instance as data: the SPA palette from
// `apps/web/src/app.css`, exported so producers outside the app origin can
// match it. The primary consumer is generated `html`-canvas markup — the
// sandboxed iframe is an opaque origin that cannot read the app's CSS custom
// properties, so an artifact must inline these values as literal hex. A drift
// guard in apps/web asserts this module and app.css stay identical; edit them
// together.

export type DesignThemeName = "dark" | "light";

export interface DesignThemeTokens {
  /** App background plane. */
  readonly bg: string;
  readonly bgSoft: string;
  /** Card surface — the plane charts render against; palette validation
   *  contrast checks run against this. */
  readonly card: string;
  readonly card2: string;
  readonly border: string;
  readonly borderSoft: string;
  /** Body ink. */
  readonly fg: string;
  /** Headings / emphasis ink. */
  readonly fgStrong: string;
  readonly muted: string;
  readonly dim: string;
  /** Brand accent — chrome and the one thing that should grab the eye. */
  readonly accent: string;
  readonly green: string;
  readonly yellow: string;
  readonly red: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly orange: string;
  readonly danger: string;
  /** Categorical chart series, fixed order — assign in sequence, never cycle
   *  or reorder (the order is part of the CVD validation). */
  readonly series: readonly [string, string, string, string, string, string];
  /** Reserved identity tones mirroring the canvas `id-*` tone vocabulary —
   *  one per repeatedly-rendered actor, never reused as chart series. */
  readonly identity: {
    readonly blue: string;
    readonly amber: string;
    readonly teal: string;
    readonly rose: string;
    readonly olive: string;
  };
}

// Values mirror apps/web/src/app.css `:root` (dark is the default theme).
const DARK: DesignThemeTokens = {
  bg: "#0d1429",
  bgSoft: "#131a30",
  card: "#161e3b",
  card2: "#1f2a4d",
  border: "#2a3258",
  borderSoft: "#1f2746",
  fg: "#d8def0",
  fgStrong: "#f0f3ff",
  muted: "#8993b2",
  dim: "#5e6789",
  accent: "#9b8eff",
  green: "#6dd28d",
  yellow: "#f5c352",
  red: "#f08793",
  magenta: "#c7a8f0",
  cyan: "#7cc0ff",
  orange: "#f59f6c",
  danger: "#e06666",
  series: ["#8b7cf6", "#bd8622", "#3f8edb", "#d4663f", "#2fa876", "#d260a4"],
  identity: {
    blue: "#4f7df0",
    amber: "#c27718",
    teal: "#0e9d8f",
    rose: "#ba3d78",
    olive: "#5f6e0a",
  },
};

// Values mirror apps/web/src/app.css `:root[data-theme="light"]`.
const LIGHT: DesignThemeTokens = {
  bg: "#f3f0fa",
  bgSoft: "#eeeaf7",
  card: "#ffffff",
  card2: "#eeeaf7",
  border: "#c8bfdc",
  borderSoft: "#d9d1e8",
  fg: "#161b31",
  fgStrong: "#0b0f1e",
  muted: "#5d5876",
  dim: "#7e7896",
  accent: "#6d4fe0",
  green: "#15834f",
  yellow: "#b57a00",
  red: "#d9385e",
  magenta: "#804bc1",
  cyan: "#2e6fd8",
  orange: "#b66229",
  danger: "#d9385e",
  series: ["#6d4fe0", "#b57a00", "#2e6fd8", "#b66229", "#15834f", "#804bc1"],
  identity: {
    blue: "#2457c5",
    amber: "#b45309",
    teal: "#11b3a5",
    rose: "#992558",
    olive: "#6b7f1a",
  },
};

export const DESIGN_TOKENS: Readonly<Record<DesignThemeName, DesignThemeTokens>> = {
  dark: DARK,
  light: LIGHT,
};

// The app.css custom-property name for each token key — the shared vocabulary
// the drift guard walks so a token added here without a matching var (or vice
// versa) fails the build rather than silently forking the palette.
export const DESIGN_TOKEN_CSS_VARS: Readonly<Record<string, string>> = {
  bg: "--bg",
  bgSoft: "--bg-soft",
  card: "--card",
  card2: "--card-2",
  border: "--border",
  borderSoft: "--border-soft",
  fg: "--fg",
  fgStrong: "--fg-strong",
  muted: "--muted",
  dim: "--dim",
  accent: "--accent",
  green: "--green",
  yellow: "--yellow",
  red: "--red",
  magenta: "--magenta",
  cyan: "--cyan",
  orange: "--orange",
  danger: "--danger",
  "series.0": "--s1",
  "series.1": "--s2",
  "series.2": "--s3",
  "series.3": "--s4",
  "series.4": "--s5",
  "series.5": "--s6",
  "identity.blue": "--id-blue",
  "identity.amber": "--id-amber",
  "identity.teal": "--id-teal",
  "identity.rose": "--id-rose",
  "identity.olive": "--id-olive",
};

/** Read one token by its DESIGN_TOKEN_CSS_VARS key path (e.g. "series.2"). */
export function designTokenAt(theme: DesignThemeName, path: string): string | undefined {
  const tokens = DESIGN_TOKENS[theme];
  const [head, tail] = path.split(".", 2) as [string, string | undefined];
  if (tail === undefined) {
    const value = (tokens as unknown as Record<string, unknown>)[head];
    return typeof value === "string" ? value : undefined;
  }
  if (head === "series") {
    const index = Number(tail);
    return Number.isInteger(index) ? tokens.series[index] : undefined;
  }
  if (head === "identity") {
    const value = (tokens.identity as Record<string, string | undefined>)[tail];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

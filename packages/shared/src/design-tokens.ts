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

// Values mirror apps/web/src/app.css `:root[data-palette="shore"]:not([data-theme="light"])`.
const SHORE_DARK: DesignThemeTokens = {
  bg: "#0f1a1b",
  bgSoft: "#132021",
  card: "#162324",
  card2: "#1d2d2e",
  border: "#2b3d3d",
  borderSoft: "#213132",
  fg: "#e4dfd1",
  fgStrong: "#f6f2e6",
  muted: "#a59d8a",
  dim: "#7d7666",
  accent: "#5cc4b2",
  green: "#8fcf86",
  yellow: "#e2b45c",
  red: "#ec8a6e",
  magenta: "#c3a2e8",
  cyan: "#7fb8e6",
  orange: "#eba06a",
  danger: "#e06a50",
  series: ["#3fb8a5", "#c9a05a", "#a884de", "#d66c5c", "#66aacc", "#d65c85"],
  identity: {
    blue: "#5b8def",
    amber: "#e0922f",
    teal: "#2fbfa8",
    rose: "#d0628e",
    olive: "#a9b25c",
  },
};

// Values mirror apps/web/src/app.css `:root[data-theme="light"][data-palette="shore"]`.
const SHORE_LIGHT: DesignThemeTokens = {
  bg: "#f3efe4",
  bgSoft: "#ece6d7",
  card: "#fbf9f3",
  card2: "#f2ede1",
  border: "#dcd3bf",
  borderSoft: "#e8e1d0",
  fg: "#23211c",
  fgStrong: "#15130f",
  muted: "#665f4f",
  dim: "#8a8170",
  accent: "#1d7a6c",
  green: "#3a7633",
  yellow: "#a07b3a",
  red: "#bb4a2b",
  magenta: "#8a5cc0",
  cyan: "#2a6ea3",
  orange: "#a85715",
  danger: "#bb4a2b",
  series: ["#1d8a7a", "#a07b3a", "#8a5cc0", "#ca5e16", "#387ba8", "#566321"],
  identity: {
    blue: "#2f6fc0",
    amber: "#c07a14",
    teal: "#13897c",
    rose: "#a63a68",
    olive: "#55691a",
  },
};

// A palette is the color family; the theme is its light or dark mode.
export type DesignPaletteName = "keelson" | "shore";

export const DESIGN_PALETTE_NAMES: readonly DesignPaletteName[] = ["keelson", "shore"];

export const DESIGN_PALETTES: Readonly<
  Record<DesignPaletteName, Readonly<Record<DesignThemeName, DesignThemeTokens>>>
> = {
  keelson: DESIGN_TOKENS,
  shore: { dark: SHORE_DARK, light: SHORE_LIGHT },
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
export function designTokenAt(
  theme: DesignThemeName,
  path: string,
  palette: DesignPaletteName = "keelson",
): string | undefined {
  const tokens = DESIGN_PALETTES[palette][theme];
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

/** Every mapped token as `{ "--bg": "#0d1429", … }` for one palette and theme. */
export function designTokenCssVars(
  theme: DesignThemeName,
  palette: DesignPaletteName = "keelson",
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [path, name] of Object.entries(DESIGN_TOKEN_CSS_VARS)) {
    const value = designTokenAt(theme, path, palette);
    if (value !== undefined) vars[name] = value;
  }
  return vars;
}

// Canvas frames get each token twice: under its app name as a plain default, and
// as --keelson-<name>, which designTokenCssBlock reads ahead of its own values.
export const DESIGN_TOKEN_HOOK_PREFIX = "--keelson-";

/** The custom properties the host stamps into a canvas frame for one palette and theme. */
export function designTokenFrameVars(
  theme: DesignThemeName,
  palette: DesignPaletteName = "keelson",
): Record<string, string> {
  const vars = designTokenCssVars(theme, palette);
  const hooks = Object.entries(vars).map(([name, value]) => [
    `${DESIGN_TOKEN_HOOK_PREFIX}${name.slice(2)}`,
    value,
  ]);
  return { ...vars, ...Object.fromEntries(hooks) };
}

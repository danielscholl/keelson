// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export type Style = (s: string) => string;

const wrap =
  (open: string): Style =>
  (s: string) =>
    `\x1b[${open}m${s}\x1b[0m`;

const fg256 = (n: number): Style => wrap(`38;5;${n}`);

export const bold: Style = wrap("1");
export const dim: Style = wrap("2");
export const italic: Style = wrap("3");
export const underline: Style = wrap("4");
export const strikethrough: Style = wrap("9");

// Keelson "blueprint" identity: navy structure, brass accents.
export const brass: Style = fg256(179);
export const navy: Style = fg256(67);
export const cyan: Style = fg256(80);
export const green: Style = fg256(114);
export const red: Style = fg256(174);
export const magenta: Style = fg256(176);

export const selectListTheme: SelectListTheme = {
  selectedPrefix: brass,
  selectedText: (s) => bold(brass(s)),
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};

export const editorTheme: EditorTheme = {
  borderColor: navy,
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (s) => bold(brass(s)),
  link: cyan,
  linkUrl: dim,
  code: magenta,
  codeBlock: green,
  codeBlockBorder: dim,
  quote: navy,
  quoteBorder: dim,
  hr: dim,
  listBullet: brass,
  bold,
  italic,
  strikethrough,
  underline,
};

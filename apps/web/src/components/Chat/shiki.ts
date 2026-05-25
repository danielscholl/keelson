import type { BundledLanguage, Highlighter } from "shiki";
import { createHighlighter } from "shiki";

// Lazy singleton. The first chat message containing a fence triggers the
// highlighter load (~200KB of grammars), and every subsequent block reuses it.
// `getLoadedLanguages` lets the CodeBlock fall through to plain text when a
// caller asks for a language we didn't preload, so the chat never errors on
// an unknown ```rust ``` fence — it just renders unhighlighted.

const LANGS: BundledLanguage[] = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "shell",
  "sql",
  "tsx",
  "typescript",
  "yaml",
];

const THEMES = ["github-light", "github-dark"] as const;

let cached: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!cached) {
    cached = createHighlighter({
      themes: [...THEMES],
      langs: LANGS,
    });
  }
  return cached;
}

export function highlightCodeToHtml(
  highlighter: Highlighter,
  code: string,
  lang: string,
): string {
  const loaded = highlighter.getLoadedLanguages();
  const effectiveLang = loaded.includes(lang as BundledLanguage)
    ? (lang as BundledLanguage)
    : "text";
  return highlighter.codeToHtml(code, {
    lang: effectiveLang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}

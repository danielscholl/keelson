import type { HighlighterCore } from "shiki/core";

// Lazy singleton with fine-grained dynamic imports. The first chat message
// containing a fence triggers Shiki's load (~200KB of core + wasm); each
// language grammar and theme arrives in its own chunk on first use. Static
// `import { createHighlighter } from "shiki"` pulled the FULL bundle into the
// main chunk (~800KB+ for cpp/emacs-lisp/wolfram alone) even though most
// chats never render those languages — this pattern lets Vite split each
// grammar so the main chunk stays small.
//
// `getLoadedLanguages` lets CodeBlock fall through to plain text when a
// caller asks for a language we didn't preload, so the chat never errors on
// an unknown ```rust ``` fence — it just renders unhighlighted.

const SHELL_ALIASES: ReadonlySet<string> = new Set(["bash", "sh", "shell", "zsh"]);

let cached: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!cached) {
    cached = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/oniguruma"),
      ]);
      return createHighlighterCore({
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        langs: [
          import("@shikijs/langs/bash"),
          import("@shikijs/langs/css"),
          import("@shikijs/langs/diff"),
          import("@shikijs/langs/go"),
          import("@shikijs/langs/html"),
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/jsx"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/langs/python"),
          import("@shikijs/langs/shellscript"),
          import("@shikijs/langs/sql"),
          import("@shikijs/langs/tsx"),
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/yaml"),
        ],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
    })();
  }
  return cached;
}

export function highlightCodeToHtml(
  highlighter: HighlighterCore,
  code: string,
  lang: string,
): string {
  const loaded = highlighter.getLoadedLanguages();
  // `bash`, `sh`, `shell`, and `zsh` are all Shiki aliases for `shellscript` —
  // `getLoadedLanguages()` returns the canonical id, so any aliased fence has
  // to resolve through `requested` before the `loaded.includes` guard or it
  // falls through to plain text.
  const requested = SHELL_ALIASES.has(lang) ? "shellscript" : lang;
  const effectiveLang = loaded.includes(requested) ? requested : "text";
  return highlighter.codeToHtml(code, {
    lang: effectiveLang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}

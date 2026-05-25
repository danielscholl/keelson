import { Children, isValidElement, useCallback, useEffect, useMemo, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { getHighlighter, highlightCodeToHtml } from "./shiki.ts";

// Custom code-block renderer injected into Streamdown via components.pre.
// Streamdown handles the streaming/memoization layer; this component owns the
// visual shell (header, copy button, syntax-highlighted body). We bypass
// Streamdown's built-in CodeBlock because it ships Tailwind utility classes
// that aren't wired up in this project.

interface ExtractedCode {
  text: string;
  lang: string;
}

function extractCode(children: ReactNode): ExtractedCode {
  // Streamdown wraps fenced code in its own CodeBlock component that exposes
  // `code` and `language` as explicit props (the highlight pipeline reads
  // them directly). When that wrapper is the child, prefer those props; fall
  // back to the standard react-markdown shape — a `<code class="language-x">`
  // element whose text content is the code body — for any other path that
  // doesn't route through Streamdown's wrapper.
  const codeEl = Children.toArray(children).find((c) => isValidElement(c));
  if (!isValidElement(codeEl)) return { text: "", lang: "text" };
  const props = codeEl.props as {
    code?: unknown;
    language?: unknown;
    className?: string;
    children?: ReactNode;
  };
  if (typeof props.code === "string") {
    const lang =
      typeof props.language === "string" && props.language.length > 0
        ? props.language
        : "text";
    return { text: props.code.replace(/\n$/, ""), lang };
  }
  const match = /language-([^\s]+)/.exec(props.className ?? "");
  const lang = match?.[1] ?? "text";
  const text = childrenToString(props.children).replace(/\n$/, "");
  return { text, lang };
}

function childrenToString(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToString).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return childrenToString(props.children);
  }
  return "";
}

// Signature matches what streamdown/react-markdown passes to the `pre` slot.
// We only need `children` (the inner <code> element); everything else flows
// through to keep the surface compatible if streamdown adds props later.
export function CodeBlock({ children }: HTMLAttributes<HTMLPreElement>) {
  const { text, lang } = useMemo(() => extractCode(children), [children]);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void getHighlighter().then((h) => {
      if (!alive) return;
      setHtml(highlightCodeToHtml(h, text, lang));
    });
    return () => {
      alive = false;
    };
  }, [text, lang]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang}</span>
        <button
          type="button"
          className="code-block-copy"
          onClick={handleCopy}
          aria-label="Copy code"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {html ? (
        <div
          className="code-block-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="code-block-body code-block-body--plain">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

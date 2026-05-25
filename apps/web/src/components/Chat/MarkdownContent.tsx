import remarkBreaks from "remark-breaks";
import type { Components } from "streamdown";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { CodeBlock } from "./CodeBlock.tsx";

// Streamdown handles the streaming + memoization wins (unterminated fences,
// per-block re-render skip). We override `pre` to inject our own syntax-
// highlighted CodeBlock with a copy button; Streamdown's bundled CodeBlock
// ships Tailwind utility classes that aren't wired up in this project.

// Cast: streamdown's Components type has a permissive index signature that
// CodeBlock's strict HTMLPreElement props don't satisfy. The specific `pre`
// slot signature is HTMLAttributes<HTMLPreElement> + ExtraProps, which our
// component does satisfy.
//
// Link safety strategy — we override `a` rather than enabling Streamdown's
// `linkSafety` for a deliberate reason: Streamdown's safety flow renders
// links as <button data-streamdown="link"> which loses native anchor
// affordances (middle-click → new tab, right-click → copy link address,
// browser tooltip showing the URL on hover). For a dashboard chat where
// MR/CVE/Sonar links are the primary interaction, that regression hurts
// more than the modal helps. Instead, we accept http(s) URLs at face
// value (the primer instruction forbids URL invention; rib tool
// responses come from trusted collectors) and refuse to render any other
// scheme as a clickable link — javascript:, data:, file: etc. collapse
// to plain text so they can't auto-execute on click.
const isSafeLinkScheme = (href: unknown): href is string =>
  typeof href === "string" && /^https?:\/\//i.test(href);

const components: Components = {
  pre: CodeBlock as Components["pre"],
  a: ({ href, children, ...rest }) => {
    if (!isSafeLinkScheme(href)) {
      return <span {...rest}>{children}</span>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
};

// remark-breaks reinstates the `breaks: true` behavior we had with marked —
// single newlines inside paragraphs render as <br/>. Streamdown's defaults
// alone collapse `line1\nline2` to one line, so assistant/tool messages that
// rely on soft breaks would lose their formatting. defaultRemarkPlugins is
// an object keyed by plugin name, not an array, so flatten via Object.values.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

interface MarkdownContentProps {
  source: string;
}

export function MarkdownContent({ source }: MarkdownContentProps) {
  return (
    <Streamdown
      className="markdown-content"
      controls={false}
      components={components}
      remarkPlugins={remarkPlugins}
    >
      {source}
    </Streamdown>
  );
}

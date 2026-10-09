import type { Element, ElementContent, Root, RootContent } from "hast";
import { docsSlug, type ShortMedia, shorts } from "./shorts";

const CONTENT_DIR = "/src/content/docs/docs/";

type Props = Record<string, string | string[] | boolean | undefined>;
const el = (tagName: string, properties: Props, children: ElementContent[] = []): Element => ({
  type: "element",
  tagName,
  properties: properties as Element["properties"],
  children,
});
const text = (value: string): ElementContent => ({ type: "text", value });

const textOf = (node: RootContent | ElementContent): string =>
  node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(textOf).join("")
      : "";

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

const isElement = (node: RootContent, tags: string[]): node is Element =>
  node.type === "element" && tags.includes(node.tagName);

function filmRow(s: ShortMedia): Element {
  const open = {
    type: "button",
    "data-film-open": "",
    "data-fig": s.fig,
    "data-title": s.title,
    "data-video": s.video,
    "data-poster": s.poster,
    "data-captions": s.captions,
  };
  return el("div", { className: ["film-ref-row"] }, [
    el("button", { ...open, className: ["film-ref-thumb"], ariaLabel: `Watch ${s.title}` }, [
      el("img", { src: s.thumb, alt: "", loading: "lazy", width: "640", height: "360" }),
      el("span", { className: ["film-ref-play"], ariaHidden: "true" }),
    ]),
    el("div", { className: ["film-ref-body"] }, [
      el("span", { className: ["film-ref-fig"] }, [text(`FIG. ${s.fig}`)]),
      el("span", { className: ["film-ref-title"] }, [text(s.title)]),
      el("span", { className: ["film-ref-problem"] }, [text(s.problem)]),
      el("span", { className: ["film-ref-actions"] }, [
        el("button", { ...open, className: ["film-ref-watch"] }, [
          text("Watch film"),
          el("span", { className: ["film-ref-len"] }, [text(s.length)]),
        ]),
        el("a", { href: `/docs/watch/#fig-${s.fig}`, className: ["film-ref-series"] }, [
          text("In the series"),
        ]),
      ]),
    ]),
  ]);
}

function filmRef(films: ShortMedia[]): Element {
  return el("aside", { className: ["film-ref"], ariaLabel: "From the film series" }, [
    el("p", { className: ["film-ref-kicker"] }, [text("From the film series")]),
    el(
      "div",
      { className: films.length > 1 ? ["film-ref-films", "film-ref-tiles"] : ["film-ref-films"] },
      films.map(filmRow),
    ),
  ]);
}

// Places each page's films after its opening paragraph, and a film mapped to a
// `#section` after that section's first paragraph, so the card never sits
// between a title and the text that introduces it.
export default function rehypeFilmRefs() {
  return (tree: Root, file: { path?: string }) => {
    const path = file.path?.replaceAll("\\", "/") ?? "";
    const at = path.indexOf(CONTENT_DIR);
    if (at === -1) return;
    const page = path
      .slice(at + CONTENT_DIR.length)
      .replace(/\.mdx?$/, "")
      .replace(/\/index$/, "");

    const atPage: ShortMedia[] = [];
    const atAnchor = new Map<string, ShortMedia[]>();
    for (const s of shorts) {
      for (const entry of s.docs) {
        const { page: target, anchor } = docsSlug(entry);
        if (target !== page) continue;
        if (anchor) atAnchor.set(anchor, [...(atAnchor.get(anchor) ?? []), s]);
        else if (!atPage.includes(s)) atPage.push(s);
      }
    }
    if (atPage.length === 0 && atAnchor.size === 0) return;

    const kids = tree.children;
    const afterParagraph = (from: number): number => {
      for (let i = from; i < kids.length; i++) {
        const node = kids[i];
        if (isElement(node, ["p"])) return i + 1;
        if (isElement(node, ["h2", "h3"])) return i;
      }
      return kids.length;
    };

    const inserts: { at: number; node: Element }[] = [];
    for (const [anchor, films] of atAnchor) {
      const heading = kids.findIndex(
        (n) =>
          isElement(n, ["h2", "h3"]) && (n.properties.id ?? slugify(textOf(n))) === anchor,
      );
      if (heading === -1) atPage.push(...films.filter((f) => !atPage.includes(f)));
      else inserts.push({ at: afterParagraph(heading + 1), node: filmRef(films) });
    }
    if (atPage.length > 0) inserts.push({ at: afterParagraph(0), node: filmRef(atPage) });

    for (const { at, node } of inserts.sort((a, b) => b.at - a.at)) kids.splice(at, 0, node);
  };
}

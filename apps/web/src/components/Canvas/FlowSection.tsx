import type { CanvasFlowSection } from "@keelson/shared";
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useState } from "react";

const WIDTH = 720;
const LEFT_X = 250;
const RIGHT_X = 470;
const ROW_H = 42;
const HEAD_H = 34;
const LABEL_CHARS = 30;
const MIN_RIBBON = 2.5;
const MAX_RIBBON = 24;
// Past this many, a folded node's card ends in "+N more" so it stays inside the region.
const CARD_FOLDED_ROWS = 4;

type FlowNode = CanvasFlowSection["nodes"][number];
type FlowLink = CanvasFlowSection["links"][number];

type Hover =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "link"; index: number; x: number; y: number };

function truncate(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

function share(n: number, of: number): string {
  if (of <= 0) return "";
  const pct = (n / of) * 100;
  return pct >= 1 || pct === 0 ? `${Math.round(pct)}%` : "<1%";
}

export function FlowSection({ section }: { section: CanvasFlowSection }) {
  const geometry = useMemo(() => {
    const lefts = section.nodes.filter((n) => n.side === "left");
    const rights = section.nodes.filter((n) => n.side === "right");
    const height = Math.max(lefts.length, rights.length) * ROW_H + HEAD_H;
    const yOf = (list: FlowNode[], id: string) =>
      HEAD_H + (list.findIndex((n) => n.id === id) + 0.5) * ((height - HEAD_H) / list.length);
    const totals = new Map<string, number>();
    for (const link of section.links) {
      totals.set(link.source, (totals.get(link.source) ?? 0) + link.n);
      totals.set(link.target, (totals.get(link.target) ?? 0) + link.n);
    }
    let slot = 0;
    const colors = new Map<string, string>();
    for (const node of lefts) {
      colors.set(node.id, node.folded ? "var(--s-other)" : `var(--s${++slot})`);
    }
    const max = Math.max(...section.links.map((l) => l.n));
    const selected = new Set(section.nodes.filter((n) => n.selected).map((n) => n.id));
    return { lefts, rights, height, yOf, totals, colors, max, selected };
  }, [section]);
  const { lefts, rights, height, yOf, totals, colors, max, selected } = geometry;
  const byId = useMemo(() => new Map(section.nodes.map((n) => [n.id, n])), [section.nodes]);

  const [hover, setHover] = useState<Hover | null>(null);
  const cardId = useId();
  useEffect(() => {
    if (!hover) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHover(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hover]);

  const at = (e: ReactPointerEvent<SVGElement>) => {
    const rect = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    return {
      x: rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 50,
      y: rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 50,
    };
  };
  const label = (id: string) => byId.get(id)?.label ?? id;
  const lit = (link: FlowLink) => selected.has(link.source) || selected.has(link.target);
  const opacity = (link: FlowLink) => (selected.size === 0 ? 0.55 : lit(link) ? 0.85 : 0.14);

  const node = (n: FlowNode, list: FlowNode[]) => {
    const left = n.side === "left";
    const x = left ? LEFT_X : RIGHT_X;
    const cy = yOf(list, n.id);
    const tx = left ? x - 12 : x + 12;
    const anchor = left ? "end" : "start";
    const on = n.selected === true;
    return (
      // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: keyboard focus opens the node's card without an action, like a pointer hover.
      <g
        key={n.id}
        className="cvb-flow-node"
        data-selected={on || undefined}
        data-folded={n.folded ? true : undefined}
        tabIndex={0}
        role="img"
        aria-label={`${n.label}${n.sublabel ? `, ${n.sublabel}` : ""}`}
        aria-describedby={hover?.kind === "node" && hover.id === n.id ? cardId : undefined}
        onPointerEnter={(e) => setHover({ kind: "node", id: n.id, ...at(e) })}
        onPointerMove={(e) => setHover({ kind: "node", id: n.id, ...at(e) })}
        onFocus={() =>
          setHover({ kind: "node", id: n.id, x: (x / WIDTH) * 100, y: (cy / height) * 100 })
        }
        onBlur={() => setHover(null)}
      >
        <rect
          className="cvb-flow-hit"
          x={left ? 0 : x}
          y={cy - ROW_H / 2}
          width={left ? x + 8 : WIDTH - x}
          height={ROW_H}
        />
        <circle className="cvb-flow-dot" r={5} cx={x} cy={cy} />
        <text className="cvb-flow-label" x={tx} y={cy - 1} textAnchor={anchor}>
          {truncate(n.label, LABEL_CHARS)}
        </text>
        {n.sublabel && (
          <text className="cvb-flow-sublabel" x={tx} y={cy + 12} textAnchor={anchor}>
            {truncate(n.sublabel, LABEL_CHARS)}
          </text>
        )}
      </g>
    );
  };

  const card = (() => {
    if (!hover) return null;
    if (hover.kind === "link") {
      const link = section.links[hover.index];
      if (!link) return null;
      return {
        title: `${label(link.source)} → ${label(link.target)}`,
        total: link.n,
        body: (
          <>
            <div className="cvb-chart-tooltip-row">
              <span className="cvb-chart-tooltip-label">of {label(link.source)}</span>
              <span className="cvb-flow-share">{share(link.n, totals.get(link.source) ?? 0)}</span>
            </div>
            <div className="cvb-chart-tooltip-row">
              <span className="cvb-chart-tooltip-label">of {label(link.target)}</span>
              <span className="cvb-flow-share">{share(link.n, totals.get(link.target) ?? 0)}</span>
            </div>
          </>
        ),
      };
    }
    const n = byId.get(hover.id);
    if (!n) return null;
    const total = totals.get(n.id) ?? 0;
    const left = n.side === "left";
    const mine = section.links
      .filter((l) => (left ? l.source === n.id : l.target === n.id))
      .sort((a, b) => b.n - a.n);
    const folded = [...(n.folded ?? [])].sort((a, b) => b.n - a.n);
    const foldedTotal = folded.reduce((sum, m) => sum + m.n, 0);
    return {
      title: n.label,
      total,
      body: (
        <>
          {folded.slice(0, CARD_FOLDED_ROWS).map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat, and the rows are a sorted read-only list rebuilt per hover
            <div key={`${m.label}\u0000${i}`} className="cvb-chart-tooltip-row cvb-flow-sub">
              <span className="cvb-chart-tooltip-label">{m.label}</span>
              <span className="cvb-chart-tooltip-value">{m.n.toLocaleString()}</span>
              <span className="cvb-flow-share">{share(m.n, foldedTotal)}</span>
            </div>
          ))}
          {folded.length > CARD_FOLDED_ROWS && (
            <div className="cvb-chart-tooltip-row cvb-flow-sub">
              <span className="cvb-chart-tooltip-label">
                +{folded.length - CARD_FOLDED_ROWS} more
              </span>
            </div>
          )}
          {folded.length > 0 && <div className="cvb-flow-rule" />}
          <div className="cvb-flow-heading">{left ? section.right : section.left}</div>
          {mine.map((l) => (
            <div key={left ? l.target : l.source} className="cvb-chart-tooltip-row">
              <span className="cvb-chart-dot" style={{ background: colors.get(l.source) }} />
              <span className="cvb-chart-tooltip-label">{label(left ? l.target : l.source)}</span>
              <span className="cvb-chart-tooltip-value">{l.n.toLocaleString()}</span>
              <span className="cvb-flow-share">{share(l.n, total)}</span>
            </div>
          ))}
        </>
      ),
    };
  })();

  return (
    <div className="cvb-flow" onPointerLeave={() => setHover(null)}>
      {/* biome-ignore lint/a11y/useSemanticElements: an svg can't be a fieldset; group keeps each focusable node exposed with its own label */}
      <svg
        className="cvb-flow-svg"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="group"
        aria-label={`${section.title || `${section.left} to ${section.right}`}: ${section.links
          .map((l) => `${label(l.source)} to ${label(l.target)} ${l.n.toLocaleString()}`)
          .join(", ")}`}
      >
        <text className="cvb-flow-side" x={LEFT_X - 12} y={14} textAnchor="end">
          {section.left}
        </text>
        <text className="cvb-flow-side" x={RIGHT_X + 12} y={14}>
          {section.right}
        </text>
        {section.links.map((link, index) => {
          const y1 = yOf(lefts, link.source);
          const y2 = yOf(rights, link.target);
          return (
            <path
              key={`${link.source}\u0000${link.target}`}
              className="cvb-flow-ribbon"
              data-lit={(selected.size > 0 && lit(link)) || undefined}
              d={`M ${LEFT_X} ${y1} C ${LEFT_X + 110} ${y1}, ${RIGHT_X - 110} ${y2}, ${RIGHT_X} ${y2}`}
              stroke={colors.get(link.source)}
              strokeWidth={Math.max(MIN_RIBBON, (link.n / max) * MAX_RIBBON)}
              style={{ opacity: opacity(link) }}
              onPointerEnter={(e) => setHover({ kind: "link", index, ...at(e) })}
              onPointerMove={(e) => setHover({ kind: "link", index, ...at(e) })}
            />
          );
        })}
        {lefts.map((n) => node(n, lefts))}
        {rights.map((n) => node(n, rights))}
      </svg>
      {card && hover && (
        <div
          id={cardId}
          role="tooltip"
          className={`cvb-chart-tooltip cvb-flow-card${hover.x > 50 ? " cvb-chart-tooltip--left" : ""}`}
          style={{ left: `${hover.x}%`, top: `calc(${hover.y}% + 14px)` }}
        >
          <div className="cvb-flow-title">
            <span>{card.title}</span>
            <span className="cvb-chart-tooltip-value">{card.total.toLocaleString()}</span>
          </div>
          {card.body}
        </div>
      )}
    </div>
  );
}

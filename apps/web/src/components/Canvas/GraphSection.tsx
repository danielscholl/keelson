import type { CanvasGraphSection } from "@keelson/shared";
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildColumns,
  computeRanks,
  type GraphGeometry,
  litSet,
  routeEdge,
  waitsOn,
} from "../../lib/boardGraphLayout.ts";
import { useCardActionDispatch } from "./BoardActionContext.tsx";

function GraphNode({
  node,
  dim,
  narrow,
  dependencies,
  onHover,
  onFocus,
}: {
  node: CanvasGraphSection["nodes"][number];
  dim: boolean;
  narrow: boolean;
  dependencies: string[];
  onHover: (id: string | null) => void;
  onFocus: (id: string | null) => void;
}) {
  const { disabled, dispatch } = useCardActionDispatch(node.action);
  const badgeCounts = new Map<string, number>();
  const props = {
    className: `cvb-graph-node${node.selected ? " is-selected" : ""}`,
    "data-node-id": node.id,
    "data-tone": node.tone,
    "data-dim": dim || undefined,
    onMouseEnter: () => onHover(node.id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onFocus(node.id),
    onBlur: () => onFocus(null),
  };
  const body = (
    <>
      <span className="cvb-graph-dot" data-tone={node.tone} aria-hidden="true" />
      <span className="cvb-graph-label" title={node.label}>
        {node.label}
      </span>
      {node.sublabel && <span className="cvb-graph-sublabel">{node.sublabel}</span>}
      {node.badges?.length ? (
        <span className="cvb-graph-badges">
          {node.badges.map((badge) => {
            const count = badgeCounts.get(badge.text) ?? 0;
            badgeCounts.set(badge.text, count + 1);
            return (
              <span
                key={`${badge.text}#${count}`}
                className="canvas-cell-badge"
                data-tone={badge.tone}
              >
                {badge.text}
              </span>
            );
          })}
        </span>
      ) : null}
      {narrow && dependencies.length > 0 && (
        <span className="cvb-graph-waits">waits on {dependencies.join(", ")}</span>
      )}
    </>
  );
  if (!node.action)
    return (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus exposes the dependency chain even without an action.
      <div {...props} tabIndex={0}>
        {body}
      </div>
    );
  return (
    <button
      {...props}
      type="button"
      aria-label={node.label}
      aria-pressed={node.selected ?? false}
      disabled={disabled}
      onClick={dispatch}
    >
      {body}
    </button>
  );
}

export function GraphSection({ section }: { section: CanvasGraphSection }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(
    () => buildColumns(section.nodes, computeRanks(section.nodes, section.edges), section.columns),
    [section.nodes, section.edges, section.columns],
  );
  const [drawing, setDrawing] = useState<{ width: number; paths: (string | null)[] }>({
    width: 0,
    paths: [],
  });
  const narrow = drawing.width > 0 && drawing.width < 720;
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = hovered ?? focused;
  const activeIds =
    active && section.nodes.some((node) => node.id === active)
      ? [active]
      : section.nodes.filter((node) => node.selected).map((node) => node.id);
  const lit = litSet(activeIds, section.edges);
  const highlighting = activeIds.length > 0;
  const edgeCounts = new Map<string, number>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: Columns and narrow mode change DOM geometry.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const isNarrow = bounds.width > 0 && bounds.width < 720;
      const geometry: GraphGeometry = {
        columns: [...root.querySelectorAll<HTMLElement>(".cvb-graph-col")].map((column) => {
          const rect = column.getBoundingClientRect();
          return {
            left: rect.left - bounds.left,
            right: rect.right - bounds.left,
            nodes: [...column.querySelectorAll<HTMLElement>(".cvb-graph-node")].flatMap((node) => {
              const box = node.getBoundingClientRect();
              if (box.width <= 0 || box.height <= 0) return [];
              return [
                {
                  id: node.dataset.nodeId!,
                  top: box.top - bounds.top,
                  bottom: box.bottom - bounds.top,
                  left: box.left - bounds.left,
                  right: box.right - bounds.left,
                },
              ];
            }),
          };
        }),
      };
      const paths = isNarrow
        ? []
        : section.edges.map((edge) => {
            if (edge.source === edge.target) return null;
            const route = routeEdge(edge.source, edge.target, geometry);
            if (route) return route.d;
            const boxes = geometry.columns.flatMap((column) => column.nodes);
            const source = boxes.find((node) => node.id === edge.source);
            const target = boxes.find((node) => node.id === edge.target);
            if (!source || !target) return null;
            const sy = (source.top + source.bottom) / 2;
            const ty = (target.top + target.bottom) / 2;
            const midX = (source.right + target.left) / 2;
            return `M ${source.right} ${sy} C ${midX} ${sy} ${midX} ${ty} ${target.left} ${ty}`;
          });
      setDrawing((previous) =>
        previous.width === bounds.width &&
        previous.paths.length === paths.length &&
        previous.paths.every((path, i) => path === paths[i])
          ? previous
          : { width: bounds.width, paths },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [columns, section.edges, narrow]);

  return (
    <div className="cvb-graph" ref={rootRef} data-narrow={narrow || undefined}>
      {!narrow && (
        <svg className="cvb-graph-edges" aria-hidden="true" width="100%" height="100%">
          <title>Dependencies</title>
          {section.edges.map((edge, i) => {
            const identity = JSON.stringify(edge);
            const count = edgeCounts.get(identity) ?? 0;
            edgeCounts.set(identity, count + 1);
            return (
              drawing.paths[i] && (
                <path
                  key={`${identity}#${count}`}
                  className="cvb-graph-edge"
                  d={drawing.paths[i]!}
                  data-tone={edge.tone}
                  data-dashed={edge.dashed || undefined}
                  data-dim={
                    (highlighting && (!lit.has(edge.source) || !lit.has(edge.target))) || undefined
                  }
                  data-source={edge.source}
                  data-target={edge.target}
                >
                  {edge.label && <title>{edge.label}</title>}
                </path>
              )
            );
          })}
        </svg>
      )}
      <div
        className="cvb-graph-columns"
        style={{ "--cvb-graph-cols": columns.length } as CSSProperties}
      >
        {columns.map((column) => (
          <div className="cvb-graph-col" key={column.rank} data-rank={column.rank}>
            {column.title && <div className="cvb-graph-col-title">{column.title}</div>}
            {column.nodes.map((node) => (
              <GraphNode
                key={node.id}
                node={node}
                dim={highlighting && !lit.has(node.id)}
                narrow={narrow}
                dependencies={waitsOn(node.id, section.nodes, section.edges)}
                onHover={setHovered}
                onFocus={setFocused}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

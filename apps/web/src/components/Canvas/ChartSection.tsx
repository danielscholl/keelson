import type { CanvasChartSection } from "@keelson/shared";
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";

// Plain inline SVG (no chart lib), matching the Usage page idiom. The renderer
// bakes in the dataviz rules the schema can't express: fixed-order --s* series
// colors, a recessive grid, direct endpoint labels only up to four series (a
// legend carries identity beyond that), label text in ink rather than the
// series hue, and a single y-axis by construction.
const WIDTH = 720;
const HEIGHT = 240;
const PAD_T = 12;
const PAD_B = 26;
const PAD_L = 48;
const PAD_R_BARE = 12;
// Right gutter reserved for endpoint labels; viewBox units, so it scales.
const PAD_R_LABELED = 120;
const MAX_DIRECT_LABELS = 4;
const MAX_X_LABELS = 8;
const ENDPOINT_LABEL_CHARS = 14;
const X_LABEL_CHARS = 12;

interface ChartSlot {
  // The distinct underlying x value — unique where the display label (compact
  // formatting can collide, e.g. 1000 and 1049 both read "1k") is not.
  id: string;
  label: string;
  x: number;
  // Per-series y value at this slot; null where a series has no point.
  values: (number | null)[];
}

interface ChartLayout {
  slots: ChartSlot[];
  floor: number;
  ceiling: number;
}

// A "nice" bound (1/2/2.5/5 × 10^n) so grid labels read like 2.5k rather than
// an arbitrary fraction of the data max.
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * base;
    if (candidate >= max) return candidate;
  }
  return 10 * base;
}

function compactNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${trimNumber(v / 1e9)}B`;
  if (abs >= 1e6) return `${trimNumber(v / 1e6)}M`;
  if (abs >= 1e3) return `${trimNumber(v / 1e3)}k`;
  return trimNumber(v);
}

function trimNumber(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function seriesColor(index: number): string {
  return `var(--s${index + 1})`;
}

// Positions every distinct x on the shared axis. All-numeric x scales
// linearly (a timeseries keeps its gaps); any string x falls back to ordered
// categories in first-appearance order across series.
function buildLayout(section: CanvasChartSection, padR: number): ChartLayout {
  const plotW = WIDTH - PAD_L - padR;
  const numeric = section.series.every((s) =>
    s.points.every((p) => typeof p.x === "number" && Number.isFinite(p.x)),
  );

  const keys: (string | number)[] = [];
  const slotIndex = new Map<string | number, number>();
  for (const s of section.series) {
    for (const p of s.points) {
      const key = numeric ? (p.x as number) : String(p.x);
      if (!slotIndex.has(key)) {
        slotIndex.set(key, keys.length);
        keys.push(key);
      }
    }
  }
  if (numeric) {
    keys.sort((a, b) => (a as number) - (b as number));
    slotIndex.clear();
    for (const [i, key] of keys.entries()) slotIndex.set(key, i);
  }

  const xs = new Map<string | number, number>();
  if (numeric && keys.length > 1) {
    const min = keys[0] as number;
    const max = keys[keys.length - 1] as number;
    const span = max - min;
    for (const key of keys) {
      xs.set(key, span > 0 ? PAD_L + (((key as number) - min) / span) * plotW : PAD_L + plotW / 2);
    }
  } else {
    for (const [i, key] of keys.entries()) {
      xs.set(key, keys.length > 1 ? PAD_L + (i / (keys.length - 1)) * plotW : PAD_L + plotW / 2);
    }
  }

  const slots: ChartSlot[] = keys.map((key) => ({
    id: String(key),
    label: numeric ? compactNumber(key as number) : String(key),
    x: xs.get(key) ?? PAD_L,
    values: section.series.map(() => null),
  }));
  section.series.forEach((s, si) => {
    for (const p of s.points) {
      if (!Number.isFinite(p.y)) continue;
      const key = numeric ? (p.x as number) : String(p.x);
      const slot = slots[slotIndex.get(key) ?? -1];
      if (slot) slot.values[si] = p.y;
    }
  });

  const values = slots.flatMap((slot) => slot.values.filter((v): v is number => v !== null));
  const dataMax = Math.max(...values, 0);
  const dataMin = Math.min(...values, 0);
  return {
    slots,
    floor: dataMin < 0 ? -niceCeiling(-dataMin * 1.05) : 0,
    ceiling: niceCeiling(dataMax * 1.05),
  };
}

export function ChartSection({ section }: { section: CanvasChartSection }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const direct = section.series.length <= MAX_DIRECT_LABELS;
  const padR = direct ? PAD_R_LABELED : PAD_R_BARE;
  const plotH = HEIGHT - PAD_T - PAD_B;
  const layout = useMemo(() => buildLayout(section, padR), [section, padR]);
  const { slots, floor, ceiling } = layout;

  const y = (v: number) => PAD_T + plotH - ((v - floor) / (ceiling - floor)) * plotH;

  const gridLines = [0, 1, 2, 3, 4].map((t) => {
    const value = floor + (t * (ceiling - floor)) / 4;
    return { value, y: y(value) };
  });

  // Each series' positioned points in slot order — the line connects them
  // left to right regardless of the producer's point order.
  const lines = section.series.map((s, si) => {
    const points = slots.flatMap((slot) => {
      const v = slot.values[si];
      return v == null ? [] : [{ x: slot.x, y: y(v) }];
    });
    return { label: s.label, color: seriesColor(si), points };
  });

  // Endpoint labels nudged apart vertically so adjacent line-ends stay legible.
  const endpoints = lines.flatMap((line, si) => {
    const end = line.points[line.points.length - 1];
    return end === undefined ? [] : [{ si, line, end }];
  });
  const labelYs = new Map<number, number>();
  if (direct) {
    let prev = Number.NEGATIVE_INFINITY;
    for (const e of [...endpoints].sort((a, b) => a.end.y - b.end.y)) {
      const nudged = Math.min(Math.max(e.end.y, prev + 12, PAD_T + 6), PAD_T + plotH);
      labelYs.set(e.si, nudged);
      prev = nudged;
    }
  }

  const labelStride = Math.max(1, Math.ceil(slots.length / MAX_X_LABELS));

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || slots.length === 0) return;
    const sx = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    for (const [i, slot] of slots.entries()) {
      if (Math.abs(slot.x - sx) < Math.abs(slots[nearest]!.x - sx)) nearest = i;
    }
    setHoverIndex(nearest);
  };

  const hover = hoverIndex !== null ? slots[hoverIndex] : undefined;
  const hoverRows = hover
    ? lines.flatMap((line, si) => {
        const value = hover.values[si];
        return value == null ? [] : [{ line, value }];
      })
    : [];

  return (
    <div className="cvb-chart">
      {section.yLabel && <div className="cvb-chart-ylabel">{section.yLabel}</div>}
      <svg
        ref={svgRef}
        className="cvb-chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${section.title ?? "Line chart"}: ${section.series
          .map((s) => s.label)
          .join(", ")}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {gridLines.map(({ value, y: gy }) => (
          <g key={value}>
            <line className="cvb-chart-grid-line" x1={PAD_L} x2={WIDTH - padR} y1={gy} y2={gy} />
            <text className="cvb-chart-axis-label" x={PAD_L - 8} y={gy + 3} textAnchor="end">
              {compactNumber(value)}
            </text>
          </g>
        ))}
        {slots.map(
          (slot, i) =>
            i % labelStride === 0 && (
              <text
                key={slot.id}
                className="cvb-chart-axis-label"
                x={slot.x}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {truncate(slot.label, X_LABEL_CHARS)}
              </text>
            ),
        )}
        {hover && (
          <line
            className="cvb-chart-crosshair"
            x1={hover.x}
            x2={hover.x}
            y1={PAD_T}
            y2={PAD_T + plotH}
          />
        )}
        {lines.map((line) => (
          <g key={line.label}>
            {line.points.length > 1 && (
              <path
                className="cvb-chart-line"
                d={line.points
                  .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                  .join(" ")}
                stroke={line.color}
              />
            )}
            {line.points.length === 1 && (
              <circle cx={line.points[0]!.x} cy={line.points[0]!.y} r={3} fill={line.color} />
            )}
          </g>
        ))}
        {endpoints.map(({ si, line, end }) => (
          <g key={line.label}>
            <circle cx={end.x} cy={end.y} r={3} fill={line.color} />
            {direct && (
              <text
                className="cvb-chart-endpoint-label"
                x={end.x + 8}
                y={(labelYs.get(si) ?? end.y) + 3}
              >
                {truncate(line.label, ENDPOINT_LABEL_CHARS)}
              </text>
            )}
          </g>
        ))}
        {hover &&
          hoverRows.map(({ line, value }) => (
            <circle
              key={line.label}
              className="cvb-chart-hover-dot"
              cx={hover.x}
              cy={y(value)}
              r={3.5}
              fill={line.color}
            />
          ))}
      </svg>
      {hover && hoverRows.length > 0 && (
        <div
          className={`cvb-chart-tooltip${hover.x > WIDTH / 2 ? " cvb-chart-tooltip--left" : ""}`}
          style={{ left: `${(hover.x / WIDTH) * 100}%` }}
        >
          <div className="cvb-chart-tooltip-title">{hover.label}</div>
          {hoverRows.map(({ line, value }) => (
            <div key={line.label} className="cvb-chart-tooltip-row">
              <span className="cvb-chart-dot" style={{ background: line.color }} />
              <span className="cvb-chart-tooltip-label">{line.label}</span>
              <span className="cvb-chart-tooltip-value">{value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      {section.series.length > 1 && (
        <div className="cvb-chart-legend">
          {lines.map((line) => (
            <span key={line.label} className="cvb-chart-legend-item">
              <span className="cvb-chart-dot" style={{ background: line.color }} />
              {line.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

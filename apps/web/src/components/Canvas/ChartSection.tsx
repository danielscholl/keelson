import type { CanvasChartSection } from "@keelson/shared";
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";

// Plain inline SVG in the Usage-page idiom; the renderer owns the dataviz
// rules the schema can't express (fixed-order palette, direct labels only up
// to four series, label text in ink, one y-axis).
const WIDTH = 720;
const HEIGHT = 240;
const PAD_T = 12;
const PAD_B = 26;
const PAD_L = 48;
const PAD_R_BARE = 12;
// Right gutter reserved for endpoint labels; viewBox units, so it scales.
const PAD_R_LABELED = 120;
const PLOT_H = HEIGHT - PAD_T - PAD_B;
const SERIES_COLOR_COUNT = 6;
const MAX_DIRECT_LABELS = 4;
const ENDPOINT_LABEL_CHARS = 14;
const X_LABEL_CHARS = 12;
// Minimum horizontal distance between x tick labels — spacing by position, not
// slot stride, so a clustered-plus-outlier numeric axis can't pile labels up.
const X_LABEL_MIN_GAP = 72;

interface ChartSlot {
  // The distinct underlying x value — unique where the display label (compact
  // formatting can collide, e.g. 1000 and 1049 both read "1k") is not.
  id: string;
  label: string;
  x: number;
  // Per-series y value at this slot; null where a series has no point.
  values: (number | null)[];
}

interface ChartLine {
  label: string;
  color: string;
  d: string | null;
  end: { x: number; y: number } | null;
}

interface ChartGeometry {
  slots: ChartSlot[];
  padR: number;
  direct: boolean;
  floor: number;
  gridLines: { value: number; y: number }[];
  xLabels: ChartSlot[];
  lines: ChartLine[];
  // Per-series endpoint-label y, nudged apart so adjacent line-ends stay legible.
  labelYs: Map<number, number>;
  y: (v: number) => number;
}

// A "nice" bound (1/2/2.5/5/10 × 10^n) so grid labels read like 2.5k rather
// than an arbitrary fraction of the data max.
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5]) {
    const candidate = step * base;
    if (candidate >= max) return candidate;
  }
  return 10 * base;
}

function trimNumber(v: number): string {
  // Two decimals under 1 so a sub-unit grid (0 / 0.05 / 0.1 …) keeps distinct
  // labels; one decimal above.
  const scale = Math.abs(v) < 1 ? 100 : 10;
  return String(Math.round(v * scale) / scale);
}

function compactNumber(v: number): string {
  // Tier thresholds sit at the value that would round to 1000 of the tier
  // below, so 999,999 reads "1M", never "1000k".
  const abs = Math.abs(v);
  if (abs >= 999.95e6) return `${trimNumber(v / 1e9)}B`;
  if (abs >= 999.95e3) return `${trimNumber(v / 1e6)}M`;
  if (abs >= 999.95) return `${trimNumber(v / 1e3)}k`;
  return trimNumber(v);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function seriesColor(index: number): string {
  return `var(--s${(index % SERIES_COLOR_COUNT) + 1})`;
}

// Positions every distinct x on the shared axis. All-numeric x scales
// linearly (a timeseries keeps its gaps); any string x falls back to ordered
// categories in first-appearance order across series.
function buildGeometry(section: CanvasChartSection): ChartGeometry {
  const direct = section.series.length <= MAX_DIRECT_LABELS;
  const padR = direct ? PAD_R_LABELED : PAD_R_BARE;
  const plotW = WIDTH - PAD_L - padR;
  const numeric = section.series.every((s) =>
    s.points.every((p) => typeof p.x === "number" && Number.isFinite(p.x)),
  );

  const seen = new Set<string | number>();
  const keys: (string | number)[] = [];
  for (const s of section.series) {
    for (const p of s.points) {
      const key = numeric ? (p.x as number) : String(p.x);
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  if (numeric) keys.sort((a, b) => (a as number) - (b as number));
  const slotIndex = new Map(keys.map((k, i) => [k, i] as const));

  const first = keys[0];
  const last = keys[keys.length - 1];
  const span = numeric ? (last as number) - (first as number) : 0;
  const xAt = (key: string | number, i: number): number => {
    if (keys.length <= 1) return PAD_L + plotW / 2;
    if (numeric) return PAD_L + (((key as number) - (first as number)) / span) * plotW;
    return PAD_L + (i / (keys.length - 1)) * plotW;
  };

  const slots: ChartSlot[] = keys.map((key, i) => ({
    id: String(key),
    label: numeric ? compactNumber(key as number) : String(key),
    x: xAt(key, i),
    values: section.series.map(() => null),
  }));
  section.series.forEach((s, si) => {
    for (const p of s.points) {
      if (!Number.isFinite(p.y)) continue;
      const idx = slotIndex.get(numeric ? (p.x as number) : String(p.x));
      if (idx !== undefined) slots[idx]!.values[si] = p.y;
    }
  });

  let dataMax = 0;
  let dataMin = 0;
  for (const slot of slots) {
    for (const v of slot.values) {
      if (v === null) continue;
      if (v > dataMax) dataMax = v;
      if (v < dataMin) dataMin = v;
    }
  }
  const floor = dataMin < 0 ? -niceCeiling(-dataMin * 1.05) : 0;
  const ceiling = niceCeiling(dataMax * 1.05);
  const y = (v: number) => PAD_T + PLOT_H - ((v - floor) / (ceiling - floor)) * PLOT_H;

  const gridLines = [0, 1, 2, 3, 4].map((t) => {
    const value = floor + (t * (ceiling - floor)) / 4;
    return { value, y: y(value) };
  });

  const xLabels: ChartSlot[] = [];
  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    if (slot.x - lastLabelX < X_LABEL_MIN_GAP) continue;
    xLabels.push(slot);
    lastLabelX = slot.x;
  }

  // Each series' positioned points in slot order — the line connects them
  // left to right regardless of the producer's point order.
  const lines: ChartLine[] = section.series.map((s, si) => {
    const points = slots.flatMap((slot) => {
      const v = slot.values[si];
      return v == null ? [] : [{ x: slot.x, y: y(v) }];
    });
    return {
      label: s.label,
      color: seriesColor(si),
      d:
        points.length > 1
          ? points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
          : null,
      end: points[points.length - 1] ?? null,
    };
  });

  // Nudge endpoint labels apart top-down, then shift the whole run back up if
  // it overran the plot bottom — a one-sided clamp would pile bottom-ending
  // series onto one y. ≤4 labels × 12 units always fits the plot height.
  const labelYs = new Map<number, number>();
  if (direct) {
    const ends = lines
      .map((line, si) => ({ si, end: line.end }))
      .filter((e): e is { si: number; end: { x: number; y: number } } => e.end !== null)
      .sort((a, b) => a.end.y - b.end.y);
    const nudged: number[] = [];
    let prev = PAD_T - 6;
    for (const e of ends) {
      prev = Math.max(e.end.y, prev + 12);
      nudged.push(prev);
    }
    const overflow = Math.max(0, (nudged[nudged.length - 1] ?? 0) - (PAD_T + PLOT_H));
    ends.forEach((e, i) => {
      labelYs.set(e.si, Math.max(nudged[i]! - overflow, PAD_T + 6));
    });
  }

  return { slots, padR, direct, floor, gridLines, xLabels, lines, labelYs, y };
}

export function ChartSection({ section }: { section: CanvasChartSection }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => buildGeometry(section), [section]);
  const { slots, padR, direct, floor, gridLines, xLabels, lines, labelYs, y } = geometry;

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || slots.length === 0) return;
    const sx = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const [i, slot] of slots.entries()) {
      const d = Math.abs(slot.x - sx);
      if (d < best) {
        best = d;
        nearest = i;
      }
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
        aria-label={`${section.title || "Line chart"}: ${section.series
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
        {floor < 0 && (
          <line className="cvb-chart-zero-line" x1={PAD_L} x2={WIDTH - padR} y1={y(0)} y2={y(0)} />
        )}
        {xLabels.map((slot) => (
          <text
            key={slot.id}
            className="cvb-chart-axis-label"
            x={slot.x}
            y={HEIGHT - 8}
            textAnchor="middle"
          >
            {truncate(slot.label, X_LABEL_CHARS)}
          </text>
        ))}
        {hover && (
          <line
            className="cvb-chart-crosshair"
            x1={hover.x}
            x2={hover.x}
            y1={PAD_T}
            y2={PAD_T + PLOT_H}
          />
        )}
        {lines.map((line, si) => (
          <g key={line.label}>
            {line.d && <path className="cvb-chart-line" d={line.d} stroke={line.color} />}
            {line.end && <circle cx={line.end.x} cy={line.end.y} r={3} fill={line.color} />}
            {line.end && direct && (
              <text
                className="cvb-chart-endpoint-label"
                x={line.end.x + 8}
                y={(labelYs.get(si) ?? line.end.y) + 3}
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

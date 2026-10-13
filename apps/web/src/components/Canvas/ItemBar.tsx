import type {
  CanvasItemBar,
  CanvasSeriesCell,
  CanvasSeriesColumn,
  CanvasTone,
} from "@keelson/shared";
import type { CSSProperties } from "react";

type Segment = { label: string; n: number | null; tone?: CanvasTone };

export function barPct(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

export function makeKeyer() {
  const seen = new Map<string, number>();
  return (base: string) => {
    const dup = seen.get(base) ?? 0;
    seen.set(base, dup + 1);
    return dup === 0 ? base : `${base}#${dup}`;
  };
}

// The proportional composition track alone (fills, no legend) — shared by the
// header strip and the item-scale card/row bar so the hatch treatment for an
// unmeasured (`n: null`) segment exists in exactly one place. Unmeasured slots
// render at a fixed basis (magnitude unknown), never as a zero-width fill.
export function Strip({
  segments,
  className,
  label,
}: {
  segments: Segment[];
  className?: string;
  label?: string;
}) {
  const key = makeKeyer();
  return (
    <div
      className={`cvb-strip${className ? ` ${className}` : ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {segments
        .filter((s) => s.n === null || s.n > 0)
        .map((s) => (
          // An unmeasured slot carries NO data-tone: the toneless hatch is the
          // contract, held structurally rather than by cascade order.
          <div
            key={key(JSON.stringify(s))}
            className={`cvb-strip-fill${s.n === null ? " cvb-strip-fill--unmeasured" : ""}`}
            data-tone={s.n === null ? undefined : (s.tone ?? "neutral")}
            title={`${s.label} ${s.n ?? "?"}`}
            style={s.n === null ? undefined : { flexGrow: s.n }}
          />
        ))}
    </div>
  );
}

export function isSeriesBar(
  bar: CanvasItemBar,
): bar is Extract<CanvasItemBar, { cells: unknown } | { columns: unknown }> {
  return "cells" in bar || "columns" in bar;
}

function cellsReading(cells: readonly CanvasSeriesCell[]): string {
  const counts = new Map<string, number>();
  for (const c of cells) {
    const name = `${c.hollow ? "hollow " : ""}${c.tone ?? "neutral"}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].map(([name, n]) => `${n} ${name}`).join(", ");
  return `${cells.length} slots: ${parts}`;
}

function columnReading(c: CanvasSeriesColumn): string {
  if (c.segments.some((s) => s.n === null)) return `${c.label}: unmeasured`;
  const parts = c.segments.filter((s) => (s.n ?? 0) > 0).map((s) => `${s.n} ${s.label}`);
  return parts.length ? `${c.label}: ${parts.join(", ")}` : c.label;
}

function SeriesCells({
  cells,
  quiet,
  label,
  className,
}: {
  cells: readonly CanvasSeriesCell[];
  quiet: boolean;
  label: string;
  className?: string;
}) {
  const key = makeKeyer();
  return (
    <div
      className={`cvb-series cvb-series--cells${quiet ? " is-quiet" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--series-n": cells.length } as CSSProperties}
      role="img"
      aria-label={label}
    >
      {cells.map((c) => (
        <span
          key={key(JSON.stringify(c))}
          className={`cvb-series-cell${c.hollow ? " is-hollow" : ""}`}
          data-tone={c.tone ?? "neutral"}
          title={c.label}
        />
      ))}
    </div>
  );
}

function SeriesColumns({
  columns,
  total,
  rest,
  label,
  className,
}: {
  columns: readonly CanvasSeriesColumn[];
  total: number;
  rest?: CanvasTone;
  label: string;
  className?: string;
}) {
  const key = makeKeyer();
  return (
    <div
      className={`cvb-series cvb-series--columns${className ? ` ${className}` : ""}`}
      style={{ "--series-n": columns.length } as CSSProperties}
      role="img"
      aria-label={label}
    >
      {columns.map((c) => {
        const unmeasured = c.segments.some((s) => s.n === null);
        const segKey = makeKeyer();
        return (
          <span
            key={key(JSON.stringify(c))}
            className={`cvb-series-column${unmeasured ? " is-unmeasured" : ""}`}
            data-tone={unmeasured ? undefined : rest}
            title={columnReading(c)}
          >
            {!unmeasured &&
              c.segments
                .filter((s) => (s.n ?? 0) > 0)
                .map((s) => (
                  <span
                    key={segKey(JSON.stringify(s))}
                    className="cvb-series-fill"
                    data-tone={s.tone ?? "neutral"}
                    style={{ height: `${barPct(s.n ?? 0, total)}%` }}
                  />
                ))}
          </span>
        );
      })}
    </div>
  );
}

// A card/row bar: the `{ value, total }` fill or the segmented composition
// strip at item scale. The strip form has no legend, so it carries its reading
// as an accessible label and per-fill hover titles. A captioned bar draws its
// label/trailing with the track and folds them into the track's accessible
// name, so the visible caption is hidden from assistive tech to avoid a double read.
export function ItemBar({ bar, className }: { bar: CanvasItemBar; className?: string }) {
  const captioned = bar.label !== undefined || bar.trailing !== undefined;
  const track = <ItemBarTrack bar={bar} className={className} captioned={captioned} />;
  if (!captioned) return track;
  const caption = [bar.label, bar.trailing].filter(Boolean).join(" · ");
  return (
    <div className="cvb-item-bar" title={caption}>
      <div className="cvb-item-bar-caption" aria-hidden="true">
        {bar.label && <span className="cvb-item-bar-label">{bar.label}</span>}
        {bar.trailing && <span className="cvb-item-bar-trailing">{bar.trailing}</span>}
      </div>
      {track}
    </div>
  );
}

function ItemBarTrack({
  bar,
  className,
  captioned,
}: {
  bar: CanvasItemBar;
  className?: string;
  captioned: boolean;
}) {
  const named = (reading: string) =>
    [bar.label ? `${bar.label}: ${reading}` : reading, bar.trailing].filter(Boolean).join(", ");
  if ("cells" in bar) {
    return (
      <SeriesCells
        cells={bar.cells}
        quiet={bar.quiet === true}
        label={named(cellsReading(bar.cells))}
        className={className}
      />
    );
  }
  if ("columns" in bar) {
    return (
      <SeriesColumns
        columns={bar.columns}
        total={bar.total}
        rest={bar.rest}
        label={named(bar.columns.map(columnReading).join("; "))}
        className={className}
      />
    );
  }
  if ("segments" in bar) {
    const reading = bar.segments.map((s) => `${s.label} ${s.n ?? "unmeasured"}`).join(", ");
    return (
      <Strip
        segments={bar.segments}
        className={`cvb-strip--item${className ? ` ${className}` : ""}`}
        label={named(reading)}
      />
    );
  }
  const pct = bar.value === null ? null : barPct(bar.value, bar.total);
  // In percent, the same clamped reading the fill draws, so an over-full or
  // zero-total bar still states a valid range.
  const meter = captioned
    ? {
        role: "meter",
        "aria-label": bar.label ?? bar.trailing,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        ...(pct === null ? {} : { "aria-valuenow": pct }),
        "aria-valuetext": bar.trailing ?? (pct === null ? "unmeasured" : `${pct}%`),
      }
    : {};
  return (
    <div className={`cvb-bar-track${className ? ` ${className}` : ""}`} {...meter}>
      {pct === null ? (
        <div className="cvb-bar-fill cvb-bar-fill--unmeasured" />
      ) : (
        <div className="cvb-bar-fill" style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

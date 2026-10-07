// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  USAGE_PULSE_SNAPSHOT_KEY,
  type UsageBreakdownResponseWire,
  type UsageEventRowWire,
  type UsageEventSourceWire,
  type UsageJobsRowWire,
  type UsagePriceCardWire,
  type UsageSeriesResponseWire,
  type UsageSummaryResponseWire,
  usagePulseSnapshotSchema,
} from "@keelson/shared";
import type { CSSProperties } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  getUsageBreakdown,
  getUsageEvents,
  getUsageJobs,
  getUsageSeries,
  getUsageSummary,
  type UsageSeriesBucket,
  type UsageWindow,
} from "../api.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";
import { formatProviderModel } from "../lib/formatProvenance.ts";
import {
  formatAggregateCostUsd,
  formatCacheHit,
  formatCostUsd,
  formatTokens,
} from "../lib/formatTokens.ts";

const WINDOWS: UsageWindow[] = ["24h", "7d", "30d"];

// A null aggregate cost is unexplained on its own; the count of rows that
// kept it unpriced is what tells an operator which price to add.
function formatAggregateCost(
  costUsd: number | null,
  pricedCostUsd: number,
  unpricedEvents: number,
  pricedEvents: number,
): string {
  const cost = formatAggregateCostUsd(costUsd, pricedCostUsd, unpricedEvents, pricedEvents);
  return costUsd === null && unpricedEvents > 0
    ? `${cost} (${unpricedEvents.toLocaleString()})`
    : cost;
}
const WINDOW_LABEL: Record<UsageWindow, string> = { "24h": "24h", "7d": "7d", "30d": "30d" };
type UsageSubView = "overview" | "models" | "jobs" | "ledger";
const USAGE_SUBVIEWS: Array<{ id: UsageSubView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "jobs", label: "Jobs" },
  { id: "ledger", label: "Ledger" },
];

// Standard clip-rect technique: keeps the native <input type="radio"> in the
// accessibility tree and tab order while the styled <label> carries the
// visible toggle affordance.
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// The series chart buckets hourly for the 24h window (24 points) and daily
// for the wider windows (7 or 30 points) — a finer bucket than a day would
// crowd 30 points into unreadable slivers.
const SERIES_BUCKET: Record<UsageWindow, UsageSeriesBucket> = {
  "24h": "hour",
  "7d": "day",
  "30d": "day",
};

// The validated categorical series palette (see app.css --s1..--s6). Slots
// are never cycled: past six models the long tail folds into one Other series.
const SERIES_COLOR_COUNT = 6;
const OTHER_SERIES_COLOR = "var(--s-other)";
const OTHER_SERIES_KEY = "\u0000other";

export interface SeriesPalette {
  named: string[];
  folded: string[];
  colorOf: (key: string) => string;
}

// Every chart derives its palette from per-model token totals over the
// same window, so a model wears one color across the page. Named slots go in
// alphabetical order so a model's color doesn't follow its rank.
export function assignSeriesColors(totals: ReadonlyMap<string, number>): SeriesPalette {
  const byAlpha = (a: string, b: string) => a.localeCompare(b);
  const keys = [...totals.keys()];
  const named =
    keys.length <= SERIES_COLOR_COUNT
      ? keys.sort(byAlpha)
      : keys
          .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || byAlpha(a, b))
          .slice(0, SERIES_COLOR_COUNT - 1)
          .sort(byAlpha);
  const colors = new Map(named.map((key, i) => [key, `var(--s${i + 1})`]));
  const folded = [...totals.keys()].filter((key) => !colors.has(key)).sort(byAlpha);
  return { named, folded, colorOf: (key) => colors.get(key) ?? OTHER_SERIES_COLOR };
}

function otherSeriesLabel(folded: readonly string[]): string {
  return `Other (${folded.length} ${folded.length === 1 ? "model" : "models"})`;
}

// Statuses that count as spend without a kept result — the failure-burn tile
// sums these. usage/summary has no status dimension (its groups are by
// model/provider/source/rib/workflow), so this pulls from usage/events
// instead, one query per non-ok status so a burst of failures can't crowd a
// shared limit out of the recent window the way a single combined query would.
const FAILURE_STATUSES = ["error", "aborted", "timeout"] as const;
const FAILURE_EVENTS_LIMIT = 200;

type ChartMetric = "tokens" | "cost";
const CHART_METRICS: Array<{ id: ChartMetric; label: string }> = [
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "Cost" },
];

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

function allTokens(t: TokenCounts): number {
  return t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0) + t.outputTokens;
}

function metricValue(row: TokenCounts & { pricedCostUsd: number }, metric: ChartMetric): number {
  return metric === "tokens" ? allTokens(row) : row.pricedCostUsd;
}

function formatMetric(metric: ChartMetric): (value: number) => string {
  return metric === "tokens" ? formatTokens : formatCostUsd;
}

export function Usage() {
  const [range, setRange] = useState<UsageWindow>("7d");
  const [subView, setSubView] = useState<UsageSubView>("overview");
  const pulse = useSnapshot(USAGE_PULSE_SNAPSHOT_KEY);

  return (
    <div className="page usage-page">
      <UsageHeader range={range} onRangeChange={setRange} live={pulse.status === "live"} />
      <UsageViewNav value={subView} onChange={setSubView} />
      {subView === "overview" ? (
        <>
          <PulseSection range={range} pulse={pulse} />
          <OverTimeSection range={range} />
          <FlowSection range={range} />
        </>
      ) : subView === "models" ? (
        <ModelRosterSection range={range} />
      ) : subView === "jobs" ? (
        <JobsSection range={range} />
      ) : (
        <LedgerSection range={range} />
      )}
    </div>
  );
}

function UsageViewNav({
  value,
  onChange,
}: {
  value: UsageSubView;
  onChange: (view: UsageSubView) => void;
}) {
  return (
    <div className="layout-toggle usage-view-nav" role="radiogroup" aria-label="View">
      {USAGE_SUBVIEWS.map((view) => (
        <label key={view.id} className={`layout-toggle-btn${view.id === value ? " active" : ""}`}>
          <input
            type="radio"
            name="usage-view"
            value={view.id}
            checked={view.id === value}
            onChange={() => onChange(view.id)}
            style={VISUALLY_HIDDEN_STYLE}
          />
          {view.label}
        </label>
      ))}
    </div>
  );
}

function MetricToggle({
  value,
  onChange,
}: {
  value: ChartMetric;
  onChange: (metric: ChartMetric) => void;
}) {
  const name = useId();
  return (
    <div className="layout-toggle" role="radiogroup" aria-label="Measure">
      {CHART_METRICS.map((m) => (
        <label key={m.id} className={`layout-toggle-btn${m.id === value ? " active" : ""}`}>
          <input
            type="radio"
            name={name}
            value={m.id}
            checked={m.id === value}
            onChange={() => onChange(m.id)}
            style={VISUALLY_HIDDEN_STYLE}
          />
          {m.label}
        </label>
      ))}
    </div>
  );
}

function UsageHeader({
  range,
  onRangeChange,
  live,
}: {
  range: UsageWindow;
  onRangeChange: (w: UsageWindow) => void;
  live: boolean;
}) {
  return (
    <div className="page-header usage-page-header">
      <div>
        <h1 className="page-title">Usage</h1>
        <span className="page-sub">Token spend across chat, workflows, and ribs</span>
      </div>
      <div className="usage-header-controls">
        <span
          className="surface-region-live"
          role="img"
          data-streaming={live || undefined}
          title={live ? "Live — pulse streaming" : "Pulse not yet connected"}
          aria-label={live ? "Live, pulse streaming" : "Pulse not connected"}
        />
        <div className="layout-toggle" role="radiogroup" aria-label="Window">
          {WINDOWS.map((w) => (
            <label key={w} className={`layout-toggle-btn${w === range ? " active" : ""}`}>
              <input
                type="radio"
                name="usage-window"
                value={w}
                checked={w === range}
                onChange={() => onRangeChange(w)}
                style={VISUALLY_HIDDEN_STYLE}
              />
              {WINDOW_LABEL[w]}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FailureBurn {
  tokens: number;
  turns: number;
}

function PulseSection({
  range,
  pulse,
}: {
  range: UsageWindow;
  pulse: ReturnType<typeof useSnapshot>;
}) {
  const [summary, setSummary] = useState<UsageSummaryResponseWire | null>(null);
  const [failureBurn, setFailureBurn] = useState<FailureBurn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getUsageSummary({ window: range }),
      Promise.all(
        FAILURE_STATUSES.map((status) =>
          getUsageEvents({ window: range, status, limit: FAILURE_EVENTS_LIMIT }),
        ),
      ),
    ])
      .then(([summaryRes, eventsByStatus]) => {
        if (cancelled) return;
        setSummary(summaryRes);
        let tokens = 0;
        let turns = 0;
        for (const events of eventsByStatus) {
          for (const ev of events) {
            tokens += allTokens(ev);
            turns += 1;
          }
        }
        setFailureBurn({ tokens, turns });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const parsedPulse =
    pulse.status === "live" ? usagePulseSnapshotSchema.safeParse(pulse.data) : null;
  const pulseData = parsedPulse?.success ? parsedPulse.data : null;

  return (
    <section className="surface-region usage-pulse-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="brand" aria-hidden="true">
          ◉
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Pulse</span>
        </span>
        <span className="surface-region-spacer" />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load usage</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : summary && summary.totals.events === 0 ? (
          <div className="usage-stack-empty">
            <span className="page-sub">No usage recorded in this window.</span>
          </div>
        ) : summary && failureBurn ? (
          <>
            <PulseStats summary={summary} failureBurn={failureBurn} />
            <PulseSparkline pulse={pulseData} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function PulseStats({
  summary,
  failureBurn,
}: {
  summary: UsageSummaryResponseWire;
  failureBurn: FailureBurn;
}) {
  const { totals } = summary;
  const totalInputTokens = totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;
  const tokensByType: ByTokenType = {
    input: totals.inputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheWrite: totals.cacheWriteTokens,
    output: totals.outputTokens,
  };
  const sources = priceSourceLabels(totals.priceCards);

  return (
    <div className="usage-stats">
      <div className="usage-stat">
        <div className="usage-stat-value">{formatTokens(allTokens(totals))}</div>
        <div className="usage-stat-label">Tokens</div>
        <div className="usage-stat-sub">
          <TokenTypeBar label="Tokens" values={tokensByType} format={formatTokens} />
        </div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value">
          {formatAggregateCostUsd(
            totals.costUsd,
            totals.pricedCostUsd,
            totals.unpricedEvents,
            totals.events - totals.unpricedEvents,
          )}
        </div>
        <div className="usage-stat-label">Cost</div>
        <div className="usage-stat-sub">
          {totals.unpricedEvents > 0
            ? `${totals.unpricedEvents.toLocaleString()} unpriced ${
                totals.unpricedEvents === 1 ? "turn" : "turns"
              }`
            : sources.join(" · ")}
        </div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value">{totals.events.toLocaleString()}</div>
        <div className="usage-stat-label">Agent turns</div>
        <div className="usage-stat-sub">chat · workflows · ribs</div>
      </div>
      <div className="usage-stat">
        <div
          className="usage-stat-value"
          data-tone={totals.cacheHitRatio !== null ? "ok" : undefined}
        >
          {formatCacheHit(totals.cacheHitRatio)}
        </div>
        <div className="usage-stat-label">Cache hit</div>
        <div className="usage-stat-sub usage-mono">
          {totals.cacheHitRatio !== null
            ? `${formatTokens(totals.cacheReadTokens)} of ${formatTokens(totalInputTokens)} input`
            : "no cache reads reported"}
        </div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value" data-tone={failureBurn.tokens > 0 ? "hot" : undefined}>
          {formatTokens(failureBurn.tokens)}
        </div>
        <div className="usage-stat-label">Failure burn</div>
        <div className="usage-stat-sub">
          {failureBurn.turns} errored / aborted / timed-out{" "}
          {failureBurn.turns === 1 ? "turn" : "turns"}
        </div>
      </div>
    </div>
  );
}

// The last 60 minutes of tokens/min, fed live from the pulse snapshot — no
// GET refetch drives this, only useSnapshot's hydrate + WS frames.
function PulseSparkline({ pulse }: { pulse: unknown }) {
  const parsed = usagePulseSnapshotSchema.safeParse(pulse);
  const minuteSeries = parsed.success ? parsed.data.minuteSeries : [];

  const values = useMemo(() => minuteSeries.map((m) => allTokens(m)), [minuteSeries]);

  const hasSignal = values.some((v) => v > 0);
  const last = values.at(-1) ?? 0;

  if (!parsed.success || values.length === 0) {
    return (
      <div className="usage-pulse-strip">
        <span className="usage-pulse-label">Now · tokens/min</span>
        <span className="page-sub">No live data yet this hour.</span>
      </div>
    );
  }

  const width = 560;
  const height = 44;
  const n = values.length;
  const max = Math.max(...values, 1) * 1.15;
  const x = (i: number) => (i / Math.max(n - 1, 1)) * (width - 10) + 4;
  const y = (v: number) => height - 4 - (v / max) * (height - 10);

  const linePath = values
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const fillPath = `${linePath} L ${x(n - 1)} ${height - 3} L ${x(0)} ${height - 3} Z`;

  return (
    <div className="usage-pulse-strip">
      <span className="usage-pulse-label">Now · tokens/min</span>
      <svg
        className="usage-pulse-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Tokens per minute, last hour"
      >
        {hasSignal && <path d={fillPath} fill="var(--accent)" opacity={0.14} />}
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {hasSignal && (
          <circle
            className="usage-pulse-dot"
            cx={x(n - 1)}
            cy={y(last)}
            r={3.5}
            fill="var(--cyan)"
          />
        )}
      </svg>
      <span className="usage-pulse-now usage-mono">{formatTokens(last)} tok/min</span>
    </div>
  );
}

interface StackBucket {
  iso: string;
  values: number[];
  total: number;
  folded: Array<{ key: string; value: number }>;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

// Pivots the flat series rows (one row per bucket × model) into per-bucket
// stacks: the palette's named models in alphabetical order, then one Other
// series summing the folded tail.
export function pivotSeries(
  rows: UsageSeriesResponseWire,
  metric: ChartMetric = "tokens",
): {
  series: ChartSeries[];
  buckets: StackBucket[];
} {
  const totalsByModel = new Map<string, Map<string, number>>();
  const modelTotals = new Map<string, number>();
  const bucketTotals = new Map<string, number>();

  for (const row of rows) {
    const value = metricValue(row, metric);
    let perBucket = totalsByModel.get(row.key);
    if (!perBucket) {
      perBucket = new Map();
      totalsByModel.set(row.key, perBucket);
    }
    perBucket.set(row.bucketIso, (perBucket.get(row.bucketIso) ?? 0) + value);
    modelTotals.set(row.key, (modelTotals.get(row.key) ?? 0) + allTokens(row));
    bucketTotals.set(row.bucketIso, (bucketTotals.get(row.bucketIso) ?? 0) + value);
  }

  const palette = assignSeriesColors(modelTotals);
  const series: ChartSeries[] = palette.named.map((key) => ({
    key,
    label: key,
    color: palette.colorOf(key),
  }));
  const hasOther = palette.folded.length > 0;
  if (hasOther) {
    series.push({
      key: OTHER_SERIES_KEY,
      label: otherSeriesLabel(palette.folded),
      color: OTHER_SERIES_COLOR,
    });
  }
  const buckets = [...bucketTotals.keys()].sort().map((iso) => {
    const valueAt = (model: string) => totalsByModel.get(model)?.get(iso) ?? 0;
    const values = palette.named.map(valueAt);
    const folded = palette.folded
      .map((key) => ({ key, value: valueAt(key) }))
      .filter((m) => m.value > 0)
      .sort((a, b) => b.value - a.value);
    if (hasOther) values.push(folded.reduce((sum, m) => sum + m.value, 0));
    return { iso, values, total: bucketTotals.get(iso) ?? 0, folded };
  });
  return { series, buckets };
}

function formatBucketLabel(iso: string, bucket: UsageSeriesBucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return bucket === "hour"
    ? d.toLocaleTimeString([], { hour: "numeric" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatModelLabel(model: string): string {
  return model === "auto" ? "auto (unresolved)" : model;
}

// A "nice" y-axis ceiling (1/2/5 × 10^n) so grid labels read like 2.5M
// rather than an arbitrary max-of-data fraction.
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

function OverTimeSection({ range }: { range: UsageWindow }) {
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [series, setSeries] = useState<UsageSeriesResponseWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bucket = SERIES_BUCKET[range];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageSeries({ window: range, groupBy: "model", bucket })
      .then((rows) => {
        if (cancelled) return;
        setSeries(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, bucket]);

  const pivoted = useMemo(() => (series ? pivotSeries(series, metric) : null), [series, metric]);
  const hasData = !!pivoted && pivoted.buckets.some((b) => b.total > 0);

  return (
    <section className="surface-region usage-stack-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="brand" aria-hidden="true">
          ▤
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Over time</span>
        </span>
        <span className="surface-region-spacer" />
        <MetricToggle value={metric} onChange={setMetric} />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load usage series</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : pivoted && hasData ? (
          <StackChart
            series={pivoted.series}
            buckets={pivoted.buckets}
            bucket={bucket}
            metric={metric}
          />
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No token spend recorded in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function StackChart({
  series,
  buckets,
  bucket,
  metric,
}: {
  series: ChartSeries[];
  buckets: StackBucket[];
  bucket: UsageSeriesBucket;
  metric: ChartMetric;
}) {
  const format = formatMetric(metric);
  const measure = metric === "tokens" ? "Tokens" : "Cost";
  const width = 960;
  const height = 300;
  const padL = 46;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const rawMax = Math.max(...buckets.map((b) => b.total), 0);
  const ymax = niceCeiling(rawMax * 1.05);

  const groupW = plotW / buckets.length;
  const barW = Math.min(58, groupW * 0.52);

  // Cap x-axis labels to roughly 8 so hourly (24-point) and 30-day series
  // don't collide into an unreadable smear of overlapping text.
  const labelStride = Math.max(1, Math.ceil(buckets.length / 8));

  const gridLines = [0, 1, 2, 3, 4].map((t) => {
    const value = (t * ymax) / 4;
    const y = padT + plotH - (value / ymax) * plotH;
    return { value, y };
  });

  // Pointer and keyboard focus are tracked apart so leaving the chart with the
  // mouse falls back to the focused bar instead of closing its details.
  const [pointer, setPointer] = useState<{ bucket: number; series: number | null } | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const active = pointer ?? (focused !== null ? { bucket: focused, series: null } : null);
  const hover = dismissed ? null : active;
  const hovered = hover ? buckets[hover.bucket] : undefined;
  const tooltipId = useId();

  const open = hover !== null;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="usage-stack-chart">
      <svg
        className="usage-stack-svg"
        viewBox={`0 0 ${width} ${height}`}
        aria-label={`${measure} over time by model, bucketed by ${bucket}`}
        onPointerLeave={() => setPointer(null)}
      >
        {gridLines.map(({ value, y }) => (
          <g key={value}>
            <line className="usage-grid-line" x1={padL} x2={width - padR} y1={y} y2={y} />
            <text className="usage-axis-label" x={padL - 8} y={y + 3} textAnchor="end">
              {value ? format(value) : "0"}
            </text>
          </g>
        ))}
        {buckets.map((b, d) => {
          const xc = padL + groupW * d + groupW / 2;
          let cum = 0;
          let topIdx = -1;
          b.values.forEach((v, j) => {
            if (v > 0) topIdx = j;
          });
          const segmentHover = (j: number | null) => () => {
            setPointer({ bucket: d, series: j });
            setDismissed(false);
          };
          return (
            <g key={b.iso} data-active={hover?.bucket === d || undefined}>
              {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: keyboard focus opens the bucket's details without an action, like a pointer hover. */}
              <rect
                className="usage-stack-hit"
                data-testid={`usage-stack-hit-${b.iso}`}
                x={padL + groupW * d}
                y={padT}
                width={groupW}
                height={plotH}
                tabIndex={0}
                role="img"
                aria-label={`${formatBucketLabel(b.iso, bucket)}: ${format(b.total)}${metric === "tokens" ? " tokens" : ""}`}
                aria-describedby={hover?.bucket === d ? tooltipId : undefined}
                onPointerEnter={segmentHover(null)}
                onFocus={() => {
                  setFocused(d);
                  setDismissed(false);
                }}
                onBlur={() => setFocused((current) => (current === d ? null : current))}
              />
              {b.values.map((v, j) => {
                if (v <= 0) return null;
                const h = (v / ymax) * plotH;
                const yTop = padT + plotH - ((cum + v) / ymax) * plotH;
                cum += v;
                const gh = Math.max(1, h - 2);
                const { key, color } = series[j] as ChartSeries;
                if (j === topIdx) {
                  const r = 4;
                  const x = xc - barW / 2;
                  const w = barW;
                  const path = `M ${x} ${yTop + gh} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} L ${x + w - r} ${yTop} Q ${x + w} ${yTop} ${x + w} ${yTop + r} L ${x + w} ${yTop + gh} Z`;
                  return (
                    <path
                      key={key}
                      className="usage-seg-rect"
                      d={path}
                      fill={color}
                      onPointerEnter={segmentHover(j)}
                    />
                  );
                }
                return (
                  <rect
                    key={key}
                    className="usage-seg-rect"
                    onPointerEnter={segmentHover(j)}
                    x={xc - barW / 2}
                    y={yTop}
                    width={barW}
                    height={gh}
                    fill={color}
                  />
                );
              })}
              {d % labelStride === 0 && (
                <text className="usage-axis-label" x={xc} y={height - 8} textAnchor="middle">
                  {formatBucketLabel(b.iso, bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && hovered && (
        <StackTooltip
          id={tooltipId}
          series={series}
          bucket={hovered}
          activeSeries={hover.series}
          title={formatBucketLabel(hovered.iso, bucket)}
          format={format}
          anchorPct={((padL + groupW * hover.bucket + groupW / 2) / width) * 100}
        />
      )}
      <div className="usage-legend">
        {series.map((s) => (
          <span className="usage-legend-item" key={s.key}>
            <span className="usage-sdot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <StackDataTable
        series={series}
        buckets={buckets}
        bucket={bucket}
        measure={measure}
        format={format}
      />
    </div>
  );
}

// Screen readers get every bucket's models from this table; the tooltip is
// the pointer and keyboard view of the same numbers.
function StackDataTable({
  series,
  buckets,
  bucket,
  measure,
  format,
}: {
  series: ChartSeries[];
  buckets: StackBucket[];
  bucket: UsageSeriesBucket;
  measure: string;
  format: (value: number) => string;
}) {
  const rows = buckets.flatMap((b) => {
    const named = series
      .map((s, j) => ({ key: s.key, value: b.values[j] ?? 0 }))
      .filter((m) => m.key !== OTHER_SERIES_KEY);
    return [...named, ...b.folded]
      .filter((m) => m.value > 0)
      .sort((x, y) => y.value - x.value)
      .map((m) => ({ b, ...m }));
  });
  return (
    <table style={VISUALLY_HIDDEN_STYLE}>
      <caption>
        {measure} by model per {bucket}
      </caption>
      <thead>
        <tr>
          <th scope="col">{bucket === "hour" ? "Hour" : "Day"}</th>
          <th scope="col">Model</th>
          <th scope="col">{measure}</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ b, key, value }) => (
          <tr key={`${b.iso}\u0000${key}`}>
            <td>{formatBucketLabel(b.iso, bucket)}</td>
            <td>{formatModelLabel(key)}</td>
            <td>{format(value)}</td>
            <td>{b.total > 0 ? `${Math.round((value / b.total) * 100)}%` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Past this many, the Other rows end in a "+N more" line so the card stays
// inside the region, whose overflow is hidden.
const TOOLTIP_FOLDED_ROWS = 4;

// Lists the stack top-down so rows line up with the bar, and opens the Other
// segment into the models it folds, which its shared gray cannot name.
function StackTooltip({
  id,
  series,
  bucket,
  activeSeries,
  title,
  format,
  anchorPct,
}: {
  series: ChartSeries[];
  bucket: StackBucket;
  activeSeries: number | null;
  title: string;
  format: (value: number) => string;
  anchorPct: number;
  id: string;
}) {
  const share = (v: number) => (bucket.total > 0 ? `${Math.round((v / bucket.total) * 100)}%` : "");
  const rows = series
    .map((s, j) => ({ s, j, value: bucket.values[j] ?? 0 }))
    .filter((r) => r.value > 0)
    .reverse();
  const flipLeft = anchorPct > 50;
  return (
    <div
      id={id}
      className="usage-stack-tooltip"
      role="tooltip"
      style={flipLeft ? { right: `${100 - anchorPct}%` } : { left: `${anchorPct}%` }}
      data-side={flipLeft ? "left" : "right"}
    >
      <div className="usage-stack-tooltip-title">
        <span>{title}</span>
        <span className="usage-mono">{format(bucket.total)}</span>
      </div>
      {rows.map(({ s, j, value }) => (
        <div key={s.key}>
          <div className="usage-stack-tooltip-row" data-active={activeSeries === j || undefined}>
            <span className="usage-sdot" style={{ background: s.color }} />
            <span className="usage-stack-tooltip-label">
              {s.key === OTHER_SERIES_KEY ? "Other" : formatModelLabel(s.label)}
            </span>
            <span className="usage-stack-tooltip-value">{format(value)}</span>
            <span className="usage-stack-tooltip-share">{share(value)}</span>
          </div>
          {s.key === OTHER_SERIES_KEY &&
            bucket.folded.slice(0, TOOLTIP_FOLDED_ROWS).map((m) => (
              <div key={m.key} className="usage-stack-tooltip-row usage-stack-tooltip-row--sub">
                <span className="usage-stack-tooltip-label">{formatModelLabel(m.key)}</span>
                <span className="usage-stack-tooltip-value">{format(m.value)}</span>
                <span className="usage-stack-tooltip-share">{share(m.value)}</span>
              </div>
            ))}
          {s.key === OTHER_SERIES_KEY && bucket.folded.length > TOOLTIP_FOLDED_ROWS && (
            <div className="usage-stack-tooltip-row usage-stack-tooltip-row--sub">
              <span className="usage-stack-tooltip-label">
                +{bucket.folded.length - TOOLTIP_FOLDED_ROWS} more
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const TOKEN_TYPES = [
  { id: "cacheRead", label: "Cache read", short: "cached" },
  { id: "input", label: "Input", short: "in" },
  { id: "cacheWrite", label: "Cache write", short: "write" },
  { id: "output", label: "Output", short: "out" },
] as const;
type TokenType = (typeof TOKEN_TYPES)[number]["id"];
type ByTokenType = Record<TokenType, number>;

interface RosterRow {
  key: string;
  turns: number;
  tokens: number;
  tokensByType: ByTokenType;
  costByType: ByTokenType;
  cacheHitRatio: number | null;
  costUsd: number | null;
  pricedCostUsd: number;
  unpricedEvents: number;
  priceCards: UsagePriceCardWire[];
  color: string;
}

function rateOf(card: UsagePriceCardWire, type: TokenType): number {
  switch (type) {
    case "cacheRead":
      return card.cacheReadPerMTok;
    case "input":
      return card.inputPerMTok;
    case "cacheWrite":
      return card.cacheWritePerMTok;
    case "output":
      return card.outputPerMTok;
  }
}

// Whole dollars stay whole ($10); otherwise at least cents, and a third
// decimal only when the rate needs it ($0.025).
function formatRate(n: number): string {
  if (Number.isInteger(n)) return `$${n}`;
  const cents = n.toFixed(2);
  return Number(cents) === n ? `$${cents}` : `$${Number(n.toFixed(3))}`;
}

function priceSourceLabel(card: UsagePriceCardWire): string {
  if (card.source === "override") return "Override";
  if (card.source === "bundled") return "Anthropic list";
  return card.provider.charAt(0).toUpperCase() + card.provider.slice(1);
}

function priceSourceLabels(cards: readonly UsagePriceCardWire[]): string[] {
  return [...new Set(cards.map(priceSourceLabel))];
}

// `pricedUsd` is what the server charged for this type. Cache writes priced
// partly at the 1-hour rate differ from tokens × the 5-minute rate, so the
// 1-hour rate is named and the server's figure shown.
function costMath(
  type: TokenType,
  tokens: number,
  card: UsagePriceCardWire,
  pricedUsd?: number,
): string {
  const label = TOKEN_TYPES.find((t) => t.id === type)?.label ?? type;
  const rate = rateOf(card, type);
  const atBaseRate = (tokens * rate) / 1_000_000;
  const rate1h = card.cacheWrite1hPerMTok;
  const hasHourWrites =
    type === "cacheWrite" &&
    rate1h !== undefined &&
    rate1h !== rate &&
    pricedUsd !== undefined &&
    Math.abs(pricedUsd - atBaseRate) > 1e-9;
  const rates = hasHourWrites
    ? `${formatRate(rate)}/1M (1-hour: ${formatRate(rate1h)}/1M)`
    : `${formatRate(rate)}/1M`;
  return `${label}: ${formatTokens(tokens)} × ${rates} = ${formatCostUsd(hasHourWrites ? pricedUsd : atBaseRate)}`;
}

function PriceCardLine({ card }: { card: UsagePriceCardWire }) {
  return (
    <span className="usage-price-card">
      {TOKEN_TYPES.map(({ id, short }) => (
        <span key={id} className="usage-price-rate">
          <span className="usage-typedot" data-type={id} />
          <span className="usage-price-value">{formatRate(rateOf(card, id))}</span> {short}
        </span>
      ))}
      <span className="usage-price-source" data-source={card.source}>
        {priceSourceLabel(card)}
      </span>
    </span>
  );
}

function sumByType(values: ByTokenType): number {
  return values.input + values.cacheRead + values.cacheWrite + values.output;
}

// One bar per measure, split by token type. Width is relative to the largest
// value in the table so a long token bar beside a short cost bar reads as cheap.
function TokenTypeBar({
  label,
  values,
  max,
  format,
  titleOf,
  showLabel = false,
}: {
  label: string;
  values: ByTokenType;
  max?: number;
  format: (value: number) => string;
  titleOf?: (type: TokenType) => string;
  showLabel?: boolean;
}) {
  const total = sumByType(values);
  const scale = max ?? total;
  const width = scale > 0 ? Math.max(total > 0 ? 1 : 0, (total / scale) * 100) : 0;
  return (
    <span
      className="usage-typebar"
      data-labeled={showLabel || undefined}
      role="img"
      aria-label={`${label}: ${format(total)}`}
    >
      {showLabel && <span className="usage-typebar-label">{label}</span>}
      <span className="usage-typebar-track">
        <span className="usage-typebar-fill" style={{ width: `${width}%` }}>
          {TOKEN_TYPES.map(({ id, label: typeLabel }) =>
            values[id] > 0 ? (
              <span
                key={id}
                className="usage-typebar-seg"
                data-type={id}
                style={{ flexGrow: values[id] }}
                title={titleOf ? titleOf(id) : `${typeLabel}: ${format(values[id])}`}
              />
            ) : null,
          )}
        </span>
      </span>
    </span>
  );
}

function ModelRosterSection({ range }: { range: UsageWindow }) {
  const [summary, setSummary] = useState<UsageSummaryResponseWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageSummary({ window: range, groupBy: "model" })
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const rows = useMemo((): RosterRow[] => {
    if (!summary) return [];
    const palette = assignSeriesColors(new Map(summary.groups.map((g) => [g.key, allTokens(g)])));
    return summary.groups
      .map((g) => {
        const tokensByType: ByTokenType = {
          input: g.inputTokens,
          cacheRead: g.cacheReadTokens,
          cacheWrite: g.cacheWriteTokens,
          output: g.outputTokens,
        };
        const tokens = sumByType(tokensByType);
        return {
          key: g.key,
          turns: g.events,
          tokens,
          tokensByType,
          costByType: { ...g.pricedCostByTypeUsd },
          cacheHitRatio: g.cacheHitRatio,
          costUsd: g.costUsd,
          pricedCostUsd: g.pricedCostUsd,
          unpricedEvents: g.unpricedEvents,
          priceCards: g.priceCards,
          color: palette.colorOf(g.key),
        };
      })
      .sort((a, b) => b.pricedCostUsd - a.pricedCostUsd || b.tokens - a.tokens);
  }, [summary]);

  const maxTokens = Math.max(0, ...rows.map((r) => r.tokens));
  const maxCost = Math.max(0, ...rows.map((r) => r.pricedCostUsd));

  return (
    <section className="surface-region usage-roster-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="brand" aria-hidden="true">
          ◆
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Model roster</span>
        </span>
        <span className="surface-region-spacer" />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load model roster</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : rows.length > 0 ? (
          <>
            <div className="canvas-view-table">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Turns</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Cache hit</th>
                    <th>Tokens vs cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span className="usage-sdot" style={{ background: r.color }} />
                          {formatModelLabel(r.key)}
                        </span>
                        {r.priceCards.map((card) => (
                          <PriceCardLine key={`${card.provider}-${card.source}`} card={card} />
                        ))}
                        {r.priceCards.length === 0 && (
                          <span className="usage-price-card usage-price-none">No price</span>
                        )}
                      </td>
                      <td>{r.turns.toLocaleString()}</td>
                      <td>{formatTokens(r.tokens)}</td>
                      <td>
                        {formatAggregateCost(
                          r.costUsd,
                          r.pricedCostUsd,
                          r.unpricedEvents,
                          r.turns - r.unpricedEvents,
                        )}
                      </td>
                      <td>{formatCacheHit(r.cacheHitRatio)}</td>
                      <td className="usage-typebar-cell">
                        <TokenTypeBar
                          label="Tokens"
                          values={r.tokensByType}
                          max={maxTokens}
                          format={formatTokens}
                          showLabel
                        />
                        <TokenTypeBar
                          label="Cost"
                          values={r.costByType}
                          max={maxCost}
                          format={formatCostUsd}
                          showLabel
                          titleOf={
                            r.priceCards.length === 1
                              ? (type) =>
                                  costMath(
                                    type,
                                    r.tokensByType[type],
                                    r.priceCards[0] as UsagePriceCardWire,
                                    r.costByType[type],
                                  )
                              : undefined
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="usage-legend">
              {TOKEN_TYPES.map(({ id, label }) => (
                <span className="usage-legend-item" key={id}>
                  <span className="usage-typedot" data-type={id} />
                  {label}
                </span>
              ))}
              <span className="usage-legend-item">Rates per 1M tokens</span>
            </div>
          </>
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No model spend recorded in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FlowSection({ range }: { range: UsageWindow }) {
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [rows, setRows] = useState<UsageBreakdownResponseWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageBreakdown({ window: range, groupBy: "sourceDetail", splitBy: "model" })
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <section className="surface-region usage-flow-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="info" aria-hidden="true">
          ⇄
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Source → model flow</span>
        </span>
        <span className="surface-region-spacer" />
        <MetricToggle value={metric} onChange={setMetric} />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load source to model flow</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : rows?.some((row) => allTokens(row) > 0) ? (
          <FlowChart rows={rows} metric={metric} />
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No source to model flow recorded in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

// Ribbons wear their model's color, the same palette as the page's other charts.
function FlowChart({ rows, metric }: { rows: UsageBreakdownResponseWire; metric: ChartMetric }) {
  const format = formatMetric(metric);
  const links = rows
    .map((row) => ({
      source: row.key,
      model: row.split,
      value: metricValue(row, metric),
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const modelTotals = new Map<string, number>();
  for (const row of rows) {
    modelTotals.set(row.split, (modelTotals.get(row.split) ?? 0) + allTokens(row));
  }
  const palette = assignSeriesColors(modelTotals);
  const total = links.reduce((sum, row) => sum + row.value, 0);
  const sources = [...new Set(links.map((row) => row.source))].sort((a, b) => a.localeCompare(b));
  const models = [...new Set(links.map((row) => row.model))].sort((a, b) => a.localeCompare(b));
  const width = 960;
  const height = Math.max(220, Math.max(sources.length, models.length) * 54 + 48);
  const leftX = 130;
  const rightX = width - 170;
  const yFor = (items: string[], item: string) => {
    const idx = Math.max(0, items.indexOf(item));
    return 36 + (idx + 0.5) * ((height - 72) / Math.max(items.length, 1));
  };
  const maxValue = Math.max(...links.map((row) => row.value), Number.MIN_VALUE);

  return (
    <div className="usage-flow-wrap">
      <svg
        className="usage-flow-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Source to model ${metric === "tokens" ? "token" : "cost"} flow`}
      >
        {links.map((link) => {
          const y1 = yFor(sources, link.source);
          const y2 = yFor(models, link.model);
          const strokeWidth = Math.max(3, (link.value / maxValue) * 22);
          const share = total > 0 ? Math.round((link.value / total) * 100) : 0;
          const color = palette.colorOf(link.model);
          return (
            <path
              key={`${link.source}-${link.model}`}
              className="usage-flow-ribbon"
              d={`M ${leftX} ${y1} C ${leftX + 210} ${y1}, ${rightX - 210} ${y2}, ${rightX} ${y2}`}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
            >
              <title>
                {link.source} → {formatModelLabel(link.model)} · {format(link.value)} · {share}%
              </title>
            </path>
          );
        })}
        {sources.map((source, i) => (
          <g key={source} transform={`translate(0 ${yFor(sources, source)})`}>
            <circle className="usage-flow-node-dot" r="5" cx={leftX} cy="0" />
            <text className="usage-flow-label" x={leftX - 14} y="4" textAnchor="end">
              {source}
            </text>
            <text className="usage-flow-side-label" x={leftX - 14} y="-14" textAnchor="end">
              {i === 0 ? "Source" : ""}
            </text>
          </g>
        ))}
        {models.map((model, i) => (
          <g key={model} transform={`translate(0 ${yFor(models, model)})`}>
            <circle className="usage-flow-node-dot" r="5" cx={rightX} cy="0" />
            <text className="usage-flow-label" x={rightX + 14} y="4">
              {formatModelLabel(model)}
            </text>
            <text className="usage-flow-side-label" x={rightX + 14} y="-14">
              {i === 0 ? "Model" : ""}
            </text>
          </g>
        ))}
      </svg>
      <div className="usage-legend">
        {palette.named.map((model) => (
          <span className="usage-legend-item" key={`${model}-legend`}>
            <span className="usage-sdot" style={{ background: palette.colorOf(model) }} />
            {formatModelLabel(model)}
          </span>
        ))}
        {palette.folded.length > 0 && (
          <span className="usage-legend-item">
            <span className="usage-sdot" style={{ background: OTHER_SERIES_COLOR }} />
            {otherSeriesLabel(palette.folded)}
          </span>
        )}
      </div>
    </div>
  );
}

interface JobRow {
  key: string;
  count: number;
  unit: "run" | "turn";
  costUsd: number;
  lowerBound: boolean;
  unpricedEvents: number;
  mainModel: string | null;
  mainModelCostShare: number | null;
}

// Rib turns recorded without a run id each count as their own "run" on the
// wire, so those jobs are measured per turn rather than per run.
function toJobRow(job: UsageJobsRowWire): JobRow {
  const events = job.pricedEvents + job.unpricedEvents;
  const perTurn = job.eventsWithoutRun > 0;
  return {
    key: job.key,
    count: perTurn ? events : job.runs,
    unit: perTurn ? "turn" : "run",
    costUsd: job.pricedTotalCostUsd,
    lowerBound: job.totalCostUsd === null && job.unpricedEvents > 0,
    unpricedEvents: job.unpricedEvents,
    mainModel: job.mainModel,
    mainModelCostShare: job.mainModelCostShare,
  };
}

function JobsSection({ range }: { range: UsageWindow }) {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageJobs({ window: range })
      .then((res) => {
        if (!cancelled) {
          setJobs(
            res.map(toJobRow).sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key)),
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const maxCost = Math.max(0, ...(jobs ?? []).map((job) => job.costUsd));
  const unpriced = (jobs ?? []).reduce((sum, job) => sum + job.unpricedEvents, 0);

  return (
    <section className="surface-region usage-jobs-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="brand" aria-hidden="true">
          ⟳
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Jobs</span>
        </span>
        <span className="surface-region-spacer" />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load jobs</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : jobs && jobs.length > 0 ? (
          <>
            <div className="canvas-view-table">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Runs</th>
                    <th>Cost</th>
                    <th>Cost each</th>
                    <th>Main model</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const pct = maxCost > 0 ? Math.max(2, (job.costUsd / maxCost) * 100) : 0;
                    const mark = job.lowerBound ? " *" : "";
                    return (
                      <tr key={job.key}>
                        <td>{job.key}</td>
                        <td>
                          {job.count.toLocaleString()} {job.count === 1 ? job.unit : `${job.unit}s`}
                        </td>
                        <td>
                          <span className="usage-job-cost">
                            <span className="usage-popover-meter">
                              <span
                                className="usage-popover-meter-fill"
                                style={{ width: `${pct}%`, background: "var(--accent)" }}
                              />
                            </span>
                            <span className="usage-mono">
                              {formatCostUsd(job.costUsd)}
                              {mark}
                            </span>
                          </span>
                        </td>
                        <td>
                          {job.count > 0
                            ? `${formatCostUsd(job.costUsd / job.count)}${mark} / ${job.unit}`
                            : "—"}
                        </td>
                        <td>
                          {job.mainModel === null
                            ? "—"
                            : `${formatModelLabel(job.mainModel)}${
                                job.mainModelCostShare === null
                                  ? ""
                                  : ` · ${Math.round(job.mainModelCostShare * 100)}%`
                              }`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {unpriced > 0 && (
              <p className="page-sub usage-jobs-note">
                * Lower bound: {unpriced.toLocaleString()} {unpriced === 1 ? "turn" : "turns"} ran
                on a model with no known price.
              </p>
            )}
          </>
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No recurring workflow or rib spend in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ledgerCostMath(ev: UsageEventRowWire): string | undefined {
  const card = ev.priceCard;
  if (!card) return undefined;
  const tokens: ByTokenType = {
    cacheRead: ev.cacheReadTokens ?? 0,
    input: ev.inputTokens,
    cacheWrite: ev.cacheWriteTokens ?? 0,
    output: ev.outputTokens,
  };
  const othersUsd =
    (tokens.cacheRead * card.cacheReadPerMTok +
      tokens.input * card.inputPerMTok +
      tokens.output * card.outputPerMTok) /
    1_000_000;
  const cacheWriteUsd = ev.costUsd !== null ? Math.max(0, ev.costUsd - othersUsd) : undefined;
  return [
    ...TOKEN_TYPES.filter(({ id }) => tokens[id] > 0).map(({ id }) =>
      costMath(id, tokens[id], card, id === "cacheWrite" ? cacheWriteUsd : undefined),
    ),
    priceSourceLabel(card),
  ].join("\n");
}

// Statuses beyond these mapped spellings (the read side accepts any string)
// fall to the neutral pending dot rather than reading as failures.
function statusDotClass(status: string): string {
  if (status === "ok" || status === "succeeded") return "completed";
  if (status === "error" || status === "failed" || status === "timeout") return "failed";
  if (status === "aborted" || status === "cancelled") return "cancelled";
  return "pending";
}

function formatEventDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

const LEDGER_PAGE = 50;
// The server caps /api/usage/events at 500 rows.
const LEDGER_MAX = 500;
const LEDGER_SOURCES: UsageEventSourceWire[] = ["chat", "workflow", "rib"];
const LEDGER_STATUSES = ["ok", "error", "aborted", "timeout"] as const;

function LedgerSection({ range }: { range: UsageWindow }) {
  const [models, setModels] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<UsageEventSourceWire | "all">("all");
  const [modelFilter, setModelFilter] = useState<string | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filtered = sourceFilter !== "all" || modelFilter !== "all" || statusFilter !== "all";
  // Page size and rows belong to one window+filter combination, so changing
  // either starts over at one page instead of showing the previous rows.
  const queryKey = [range, sourceFilter, modelFilter, statusFilter].join("\u0000");
  const [page, setPage] = useState({ key: queryKey, limit: LEDGER_PAGE });
  const limit = page.key === queryKey ? page.limit : LEDGER_PAGE;
  const [loaded, setLoaded] = useState<{ key: string; events: UsageEventRowWire[] } | null>(null);
  const events = loaded?.key === queryKey ? loaded.events : null;

  useEffect(() => {
    let cancelled = false;
    getUsageSummary({ window: range, groupBy: "model" })
      .then((summary) => {
        if (cancelled) return;
        const keys = summary.groups.map((group) => group.key);
        setModels(keys);
        // A model picked in a wider window may have no chip in this one.
        setModelFilter((current) =>
          current === "all" || keys.includes(current) ? current : "all",
        );
      })
      .catch(() => {
        // The chips are a convenience; the ledger itself still loads without them.
        if (cancelled) return;
        setModels([]);
        setModelFilter("all");
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageEvents({
      window: range,
      limit,
      source: sourceFilter === "all" ? undefined : sourceFilter,
      model: modelFilter === "all" ? undefined : modelFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
    })
      .then((res) => {
        if (!cancelled) setLoaded({ key: queryKey, events: res });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, sourceFilter, modelFilter, statusFilter, limit, queryKey]);

  const capped = !!events && events.length >= limit;
  const now = new Date();

  return (
    <section className="surface-region usage-ledger-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="info" aria-hidden="true">
          ≡
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Ledger</span>
        </span>
        <span className="surface-region-spacer" />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        <fieldset className="usage-ledger-filters">
          <legend style={VISUALLY_HIDDEN_STYLE}>Ledger filters</legend>
          <FilterChip
            label="All sources"
            active={sourceFilter === "all"}
            onClick={() => setSourceFilter("all")}
          />
          {LEDGER_SOURCES.map((source) => (
            <FilterChip
              key={source}
              label={source}
              active={sourceFilter === source}
              onClick={() => setSourceFilter(source)}
            />
          ))}
          <span className="usage-filter-sep" />
          <FilterChip
            label="All models"
            active={modelFilter === "all"}
            onClick={() => setModelFilter("all")}
          />
          {models.map((model) => (
            <FilterChip
              key={model}
              label={formatModelLabel(model)}
              active={modelFilter === model}
              onClick={() => setModelFilter(model)}
            />
          ))}
          <span className="usage-filter-sep" />
          <FilterChip
            label="All statuses"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          {LEDGER_STATUSES.map((status) => (
            <FilterChip
              key={status}
              label={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            />
          ))}
        </fieldset>
        {events && !error && (
          <div className="usage-ledger-count page-sub">
            {capped
              ? `Latest ${events.length.toLocaleString()} events`
              : `${events.length.toLocaleString()} ${events.length === 1 ? "event" : "events"}`}
          </div>
        )}
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load the ledger</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading && !events ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : events && events.length > 0 ? (
          <>
            <div className="canvas-view-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Model</th>
                    {TOKEN_TYPES.map(({ id, label }) => (
                      <th key={id}>
                        <span className="usage-th-type">
                          <span className="usage-typedot" data-type={id} />
                          {label}
                        </span>
                      </th>
                    ))}
                    <th>Cost</th>
                    <th>Dur</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id}>
                      <td>{formatLedgerTime(ev.ts, now)}</td>
                      <td>
                        <span className="pill">{ev.source}</span>
                      </td>
                      <td>
                        <span className="run-provenance">
                          {formatProviderModel(ev.provider, formatModelLabel(ev.model)) ??
                            formatModelLabel(ev.model)}
                        </span>
                      </td>
                      <td>{ev.cacheReadTokens != null ? formatTokens(ev.cacheReadTokens) : "—"}</td>
                      <td>{formatTokens(ev.inputTokens)}</td>
                      <td>
                        {ev.cacheWriteTokens != null ? formatTokens(ev.cacheWriteTokens) : "—"}
                      </td>
                      <td>{formatTokens(ev.outputTokens)}</td>
                      <td title={ledgerCostMath(ev)}>{formatCostUsd(ev.costUsd)}</td>
                      <td>{ev.durationMs != null ? formatEventDuration(ev.durationMs) : "—"}</td>
                      <td>
                        <span className={`status-dot ${statusDotClass(ev.status)}`} />
                        {ev.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {capped &&
              (limit < LEDGER_MAX ? (
                <button
                  type="button"
                  className="chip usage-ledger-more"
                  disabled={loading}
                  onClick={() =>
                    setPage({ key: queryKey, limit: Math.min(limit + LEDGER_PAGE, LEDGER_MAX) })
                  }
                >
                  {loading ? "Loading…" : "Show more"}
                </button>
              ) : (
                <div className="usage-ledger-count page-sub">
                  Showing the latest {LEDGER_MAX}. Narrow the filters to see older events.
                </div>
              ))}
          </>
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">
              {filtered
                ? "No events match these filters in this window."
                : "No events recorded in this window yet."}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

// Rows older than today carry their date; the 7d and 30d windows span days.
function formatLedgerTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`chip${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

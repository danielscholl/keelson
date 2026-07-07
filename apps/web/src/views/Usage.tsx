// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  USAGE_PULSE_SNAPSHOT_KEY,
  type UsageEventRowWire,
  type UsageEventSourceWire,
  type UsageSeriesResponseWire,
  type UsageSummaryResponseWire,
  usagePulseSnapshotSchema,
} from "@keelson/shared";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
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
import { formatTokens } from "../lib/formatTokens.ts";

const WINDOWS: UsageWindow[] = ["24h", "7d", "30d"];
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

// The validated categorical series palette (see app.css --s1..--s6): cycled
// by model index so the stack and legend agree regardless of how many
// distinct models appear in the window.
const SERIES_COLOR_COUNT = 6;

// Statuses that count as spend without a kept result — the failure-burn tile
// sums these. usage/summary has no status dimension (its groups are by
// model/provider/source/rib/workflow), so this pulls from usage/events
// instead, one query per non-ok status so a burst of failures can't crowd a
// shared limit out of the recent window the way a single combined query would.
const FAILURE_STATUSES = ["error", "aborted", "timeout"] as const;
const FAILURE_EVENTS_LIMIT = 200;

function cacheReadRate(inputTokens: number, cacheReadTokens: number) {
  const totalInputTokens = inputTokens + cacheReadTokens;
  return totalInputTokens > 0 ? Math.round((cacheReadTokens / totalInputTokens) * 100) : 0;
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
          <SignalsSection range={range} />
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
            tokens += ev.inputTokens + ev.outputTokens;
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
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const totalInputTokens = totals.inputTokens + totals.cacheReadTokens;
  const cacheReadRatePct = cacheReadRate(totals.inputTokens, totals.cacheReadTokens);

  return (
    <div className="usage-stats">
      <div className="usage-stat">
        <div className="usage-stat-value">{formatTokens(totalTokens)}</div>
        <div className="usage-stat-label">Tokens</div>
        <div className="usage-stat-sub usage-mono">
          ↑ {formatTokens(totals.inputTokens)} in · ↓ {formatTokens(totals.outputTokens)} out
        </div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value">{totals.events.toLocaleString()}</div>
        <div className="usage-stat-label">Agent turns</div>
        <div className="usage-stat-sub">chat · workflows · ribs</div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value" data-tone="ok">
          {cacheReadRatePct}%
        </div>
        <div className="usage-stat-label">Cache read rate</div>
        <div className="usage-stat-sub usage-mono">
          {formatTokens(totals.cacheReadTokens)} of {formatTokens(totalInputTokens)} input
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

  const values = useMemo(
    () => minuteSeries.map((m) => m.inputTokens + m.outputTokens + m.cacheReadTokens),
    [minuteSeries],
  );

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
}

// Pivots the flat series rows (one row per bucket × model) into per-bucket
// stacks, in alphabetical model order — the same localeCompare order the
// roster's palette index uses, so a model wears one color everywhere.
function pivotSeries(rows: UsageSeriesResponseWire): { models: string[]; buckets: StackBucket[] } {
  const totalsByModel = new Map<string, Map<string, number>>();
  const bucketTotals = new Map<string, number>();

  for (const row of rows) {
    const tokens = row.inputTokens + row.outputTokens;
    let perBucket = totalsByModel.get(row.key);
    if (!perBucket) {
      perBucket = new Map();
      totalsByModel.set(row.key, perBucket);
    }
    perBucket.set(row.bucketIso, (perBucket.get(row.bucketIso) ?? 0) + tokens);
    bucketTotals.set(row.bucketIso, (bucketTotals.get(row.bucketIso) ?? 0) + tokens);
  }

  const models = [...totalsByModel.keys()].sort((a, b) => a.localeCompare(b));
  const buckets = [...bucketTotals.keys()].sort().map((iso) => ({
    iso,
    values: models.map((m) => totalsByModel.get(m)?.get(iso) ?? 0),
    total: bucketTotals.get(iso) ?? 0,
  }));
  return { models, buckets };
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

  const pivoted = useMemo(() => (series ? pivotSeries(series) : null), [series]);
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
          <StackChart models={pivoted.models} buckets={pivoted.buckets} bucket={bucket} />
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
  models,
  buckets,
  bucket,
}: {
  models: string[];
  buckets: StackBucket[];
  bucket: UsageSeriesBucket;
}) {
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

  return (
    <>
      <svg
        className="usage-stack-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Tokens over time by model, bucketed by ${bucket}`}
      >
        {gridLines.map(({ value, y }) => (
          <g key={value}>
            <line className="usage-grid-line" x1={padL} x2={width - padR} y1={y} y2={y} />
            <text className="usage-axis-label" x={padL - 8} y={y + 3} textAnchor="end">
              {value ? formatTokens(value) : "0"}
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
          return (
            <g key={b.iso}>
              {b.values.map((v, j) => {
                if (v <= 0) return null;
                const h = (v / ymax) * plotH;
                const yTop = padT + plotH - ((cum + v) / ymax) * plotH;
                cum += v;
                const gh = Math.max(1, h - 2);
                const color = `var(--s${(j % SERIES_COLOR_COUNT) + 1})`;
                if (j === topIdx) {
                  const r = 4;
                  const x = xc - barW / 2;
                  const w = barW;
                  const path = `M ${x} ${yTop + gh} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} L ${x + w - r} ${yTop} Q ${x + w} ${yTop} ${x + w} ${yTop + r} L ${x + w} ${yTop + gh} Z`;
                  return <path key={models[j]} className="usage-seg-rect" d={path} fill={color} />;
                }
                return (
                  <rect
                    key={models[j]}
                    className="usage-seg-rect"
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
      <div className="usage-legend">
        {models.map((m, i) => (
          <span className="usage-legend-item" key={m}>
            <span
              className="usage-sdot"
              style={{ background: `var(--s${(i % SERIES_COLOR_COUNT) + 1})` }}
            />
            {m}
          </span>
        ))}
      </div>
    </>
  );
}

interface RosterRow {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachePct: number;
  avgPerTurn: number;
  share: number;
  color: string;
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

  // usage/summary's groups come back ORDER BY key ASC (usage-store.ts), the
  // same order pivotSeries' first-seen model list settles into for the stack
  // chart — indexing the palette by that alphabetical order, not by this
  // table's tokens-desc display order, keeps a model's dot the same color
  // in both places.
  const rows = useMemo((): RosterRow[] => {
    if (!summary) return [];
    const colorIndex = new Map(
      [...summary.groups].sort((a, b) => a.key.localeCompare(b.key)).map((g, i) => [g.key, i]),
    );
    const grandTotal = summary.groups.reduce((sum, g) => sum + g.inputTokens + g.outputTokens, 0);
    return [...summary.groups]
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
      .map((g) => {
        const tokens = g.inputTokens + g.outputTokens;
        return {
          key: g.key,
          turns: g.events,
          inputTokens: g.inputTokens,
          outputTokens: g.outputTokens,
          cachePct: cacheReadRate(g.inputTokens, g.cacheReadTokens),
          avgPerTurn: g.events > 0 ? tokens / g.events : 0,
          share: grandTotal > 0 ? Math.round((tokens / grandTotal) * 100) : 0,
          color: `var(--s${((colorIndex.get(g.key) ?? 0) % SERIES_COLOR_COUNT) + 1})`,
        };
      });
  }, [summary]);

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
          <div className="canvas-view-table">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Turns</th>
                  <th>↑ In</th>
                  <th>↓ Out</th>
                  <th>Cache</th>
                  <th>Avg / turn</th>
                  <th>Share</th>
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
                    </td>
                    <td>{r.turns.toLocaleString()}</td>
                    <td>↑ {formatTokens(r.inputTokens)}</td>
                    <td>↓ {formatTokens(r.outputTokens)}</td>
                    <td>{r.cachePct}%</td>
                    <td>{formatTokens(r.avgPerTurn)}</td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span className="usage-popover-meter" style={{ width: 72 }}>
                          <span
                            className="usage-popover-meter-fill"
                            style={{ width: `${r.share}%`, background: r.color }}
                          />
                        </span>
                        <span>{r.share}%</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  const [rows, setRows] = useState<Array<{
    key: string;
    split: string;
    inputTokens: number;
    outputTokens: number;
  }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageBreakdown({ window: range, groupBy: "source", splitBy: "model" })
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
        ) : rows?.some((row) => row.inputTokens + row.outputTokens > 0) ? (
          <FlowChart rows={rows} />
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No source to model flow recorded in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FlowChart({
  rows,
}: {
  rows: Array<{ key: string; split: string; inputTokens: number; outputTokens: number }>;
}) {
  const links = rows
    .map((row) => ({
      source: row.key,
      model: row.split,
      tokens: row.inputTokens + row.outputTokens,
    }))
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = links.reduce((sum, row) => sum + row.tokens, 0);
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
  const maxTokens = Math.max(...links.map((row) => row.tokens), 1);

  return (
    <div className="usage-flow-wrap">
      <svg
        className="usage-flow-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Source to model token flow"
      >
        {links.map((link, i) => {
          const y1 = yFor(sources, link.source);
          const y2 = yFor(models, link.model);
          const strokeWidth = Math.max(3, (link.tokens / maxTokens) * 22);
          const share = total > 0 ? Math.round((link.tokens / total) * 100) : 0;
          const color = `var(--s${(i % SERIES_COLOR_COUNT) + 1})`;
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
                {link.source} → {formatModelLabel(link.model)} · {formatTokens(link.tokens)} ·{" "}
                {share}%
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
        {links.slice(0, 6).map((link, i) => (
          <span className="usage-legend-item" key={`${link.source}-${link.model}-legend`}>
            <span
              className="usage-sdot"
              style={{ background: `var(--s${(i % SERIES_COLOR_COUNT) + 1})` }}
            />
            {link.source} → {formatModelLabel(link.model)}
          </span>
        ))}
      </div>
    </div>
  );
}

function JobsSection({ range }: { range: UsageWindow }) {
  const [jobs, setJobs] = useState<Array<{
    key: string;
    runs: number;
    totalTokens: number;
    avgTokensPerRun: number;
    p95TokensPerRun: number;
  }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsageJobs({ window: range })
      .then((res) => {
        if (!cancelled) setJobs([...res].sort((a, b) => b.totalTokens - a.totalTokens));
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

  const maxTokens = Math.max(...(jobs ?? []).map((job) => job.totalTokens), 1);

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
                    <th>Avg tokens/run</th>
                    <th>p95</th>
                    <th>Window total</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.key}>
                      <td>{job.key}</td>
                      <td>{job.runs.toLocaleString()}</td>
                      <td>{formatTokens(job.avgTokensPerRun)}</td>
                      <td>{formatTokens(job.p95TokensPerRun)}</td>
                      <td>{formatTokens(job.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <section className="usage-burn-list" aria-label="Weekly burn by job">
              {jobs.map((job, i) => {
                const pct = Math.max(2, Math.round((job.totalTokens / maxTokens) * 100));
                return (
                  <div className="usage-burn-row" key={`${job.key}-burn`}>
                    <span className="usage-burn-label">{job.key}</span>
                    <span className="usage-popover-meter">
                      <span
                        className="usage-popover-meter-fill"
                        style={{
                          width: `${pct}%`,
                          background: `var(--s${(i % SERIES_COLOR_COUNT) + 1})`,
                        }}
                      />
                    </span>
                    <span className="usage-burn-value usage-mono">
                      {formatTokens(job.totalTokens)}
                    </span>
                  </div>
                );
              })}
            </section>
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

function SignalsSection({ range }: { range: UsageWindow }) {
  const [signals, setSignals] = useState<{
    failureTokens: number;
    failureTurns: number;
    failureTop: string | null;
    downshift: string | null;
    cacheReadRate: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      Promise.all(
        FAILURE_STATUSES.map((status) =>
          getUsageEvents({ window: range, status, limit: FAILURE_EVENTS_LIMIT }),
        ),
      ),
      getUsageJobs({ window: range }),
      getUsageSummary({ window: range }),
    ])
      .then(([eventsByStatus, jobs, summary]) => {
        if (cancelled) return;
        const failingEvents = eventsByStatus.flat();
        const attribution = new Map<string, number>();
        let failureTokens = 0;
        for (const ev of failingEvents) {
          const tokens = ev.inputTokens + ev.outputTokens;
          failureTokens += tokens;
          const key = ev.workflowName ?? ev.ribId ?? ev.source;
          attribution.set(key, (attribution.get(key) ?? 0) + tokens);
        }
        const failureTop = [...attribution.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const downshift =
          [...jobs]
            .filter((job) => job.runs >= 3 && job.avgTokensPerRun < 500)
            .sort((a, b) => b.runs - a.runs)[0]?.key ?? null;
        const { totals } = summary;
        setSignals({
          failureTokens,
          failureTurns: failingEvents.length,
          failureTop,
          downshift,
          cacheReadRate: cacheReadRate(totals.inputTokens, totals.cacheReadTokens),
        });
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
    <section className="surface-region usage-signals-region">
      <div className="surface-region-head">
        <span className="surface-region-glyph-chip" data-tone="caution" aria-hidden="true">
          ◇
        </span>
        <span className="surface-region-identity">
          <span className="surface-region-title">Signals</span>
        </span>
        <span className="surface-region-spacer" />
        <span className="surface-region-freshness">{WINDOW_LABEL[range]}</span>
      </div>
      <div className="surface-region-body">
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load signals</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : signals ? (
          <div className="usage-signals-grid">
            <SignalCard
              title="Failure burn"
              value={formatTokens(signals.failureTokens)}
              detail={
                signals.failureTurns > 0
                  ? `${signals.failureTurns} failed turns · top: ${signals.failureTop ?? "unknown"}`
                  : "No failure spend in this window."
              }
              tone={signals.failureTurns > 0 ? "hot" : "ok"}
            />
            <SignalCard
              title="Downshift candidate"
              value={signals.downshift ?? "No signal"}
              detail={
                signals.downshift
                  ? "High run count with low average tokens per run."
                  : "No high-volume low-output job found."
              }
            />
            <SignalCard
              title="Cache-read trend"
              value={`${signals.cacheReadRate}%`}
              detail="Current-window cache read share of input tokens."
              tone={signals.cacheReadRate > 0 ? "ok" : undefined}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SignalCard({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "ok" | "hot";
}) {
  return (
    <div className="usage-signal-card">
      <div className="usage-stat-label">{title}</div>
      <div className="usage-stat-value" data-tone={tone}>
        {value}
      </div>
      <div className="usage-stat-sub">{detail}</div>
    </div>
  );
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

const LEDGER_LIMIT = 50;
const LEDGER_SOURCES: UsageEventSourceWire[] = ["chat", "workflow", "rib"];
const LEDGER_STATUSES = ["ok", "error", "aborted", "timeout"] as const;

function LedgerSection({ range }: { range: UsageWindow }) {
  const [events, setEvents] = useState<UsageEventRowWire[] | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<UsageEventSourceWire | "all">("all");
  const [modelFilter, setModelFilter] = useState<string | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUsageSummary({ window: range, groupBy: "model" })
      .then((summary) => {
        if (!cancelled) setModels(summary.groups.map((group) => group.key));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
      limit: LEDGER_LIMIT,
      source: sourceFilter === "all" ? undefined : sourceFilter,
      model: modelFilter === "all" ? undefined : modelFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
    })
      .then((res) => {
        if (!cancelled) setEvents(res);
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
  }, [range, sourceFilter, modelFilter, statusFilter]);

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
        <div className="usage-ledger-count page-sub">
          {events ? `${events.length.toLocaleString()} events` : "Loading events"}
        </div>
        {error ? (
          <div className="empty-state" role="alert">
            <div className="empty-state-title">Couldn't load the ledger</div>
            <div className="empty-state-body">{error}</div>
          </div>
        ) : loading ? (
          <div className="page-sub" style={{ padding: "20px 0" }}>
            Loading…
          </div>
        ) : events && events.length > 0 ? (
          <div className="canvas-view-table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Model</th>
                  <th>↑ In</th>
                  <th>↓ Out</th>
                  <th>Cache</th>
                  <th>Dur</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>{new Date(ev.ts).toLocaleTimeString()}</td>
                    <td>
                      <span className="pill">{ev.source}</span>
                    </td>
                    <td>
                      <span className="run-provenance">
                        {formatProviderModel(ev.provider, formatModelLabel(ev.model)) ??
                          formatModelLabel(ev.model)}
                      </span>
                    </td>
                    <td>↑ {formatTokens(ev.inputTokens)}</td>
                    <td>↓ {formatTokens(ev.outputTokens)}</td>
                    <td>{ev.cacheReadTokens != null ? formatTokens(ev.cacheReadTokens) : "—"}</td>
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
        ) : (
          <div className="usage-stack-empty">
            <span className="page-sub">No events recorded in this window yet.</span>
          </div>
        )}
      </div>
    </section>
  );
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

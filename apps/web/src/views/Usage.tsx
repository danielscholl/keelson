// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  USAGE_PULSE_SNAPSHOT_KEY,
  type UsageSummaryResponseWire,
  usagePulseSnapshotSchema,
} from "@keelson/shared";
import { useEffect, useMemo, useState } from "react";
import { getUsageEvents, getUsageSummary, type UsageWindow } from "../api.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";
import { formatTokens } from "../lib/formatTokens.ts";

const WINDOWS: UsageWindow[] = ["24h", "7d", "30d"];
const WINDOW_LABEL: Record<UsageWindow, string> = { "24h": "24h", "7d": "7d", "30d": "30d" };

// Statuses that count as spend without a kept result — the failure-burn tile
// sums these. usage/summary has no status dimension (its groups are by
// model/provider/source/rib/workflow), so this pulls from usage/events
// instead, one query per non-ok status so a burst of failures can't crowd a
// shared limit out of the recent window the way a single combined query would.
const FAILURE_STATUSES = ["error", "aborted", "timeout"] as const;
const FAILURE_EVENTS_LIMIT = 200;

export function Usage() {
  const [range, setRange] = useState<UsageWindow>("7d");
  const pulse = useSnapshot(USAGE_PULSE_SNAPSHOT_KEY);

  return (
    <div className="page usage-page">
      <UsageHeader range={range} onRangeChange={setRange} live={pulse.status === "live"} />
      <PulseSection range={range} pulse={pulse} />
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
            // biome-ignore lint/a11y/useSemanticElements: custom-styled radio inside the parent role="radiogroup", mirroring RunView's layout toggle
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={w === range}
              className={`layout-toggle-btn${w === range ? " active" : ""}`}
              onClick={() => onRangeChange(w)}
            >
              {WINDOW_LABEL[w]}
            </button>
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
          <div className="empty-state">
            <div className="empty-state-title">No usage yet in this window</div>
            <div className="empty-state-body">
              Spend shows up here once chat, a workflow, or a rib reports its first turn.
            </div>
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
  const cacheReadRate =
    totals.inputTokens > 0 ? Math.round((totals.cacheReadTokens / totals.inputTokens) * 100) : 0;

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
          {cacheReadRate}%
        </div>
        <div className="usage-stat-label">Cache read rate</div>
        <div className="usage-stat-sub usage-mono">
          {formatTokens(totals.cacheReadTokens)} of {formatTokens(totals.inputTokens)} input
        </div>
      </div>
      <div className="usage-stat">
        <div className="usage-stat-value" data-tone={failureBurn.tokens > 0 ? "hot" : undefined}>
          {formatTokens(failureBurn.tokens)}
        </div>
        <div className="usage-stat-label">Failure burn</div>
        <div className="usage-stat-sub">
          {failureBurn.turns} errored / timed-out {failureBurn.turns === 1 ? "turn" : "turns"}
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
  const x = (i: number) => (i / (n - 1)) * (width - 10) + 4;
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

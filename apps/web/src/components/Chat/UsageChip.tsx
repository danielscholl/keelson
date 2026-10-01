// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import {
  contextFillLevel,
  contextPercent,
  formatTokens,
  hasSpend,
} from "../../lib/formatTokens.ts";

// Turns and cache reads count every billable turn, including one served
// entirely from cache; inputTokens/outputTokens stay the fresh ↑/↓ figures.
export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
}

interface UsageChipProps {
  // The most recent assistant turn's usage — its contextTokens/contextWindow
  // pair drives the fill gauge. Required: the caller mounts the chip only
  // once a turn has reported.
  latest: TokenUsage;
  // Session totals summed over every assistant turn that carried spend.
  totals: SessionUsageTotals;
  // Popover id this chip opens (UsagePopover). Same declarative
  // popoverTarget pattern as ModelChip / ToolsChip.
  popoverId: string;
}

// Composer chip: context-fill percentage when the provider reports a window
// (the load-bearing number — "how close is this conversation to the edge"),
// session ↑/↓ totals otherwise, or the cached total when every billed turn was
// served from cache. Detail lives in the popover. Renders nothing when there is
// neither a gauge nor a billed turn (a context-only report without a window)
// — never a fabricated "↑ 0 ↓ 0".
export function UsageChip({ latest, totals, popoverId }: UsageChipProps) {
  const pct = contextPercent(latest.contextTokens, latest.contextWindow);
  if (pct === null && totals.turns === 0) return null;
  const cacheOnly = !hasSpend(totals);
  const level = pct !== null ? contextFillLevel(pct) : "ok";
  const label =
    pct !== null
      ? `Context ${pct}% full (${formatTokens(latest.contextTokens ?? 0)} of ${formatTokens(latest.contextWindow ?? 0)} tokens). Click for details.`
      : cacheOnly
        ? `Session tokens: ${formatTokens(totals.cacheReadTokens)} served from cache. Click for details.`
        : `Session tokens: ${formatTokens(totals.inputTokens)} in, ${formatTokens(totals.outputTokens)} out. Click for details.`;
  return (
    <button
      type="button"
      className={`chat-usage-chip ${level}`}
      popoverTarget={popoverId}
      aria-label={label}
      title={label}
    >
      {pct !== null ? (
        <>
          <span className="chat-usage-chip-meter" aria-hidden="true">
            <span className="chat-usage-chip-meter-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="chat-usage-chip-value">{pct}%</span>
        </>
      ) : cacheOnly ? (
        <span className="chat-usage-chip-value">⟳ {formatTokens(totals.cacheReadTokens)}</span>
      ) : (
        <span className="chat-usage-chip-value">
          ↑ {formatTokens(totals.inputTokens)} ↓ {formatTokens(totals.outputTokens)}
        </span>
      )}
    </button>
  );
}

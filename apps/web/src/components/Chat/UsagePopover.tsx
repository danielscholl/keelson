// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import { useCallback, useEffect, useRef } from "react";
import { contextFillLevel, contextPercent, formatTokens } from "../../lib/formatTokens.ts";
import type { SessionUsageTotals } from "./UsageChip.tsx";

interface UsagePopoverProps {
  popoverId: string;
  latest?: TokenUsage | undefined;
  totals: SessionUsageTotals;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-popover-row">
      <span className="usage-popover-row-label">{label}</span>
      <span className="usage-popover-row-value">{value}</span>
    </div>
  );
}

// Breakdown behind the UsageChip. Three labeled groups keep the two distinct
// measures from blurring together: "Context" is fill (last request vs the
// model window), "Last turn" and "Session" are spend (per-turn and cumulative
// totals). Rows render only when the provider reported the number.
export function UsagePopover({ popoverId, latest, totals }: UsagePopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Anchor relative to the chip on open — same math as ToolsPopover, with a
  // smaller open-down threshold since this popover is a handful of rows.
  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const trigger = document.querySelector<HTMLElement>(`[popovertarget="${popoverId}"]`);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const margin = 6;
    const openDown = spaceBelow >= 160 || spaceBelow >= spaceAbove;
    if (openDown) {
      popoverEl.style.top = `${Math.round(rect.bottom + margin)}px`;
      popoverEl.style.bottom = "auto";
    } else {
      popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
      popoverEl.style.top = "auto";
    }
    popoverEl.style.left = `${Math.round(rect.left)}px`;
  }, [popoverId]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onToggle = (e: Event) => {
      const evt = e as ToggleEvent;
      if (evt.newState === "open") reposition();
    };
    popoverEl.addEventListener("toggle", onToggle);
    return () => popoverEl.removeEventListener("toggle", onToggle);
  }, [reposition]);

  const pct = contextPercent(latest?.contextTokens, latest?.contextWindow);

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="usage-popover"
      role="dialog"
      aria-label="Token usage"
    >
      {pct !== null && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">Context</div>
          <div className={`usage-popover-meter ${contextFillLevel(pct)}`} aria-hidden="true">
            <span className="usage-popover-meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <Row
            label="In window"
            value={`${formatTokens(latest?.contextTokens ?? 0)} of ${formatTokens(latest?.contextWindow ?? 0)} (${pct}%)`}
          />
        </section>
      )}
      {latest !== undefined && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">Last turn</div>
          <Row label="↑ Input" value={formatTokens(latest.inputTokens)} />
          <Row label="↓ Output" value={formatTokens(latest.outputTokens)} />
          {latest.cacheReadInputTokens !== undefined && (
            <Row label="Cache read" value={formatTokens(latest.cacheReadInputTokens)} />
          )}
          {latest.cacheCreationInputTokens !== undefined && (
            <Row label="Cache write" value={formatTokens(latest.cacheCreationInputTokens)} />
          )}
        </section>
      )}
      {totals.turns > 0 && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">Session</div>
          <Row label="↑ Input" value={formatTokens(totals.inputTokens)} />
          <Row label="↓ Output" value={formatTokens(totals.outputTokens)} />
          <Row label="Turns" value={String(totals.turns)} />
        </section>
      )}
    </div>
  );
}

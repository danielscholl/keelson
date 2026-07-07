// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  contextFillLevel,
  contextPercent,
  formatTokens,
  hasSpend,
} from "../../lib/formatTokens.ts";
import type { SessionUsageTotals } from "./UsageChip.tsx";

interface UsagePopoverProps {
  popoverId: string;
  // Required: mounted only once a turn has reported (same gate as UsageChip).
  latest: TokenUsage;
  totals: SessionUsageTotals;
}

interface UsagePopoverPanelProps {
  popoverId: string;
  ariaLabel?: string;
  children: ReactNode;
}

interface UsageBreakdownProps {
  usage: TokenUsage;
  spendTitle?: string;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-popover-row">
      <span className="usage-popover-row-label">{label}</span>
      <span className="usage-popover-row-value">{value}</span>
    </div>
  );
}

export function UsageBreakdown({ usage, spendTitle = "Last turn" }: UsageBreakdownProps) {
  const pct = contextPercent(usage.contextTokens, usage.contextWindow);
  const hasTurnSpend = hasSpend(usage);
  const hasCacheRead = usage.cacheReadInputTokens !== undefined;
  const hasCacheWrite = usage.cacheCreationInputTokens !== undefined;
  const spendRows = hasTurnSpend || hasCacheRead || hasCacheWrite;
  const cacheReadRow =
    usage.cacheReadInputTokens !== undefined ? (
      <Row label="Cache read" value={formatTokens(usage.cacheReadInputTokens)} />
    ) : null;
  const cacheWriteRow =
    usage.cacheCreationInputTokens !== undefined ? (
      <Row label="Cache write" value={formatTokens(usage.cacheCreationInputTokens)} />
    ) : null;

  return (
    <>
      {pct !== null && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">Context</div>
          <div className={`usage-popover-meter ${contextFillLevel(pct)}`} aria-hidden="true">
            <span className="usage-popover-meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <Row
            label="In window"
            value={`${formatTokens(usage.contextTokens ?? 0)} of ${formatTokens(
              usage.contextWindow ?? 0,
            )} (${pct}%)`}
          />
        </section>
      )}
      {spendRows && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">{spendTitle}</div>
          {hasTurnSpend && (
            <>
              <Row label="↑ Input" value={formatTokens(usage.inputTokens)} />
              <Row label="↓ Output" value={formatTokens(usage.outputTokens)} />
            </>
          )}
          {cacheReadRow}
          {cacheWriteRow}
        </section>
      )}
    </>
  );
}

export function UsagePopoverPanel({
  popoverId,
  ariaLabel = "Token usage",
  children,
}: UsagePopoverPanelProps) {
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

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onResize = () => {
      if (!popoverEl.matches(":popover-open")) return;
      reposition();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reposition]);

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="usage-popover"
      role="dialog"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export function UsagePopover({ popoverId, latest, totals }: UsagePopoverProps) {
  return (
    <UsagePopoverPanel popoverId={popoverId}>
      <UsageBreakdown usage={latest} />
      {totals.turns > 0 && (
        <section className="usage-popover-section">
          <div className="usage-popover-section-title">Session</div>
          <Row label="↑ Input" value={formatTokens(totals.inputTokens)} />
          <Row label="↓ Output" value={formatTokens(totals.outputTokens)} />
          <Row label="Turns" value={String(totals.turns)} />
        </section>
      )}
    </UsagePopoverPanel>
  );
}

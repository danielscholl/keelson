// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useEffect, useRef } from "react";
import type { ReasoningEffortLevel } from "@keelson/shared";

// All four tiers in the order users expect them surfaced. When the active
// model declares a narrowed `supportedReasoningEfforts`, the popover filters
// against this canonical order so a model offering ["high","xhigh"] still
// renders "HIGH" above "XHIGH".
const ALL_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

interface ReasoningEffortPopoverProps {
  // Element id the chip's popoverTarget attribute references. Anchoring is
  // computed at open-time via getBoundingClientRect on the trigger — same
  // pattern as ModelPickerPopover.
  popoverId: string;
  // Currently-selected tier. Highlighted with `.active`.
  activeLevel: ReasoningEffortLevel;
  // Optional narrowed set surfaced by the SDK per-model. When undefined the
  // popover renders all four tiers; when present, only the listed levels
  // appear (preserving the canonical render order).
  supportedLevels?: readonly ReasoningEffortLevel[];
  onSelect: (level: ReasoningEffortLevel) => void;
}

export function ReasoningEffortPopover({
  popoverId,
  activeLevel,
  supportedLevels,
  onSelect,
}: ReasoningEffortPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Anchor the popover relative to the chip on open. Mirrors the math in
  // ModelPickerPopover — the chip lives in the composer at the bottom of the
  // layout, so the upward path is the common case.
  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const trigger = document.querySelector<HTMLElement>(
      `[popovertarget="${popoverId}"]`,
    );
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const margin = 6;
    // The popover is short (4 rows max). Use 140 as the "I'd rather fit below
    // than above" threshold — covers the typical case where the chip is near
    // the viewport bottom but not pinned to it.
    const openDown = spaceBelow >= 140 || spaceBelow >= spaceAbove;
    if (openDown) {
      popoverEl.style.top = `${Math.round(rect.bottom + margin)}px`;
      popoverEl.style.bottom = "auto";
      popoverEl.style.maxHeight = `${Math.max(
        140,
        Math.round(spaceBelow - margin * 2),
      )}px`;
    } else {
      popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
      popoverEl.style.top = "auto";
      popoverEl.style.maxHeight = `${Math.max(
        140,
        Math.round(spaceAbove - margin * 2),
      )}px`;
    }
    popoverEl.style.left = `${Math.round(rect.left)}px`;
    popoverEl.style.minWidth = `${Math.max(160, Math.round(rect.width))}px`;
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

  const allowed: readonly ReasoningEffortLevel[] = supportedLevels?.length
    ? ALL_LEVELS.filter((l) => supportedLevels.includes(l))
    : ALL_LEVELS;

  const handlePick = useCallback(
    (level: ReasoningEffortLevel) => {
      onSelect(level);
      popoverRef.current?.hidePopover();
    },
    [onSelect],
  );

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="reasoning-effort-popover"
      aria-label="Pick a reasoning effort tier"
    >
      <div className="reasoning-effort-popover-body">
        {allowed.map((level) => {
          const isActive = level === activeLevel;
          return (
            <button
              key={level}
              type="button"
              className={`reasoning-effort-popover-row${
                isActive ? " active" : ""
              }`}
              onClick={() => handlePick(level)}
              // Native close-on-click — the browser hides the popover after
              // our onClick handler runs.
              popoverTarget={popoverId}
              popoverTargetAction="hide"
              aria-pressed={isActive}
            >
              <span className="reasoning-effort-popover-row-label">
                {level.toUpperCase()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

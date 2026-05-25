// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useEffect, useRef } from "react";
import type { RegisteredToolInfo } from "@keelson/shared";
import { displayToolName } from "./toolNames.ts";

interface ToolsPopoverProps {
  // Element id the chip's popoverTarget attribute references. Anchoring is
  // computed at open-time via getBoundingClientRect on the trigger — same
  // pattern as ModelPickerPopover / ReasoningEffortPopover.
  popoverId: string;
  // Tools surfaced by GET /api/tools. The popover groups by inferred family
  // and renders read-only rows; v1 doesn't act on click.
  tools: RegisteredToolInfo[];
}

function familyLabel(family: string): string {
  if (family === "other") return "Built-in";
  return family.charAt(0).toUpperCase() + family.slice(1);
}

// Trim the description to a one-line preview for the popover row. Tool
// descriptions in the S8/S10 era can run multiple paragraphs (lead +
// exemplars + anti-example); the preview takes the first sentence — or the
// first 120 chars if no sentence terminator lands within range — and folds
// internal whitespace to keep the row a fixed height. Full text still rides
// in the row's `title` attribute for hover discovery.
function previewDescription(description: string): string {
  const collapsed = description.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "";
  const firstStop = collapsed.search(/[.!?](\s|$)/);
  const cutoff = firstStop > 0 && firstStop < 160 ? firstStop : 120;
  if (collapsed.length <= cutoff) return collapsed;
  return `${collapsed.slice(0, cutoff).trimEnd()}…`;
}

export function ToolsPopover({ popoverId, tools }: ToolsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Anchor the popover relative to the chip on open. Mirrors the math in
  // ModelPickerPopover — the chip lives in the composer at the bottom of the
  // layout, so the upward path is the common case. Threshold 200 chosen
  // between ReasoningEffortPopover's 140 (4 short rows) and
  // ModelPickerPopover's 240 (long list with search) because the tools list
  // is typically 4–8 rows.
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
    const openDown = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    if (openDown) {
      popoverEl.style.top = `${Math.round(rect.bottom + margin)}px`;
      popoverEl.style.bottom = "auto";
      popoverEl.style.maxHeight = `${Math.max(
        200,
        Math.round(spaceBelow - margin * 2),
      )}px`;
    } else {
      popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
      popoverEl.style.top = "auto";
      popoverEl.style.maxHeight = `${Math.max(
        200,
        Math.round(spaceAbove - margin * 2),
      )}px`;
    }
    popoverEl.style.left = `${Math.round(rect.left)}px`;
    popoverEl.style.minWidth = `${Math.max(320, Math.round(rect.width))}px`;
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

  const grouped = new Map<string, RegisteredToolInfo[]>();
  for (const tool of tools) {
    const list = grouped.get(tool.family);
    if (list) list.push(tool);
    else grouped.set(tool.family, [tool]);
  }
  // Sort families alphabetically with "other" last so unprefixed tools
  // group at the bottom of the popover.
  const orderedFamilies = [...grouped.keys()].sort((a, b) => {
    if (a === "other" && b !== "other") return 1;
    if (b === "other" && a !== "other") return -1;
    return a.localeCompare(b);
  });

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="tools-popover"
      aria-label="Available tools"
    >
      <div className="tools-popover-body">
        {orderedFamilies.map((family) => {
          const items = grouped.get(family) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={family} className="tools-popover-section">
              <div className="tools-popover-section-title">
                <span className="tools-popover-section-label">
                  {familyLabel(family)}
                </span>
              </div>
              <div className="tools-popover-section-rows">
                {items.map((tool) => (
                  <div
                    key={tool.name}
                    className="tools-popover-row"
                    title={tool.description}
                  >
                    <span className="tools-popover-row-name">
                      {displayToolName(tool.name)}
                    </span>
                    <span className="tools-popover-row-desc">
                      {previewDescription(tool.description)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {tools.length === 0 && (
          <div className="tools-popover-empty">No tools registered.</div>
        )}
      </div>
    </div>
  );
}

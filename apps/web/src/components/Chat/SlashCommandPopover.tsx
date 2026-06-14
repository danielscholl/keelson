// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useEffect, useRef } from "react";
import type { SlashCommand, SlashCommandFamily } from "../../lib/slashCommands.ts";

interface SlashCommandPopoverProps {
  popoverId: string;
  // Selector for the element to anchor against. Defaults to `.chat-composer`
  // (the textarea + chip row container in the chat view).
  anchorSelector?: string;
  // `list` shows filtered command rows for picking. `help` shows a single
  // usage strip for the command the user has already committed to (typed
  // `/{name} ` with a trailing space). `args` shows argument suggestions
  // (workflow names for `/workflow run`, or a rib command's completions).
  mode: "list" | "help" | "args";
  // Filtered candidate list when mode is `list`. Ignored otherwise.
  items: readonly SlashCommand[];
  // Argument suggestions when mode is `args`. Ignored otherwise.
  argItems?: readonly { name: string; description?: string }[];
  // Which command's args are showing — drives the row tag + empty-state copy.
  argFamily?: SlashCommandFamily;
  // Index of the currently highlighted row (arrow-key controlled by the
  // composer's textarea — the popover is read-only for keyboard input).
  selectedIndex: number;
  // The committed command whose usage strip to render in help mode.
  helpCommand: SlashCommand | null;
  // Fired when the user clicks a command row. Should fill the input with
  // `/{name} ` and close the popover.
  onSelect: (cmd: SlashCommand) => void;
  // Fired when the user clicks a workflow-name row in `args` mode.
  onSelectArg?: (name: string) => void;
}

function familyTag(family: SlashCommand["family"]): string {
  return family.toUpperCase();
}

export function SlashCommandPopover({
  popoverId,
  anchorSelector = ".chat-composer",
  mode,
  items,
  argItems = [],
  argFamily = "workflow",
  selectedIndex,
  helpCommand,
  onSelect,
  onSelectArg,
}: SlashCommandPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const anchor = document.querySelector<HTMLElement>(anchorSelector);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 6;
    const viewportH = window.innerHeight;
    popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
    popoverEl.style.top = "auto";
    popoverEl.style.left = `${Math.round(rect.left)}px`;
    popoverEl.style.minWidth = `${Math.max(360, Math.round(rect.width))}px`;
    popoverEl.style.maxWidth = `${Math.round(rect.width)}px`;
    popoverEl.style.maxHeight = `${Math.max(160, Math.round(rect.top - margin * 2))}px`;
  }, [anchorSelector]);

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
      popover="manual"
      className="slash-popover"
      data-mode={mode}
      role="listbox"
      aria-label="Slash commands"
    >
      {mode === "list" && items.length > 0 && (
        <div className="slash-popover-body">
          {items.map((cmd, idx) => (
            <button
              key={cmd.name}
              type="button"
              className="slash-popover-row"
              role="option"
              aria-selected={idx === selectedIndex}
              onMouseDown={(e) => {
                // `mousedown` not `click` — we want to fire before the textarea
                // blurs. The textarea blur would otherwise race with the
                // popover close and re-trigger focus on the wrong frame.
                e.preventDefault();
                onSelect(cmd);
              }}
            >
              <span className="slash-popover-row-name">/{cmd.name}</span>
              <span className="slash-popover-row-tag">{familyTag(cmd.family)}</span>
              <span className="slash-popover-row-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      {mode === "list" && items.length === 0 && (
        <div className="slash-popover-empty">No matching commands.</div>
      )}
      {mode === "args" && argItems.length > 0 && (
        <div className="slash-popover-body">
          {argItems.map((item, idx) => (
            <button
              key={item.name}
              type="button"
              className="slash-popover-row"
              role="option"
              aria-selected={idx === selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectArg?.(item.name);
              }}
            >
              <span className="slash-popover-row-name">{item.name}</span>
              <span className="slash-popover-row-tag">{familyTag(argFamily)}</span>
              {item.description !== undefined && (
                <span className="slash-popover-row-desc">{item.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {mode === "args" && argItems.length === 0 && (
        <div className="slash-popover-empty">
          {argFamily === "workflow" ? "No matching workflows." : "No matching options."}
        </div>
      )}
      {mode === "help" && helpCommand !== null && (
        <div className="slash-popover-help">
          <span className="slash-popover-help-name">/{helpCommand.name}</span>
          <span className="slash-popover-help-usage">{helpCommand.usage}</span>
        </div>
      )}
    </div>
  );
}

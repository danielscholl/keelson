// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ReasoningEffortLevel } from "@keelson/shared";

import { ChevronDownIcon, LightbulbIcon } from "./icons.tsx";

const EFFORT_LABEL: Record<ReasoningEffortLevel, string> = {
  none: "No",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

interface ReasoningEffortChipProps {
  // Current per-turn effort tier. Sticky-within-conversation — see Chat.tsx.
  level: ReasoningEffortLevel;
  // Popover id this chip opens. The browser handles open/close declaratively
  // via popoverTarget — mirrors ModelChip's pattern, no JS for show/hide.
  popoverId: string;
  // Disabled while streaming so a tier swap mid-turn can't race the active
  // request. Matches ModelChip / ThinkingChip behavior.
  disabled?: boolean;
}

export function ReasoningEffortChip({ level, popoverId, disabled }: ReasoningEffortChipProps) {
  const label = `${EFFORT_LABEL[level]} effort`;
  return (
    <button
      type="button"
      className="chat-reasoning-effort-chip"
      popoverTarget={popoverId}
      disabled={disabled}
      aria-label={`${label}. Click to change reasoning effort.`}
      title={`${label} (click to change)`}
    >
      <LightbulbIcon />
      <span className="chat-reasoning-effort-chip-label">{label}</span>
      <span className="chat-reasoning-effort-chip-caret" aria-hidden="true">
        <ChevronDownIcon />
      </span>
    </button>
  );
}

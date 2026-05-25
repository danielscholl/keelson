// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { LightbulbIcon } from "./icons.tsx";

interface ThinkingChipProps {
  // True = next turn requests thinking; false = next turn opts out.
  enabled: boolean;
  onToggle: () => void;
  // Disabled while streaming — toggling mid-turn would have no effect on
  // the in-flight request and the visual flip would mislead the user.
  disabled?: boolean;
}

export function ThinkingChip({
  enabled,
  onToggle,
  disabled,
}: ThinkingChipProps) {
  return (
    <button
      type="button"
      className="chat-thinking-chip"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={enabled}
      aria-label={
        enabled
          ? "Thinking enabled for next turn. Click to disable."
          : "Thinking disabled for next turn. Click to enable."
      }
      title={enabled ? "Thinking on (click to disable)" : "Thinking off (click to enable)"}
    >
      <LightbulbIcon />
      <span className="chat-thinking-chip-label">Thinking</span>
    </button>
  );
}

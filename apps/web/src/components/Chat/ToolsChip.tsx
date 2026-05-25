// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { WrenchIcon } from "./icons.tsx";

interface ToolsChipProps {
  // Count of registered tools surfaced by GET /api/tools. Chat.tsx gates the
  // chip's render on count > 0 so the chip never shows an empty popover, but
  // the count itself is part of the chip's affordance — users see how much
  // surface area the agent has without opening the popover.
  count: number;
  // Popover id this chip opens. Mirrors ModelChip's pattern — the browser
  // handles open/close declaratively via popoverTarget, no JS for show/hide.
  popoverId: string;
  // Disabled while streaming so the popover can't open mid-turn and confuse
  // the user about which tools were available for the in-flight request.
  // Matches ModelChip / ReasoningEffortChip behavior.
  disabled?: boolean;
}

export function ToolsChip({ count, popoverId, disabled }: ToolsChipProps) {
  return (
    <button
      type="button"
      className="chat-tools-chip"
      popoverTarget={popoverId}
      disabled={disabled}
      aria-label={`Tools: ${count} available. Click to view.`}
      title={`${count} tools available (click to view)`}
    >
      <WrenchIcon />
      <span className="chat-tools-chip-count">{count}</span>
      <span className="chat-tools-chip-caret" aria-hidden="true">▾</span>
    </button>
  );
}

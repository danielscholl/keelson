// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

interface ModelChipProps {
  // Display label for the active provider (e.g., "GitHub Copilot",
  // "Claude"). Drives the chip's prefix so the chip is self-descriptive
  // without needing to glance at the toolbar.
  providerLabel: string;
  // Model id rendered as the chip's bold center. Empty string shows
  // "(default)" so a fresh chat still has something to click.
  modelId: string;
  // Optional friendly name from ModelInfo (e.g. "Claude Opus 4.7" instead
  // of "claude-opus-4-7"). Falls back to modelId when missing.
  modelDisplayName?: string;
  // Popover id this chip controls. The browser handles open/close
  // declaratively via the popoverTarget attribute — no JS needed for
  // basic show/hide.
  popoverId: string;
  // Disabled while streaming so a model swap mid-turn can't race the
  // active request. Matches the prior <select> behavior.
  disabled?: boolean;
}

export function ModelChip({
  providerLabel,
  modelId,
  modelDisplayName,
  popoverId,
  disabled,
}: ModelChipProps) {
  const display = modelDisplayName || modelId || "(default)";
  return (
    <button
      type="button"
      className="chat-model-chip"
      popoverTarget={popoverId}
      disabled={disabled}
      aria-label={`Model: ${display}. Change model.`}
      title="Change model"
    >
      <span className="chat-model-chip-provider">{providerLabel}</span>
      <span className="chat-model-chip-sep" aria-hidden="true">·</span>
      <span className="chat-model-chip-name">{display}</span>
      <span className="chat-model-chip-caret" aria-hidden="true">▾</span>
    </button>
  );
}

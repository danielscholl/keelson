// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { ShieldIcon } from "./icons.tsx";

interface SandboxChipProps {
  // Undefined while the server's default is unknown and nothing was chosen.
  enabled: boolean | undefined;
  onToggle: () => void;
  // KEELSON_SANDBOX=required holds the sandbox on; the chip cannot turn it off.
  locked?: boolean;
  // The provider cannot sandbox its tools, so a sandboxed turn fails closed.
  unsupported?: boolean;
  disabled?: boolean;
}

export function SandboxChip({
  enabled,
  onToggle,
  locked,
  unsupported,
  disabled,
}: SandboxChipProps) {
  const warn = enabled && unsupported === true;
  const label = locked
    ? "Sandbox required by KEELSON_SANDBOX=required."
    : enabled === undefined
      ? "Sandbox follows the server's default, which could not be read. Click to turn it on."
      : warn
        ? "Sandbox on, but this provider cannot sandbox its tools, so turns fail closed. Click to turn the sandbox off."
        : enabled
          ? "Sandbox on for this conversation. Click to turn it off."
          : "Sandbox off for this conversation. Click to turn it on.";
  return (
    <button
      type="button"
      className="chat-sandbox-chip"
      onClick={onToggle}
      disabled={disabled === true || locked === true}
      aria-pressed={enabled === undefined ? "mixed" : enabled}
      aria-label={label}
      title={label}
      {...(locked ? { "data-locked": "true" } : {})}
      {...(warn ? { "data-unsupported": "true" } : {})}
    >
      <ShieldIcon />
      <span className="chat-sandbox-chip-label">{locked ? "Sandbox (required)" : "Sandbox"}</span>
    </button>
  );
}

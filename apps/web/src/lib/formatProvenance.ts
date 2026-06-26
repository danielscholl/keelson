// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Joins the effective provider id + model a node ran on into one chip label
// ("copilot · auto"). Renders provider-only or model-only too; null when
// neither is known. Shared by the per-node trace chip and the run-level chip.
export function formatProviderModel(provider?: string, model?: string): string | null {
  if (provider && model) return `${provider} · ${model}`;
  return provider || model || null;
}

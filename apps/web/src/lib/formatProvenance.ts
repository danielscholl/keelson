// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Joins the effective provider id + model a node ran on into one chip label
// ("copilot · auto"). `declaredModel` backfills the model when the runtime
// didn't report one (e.g. a provider whose model is resolved server-side and
// only surfaced as the workflow's declared `model:`), so a node doesn't regress
// from "copilot · auto" to bare "copilot". Renders provider-only or model-only
// too; null when nothing is known. Shared by the trace chip and the run chip.
export function formatProviderModel(
  provider?: string,
  model?: string,
  declaredModel?: string,
): string | null {
  const m = model ?? declaredModel;
  if (provider && m) return `${provider} · ${m}`;
  return provider || m || null;
}

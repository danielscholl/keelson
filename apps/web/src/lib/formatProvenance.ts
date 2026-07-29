// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Joins the effective provider id + model + reasoning tier a node ran on into
// one chip label ("copilot · auto · xhigh"). `declaredModel` backfills the model
// when the runtime didn't report one (e.g. a provider whose model is resolved
// server-side and only surfaced as the workflow's declared `model:`), so a node
// doesn't regress from "copilot · auto" to bare "copilot". Any subset renders;
// null when nothing is known. Shared by the trace chip and the run chip.
//
// Effort has no declared-value backfill on purpose: a node that declares none
// runs at whatever per-model default the provider picks, and no provider reports
// that back — showing a tier we never sent would be a claim we can't support.
export function formatProviderModel(
  provider?: string,
  model?: string,
  declaredModel?: string,
  effort?: string,
): string | null {
  const segments = [provider, model ?? declaredModel, effort].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return segments.length > 0 ? segments.join(" · ") : null;
}

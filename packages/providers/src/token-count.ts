// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Defensive token-count read off structurally-typed SDK fields. Shared by the
// provider adapters so their sanitation policy can't drift.
export function toTokenCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

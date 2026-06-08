// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Small, dependency-free helpers shared across ribs. Kept generic and
// domain-free so the base can own one canonical copy (see canvas.ts:expectView
// for the canvas-coupled sibling).

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Coercers for untrusted onAction payloads (`Record<string, unknown>`): callers
// pass `payload.field` and get a typed value or a safe empty default, never a
// throw. asNonEmptyString trims and treats whitespace-only as absent.
export function asNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

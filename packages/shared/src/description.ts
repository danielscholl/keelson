// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Splits a workflow `description:` body into the structured metadata sections
// (`Use when:`, `Triggers:`, `Does:`, `NOT for:`) when the convention is used,
// and falls back to a single `body` when it isn't. Starter workflows that ship
// without section headers render as `{ body: <full text> }`. Consumed by the
// SPA workflow cards and by the server's `workflow_list` chat tool — lives here
// (not in @keelson/workflows) because the browser bundle must not pull in the
// node-only executor package.

export interface ParsedWorkflowDescription {
  // Plain body — populated only when no section headers are recognized.
  body?: string;
  useWhen?: string;
  triggers?: string;
  does?: string;
  notFor?: string;
}

// Recognized section labels. Case-insensitive, must appear at the start of
// a line, must be followed by a colon. Order is the canonical render order.
const SECTION_LABELS: ReadonlyArray<{ key: keyof ParsedWorkflowDescription; pattern: RegExp }> = [
  { key: "useWhen", pattern: /^use\s+when$/i },
  { key: "triggers", pattern: /^triggers$/i },
  { key: "does", pattern: /^does$/i },
  { key: "notFor", pattern: /^not\s+for$/i },
];

function matchLabel(line: string): keyof ParsedWorkflowDescription | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const label = line.slice(0, idx).trim();
  for (const { key, pattern } of SECTION_LABELS) {
    if (pattern.test(label)) return key;
  }
  return null;
}

export function parseWorkflowDescription(
  raw: string | undefined | null,
): ParsedWorkflowDescription {
  const text = (raw ?? "").trim();
  if (!text) return {};

  const lines = text.split(/\r?\n/);
  const sections: Partial<Record<keyof ParsedWorkflowDescription, string[]>> = {};
  let current: keyof ParsedWorkflowDescription | null = null;
  const pre: string[] = [];

  for (const line of lines) {
    const label = matchLabel(line);
    if (label) {
      current = label;
      const after = line.slice(line.indexOf(":") + 1).trim();
      sections[current] = after ? [after] : [];
      continue;
    }
    if (current) {
      sections[current]!.push(line);
    } else {
      pre.push(line);
    }
  }

  // If no section headers fired, return the whole text as body. This is
  // the existing-starter-workflow fallback path.
  if (!current) {
    return { body: text };
  }

  const out: ParsedWorkflowDescription = {};
  // Any pre-section text (a leading paragraph before the first label)
  // still surfaces as `body` so authors can pair a prose intro with
  // structured sections.
  const preText = pre.join("\n").trim();
  if (preText) out.body = preText;

  for (const { key } of SECTION_LABELS) {
    const collected = sections[key];
    if (!collected) continue;
    const joined = collected.join("\n").trim();
    if (joined) out[key] = joined;
  }
  return out;
}

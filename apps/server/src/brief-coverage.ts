// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Brief, briefSchema } from "@keelson/shared";
import { z } from "zod";

export interface CoverageRow {
  criterion: string;
  covered: boolean;
  step: string | null;
}

const coverageRowSchema = z
  .object({
    criterion: z.string(),
    covered: z.boolean(),
    step: z.string().nullable(),
  })
  .strict()
  .refine((row) => (row.covered ? row.step !== null && row.step.length > 0 : row.step === null), {
    message: "covered rows must name a non-empty step; missing rows must use null",
    path: ["step"],
  });

const coverageArtifactSchema = z
  .object({
    coverage: z.array(coverageRowSchema),
  })
  .strict();

export function parseBriefArtifact(raw: string): Brief | null {
  try {
    const parsed = JSON.parse(raw);
    const result = briefSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseCoverageArtifact(raw: string): CoverageRow[] | null {
  try {
    const parsed = JSON.parse(raw);
    const result = coverageArtifactSchema.safeParse(parsed);
    return result.success ? result.data.coverage : null;
  } catch {
    return null;
  }
}

// Reconcile the model's coverage rows against the brief's criteria positionally:
// row[i] must match criteria[i] by exact text, so an omitted or reordered row lands
// on the wrong criterion and is flagged MISSING, and a duplicate criterion needs its
// own row rather than being satisfied by one. The model judges coverage; the server
// guarantees completeness so a dropped criterion can't silently hide.
export function reconcileCoverage(criteria: string[], rows: CoverageRow[]): CoverageRow[] {
  return criteria.map((criterion, i) => {
    const row = rows[i];
    return row && row.criterion === criterion && row.covered && row.step !== null
      ? { criterion, covered: true, step: row.step }
      : { criterion, covered: false, step: null };
  });
}

// Criterion/step come from untrusted issue and model content. Collapse any CR/LF
// (and runs of whitespace) to a single space so a value can't inject extra
// checklist rows or headings into the rendered approval callout.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function renderCoverageChecklist(rows: CoverageRow[]): string {
  if (rows.length === 0) return "";
  const rendered = rows.map((row) =>
    row.covered && row.step !== null
      ? `- [x] ${oneLine(row.criterion)} -> ${oneLine(row.step)}`
      : `- [ ] ${oneLine(row.criterion)} -> **MISSING**`,
  );
  return `## Criteria coverage\n\n${rendered.join("\n")}`;
}

async function readArtifact(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function loadBriefAndCoverage(opts: {
  artifactsDir: string | undefined;
}): Promise<{ brief: Brief | null; checklist: string }> {
  if (opts.artifactsDir === undefined) return { brief: null, checklist: "" };

  const briefRaw = await readArtifact(join(opts.artifactsDir, "brief.json"));
  if (briefRaw === null) return { brief: null, checklist: "" };

  const brief = parseBriefArtifact(briefRaw);
  if (brief === null) return { brief: null, checklist: "" };
  if (brief.criteria.length === 0) return { brief, checklist: "" };

  const coverageRaw = await readArtifact(join(opts.artifactsDir, "coverage.json"));
  const rows = coverageRaw !== null ? parseCoverageArtifact(coverageRaw) : null;
  // Reconcile against the brief's criteria so absent / malformed / partial coverage
  // still renders every criterion (MISSING where unproven) — fail-visible, never a
  // silent omission of the criteria this gate exists to surface.
  const reconciled = reconcileCoverage(brief.criteria, rows ?? []);
  return { brief, checklist: renderCoverageChecklist(reconciled) };
}

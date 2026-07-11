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
  .refine((row) => (row.covered ? row.step !== null : row.step === null), {
    message: "covered rows must name a step; missing rows must use null",
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

export function renderCoverageChecklist(rows: CoverageRow[]): string {
  if (rows.length === 0) return "";
  const rendered = rows.map((row) =>
    row.covered && row.step !== null
      ? `- [x] ${row.criterion} -> ${row.step}`
      : `- [ ] ${row.criterion} -> **MISSING**`,
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
  if (coverageRaw === null) return { brief, checklist: "" };

  const rows = parseCoverageArtifact(coverageRaw);
  return { brief, checklist: rows !== null ? renderCoverageChecklist(rows) : "" };
}

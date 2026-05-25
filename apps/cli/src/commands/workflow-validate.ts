// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseWorkflow } from "@keelson/workflows";

import { EXIT_BAD_ARGS, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { emit } from "../output.ts";
import { defaultWorkflowsDir } from "../paths.ts";

export interface WorkflowValidateOptions {
  json: boolean;
  dir?: string;
}

interface ValidationRow {
  filename: string;
  ok: boolean;
  warnings: { kind: string; message: string }[];
  error: string | null;
}

function listYaml(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .map((entry) => join(dir, entry))
      .filter((p) => statSync(p).isFile())
      .sort();
  } catch {
    return [];
  }
}

// Match a file whose workflow `name` field is `target`. If the file parses
// successfully, use the resolved name. If the file fails schema validation
// but its raw YAML names itself the same thing (toplevel `name: foo`),
// still return it — the operator asked to validate `foo`, and the right
// answer is to surface foo's validation error rather than "not found",
// which would hide the very failure they were trying to diagnose.
function findByName(dir: string, target: string): string | null {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameLine = new RegExp(`^name:\\s*['\"]?${escaped}['\"]?\\s*$`, "m");
  for (const filename of listYaml(dir)) {
    let content: string;
    try {
      content = readFileSync(filename, "utf-8");
    } catch {
      continue;
    }
    const result = parseWorkflow(content, filename);
    if (result.workflow?.name === target) return filename;
    if (!result.workflow && nameLine.test(content)) return filename;
  }
  return null;
}

export async function runWorkflowValidate(
  name: string | undefined,
  opts: WorkflowValidateOptions,
): Promise<never> {
  const dir = opts.dir ?? defaultWorkflowsDir();
  const files = name ? [findByName(dir, name)].filter((f): f is string => f !== null) : listYaml(dir);

  if (name && files.length === 0) {
    emit(
      { error: `no workflow named '${name}' under ${dir}`, code: "WORKFLOW_NOT_FOUND" },
      { json: opts.json },
    );
    process.exit(EXIT_NOT_FOUND);
  }

  const rows: ValidationRow[] = [];
  let failed = 0;
  for (const filename of files) {
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    const ok = result.error === null;
    if (!ok) failed += 1;
    rows.push({
      filename,
      ok,
      warnings: result.warnings.map((w) => ({ kind: w.kind, message: w.message })),
      error: result.error?.error ?? null,
    });
  }

  emit({ data: { results: rows, failed, total: rows.length } }, { json: opts.json });
  process.exit(failed === 0 ? EXIT_OK : EXIT_BAD_ARGS);
}

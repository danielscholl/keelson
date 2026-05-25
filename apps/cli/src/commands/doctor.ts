// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { runAuthCheck, type AuthDeps } from "../checks/auth.ts";
import { runDbCheck, type DbDeps } from "../checks/db.ts";
import { runServerCheck, type ServerDeps } from "../checks/server.ts";
import { runToolchainCheck, type ToolchainDeps } from "../checks/toolchain.ts";
import {
  tally,
  type CategoryResult,
  type DoctorReport,
} from "../checks/types.ts";
import {
  runWorkflowsCheck,
  type WorkflowsDeps,
} from "../checks/workflows.ts";
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { emit } from "../output.ts";

export interface DoctorDeps {
  toolchain?: ToolchainDeps;
  server?: ServerDeps;
  db?: DbDeps;
  auth?: AuthDeps;
  workflows?: WorkflowsDeps;
}

export interface DoctorOptions {
  json: boolean;
  strict: boolean;
  deps?: DoctorDeps;
}

export async function buildDoctorReport(
  strict: boolean,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const categories: CategoryResult[] = await Promise.all([
    runToolchainCheck(deps.toolchain),
    runServerCheck(deps.server),
    runDbCheck(deps.db),
    runAuthCheck(deps.auth),
    runWorkflowsCheck(deps.workflows),
  ]);
  return { categories, summary: tally(categories), strict };
}

export function exitCodeFor(report: DoctorReport): number {
  if (report.summary.fail > 0) return EXIT_FAIL;
  if (report.strict && report.summary.warn > 0) return EXIT_FAIL;
  return EXIT_OK;
}

export async function runDoctor(opts: DoctorOptions): Promise<never> {
  const report = await buildDoctorReport(opts.strict, opts.deps);
  emit({ data: report }, { json: opts.json });
  process.exit(exitCodeFor(report));
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type DiscoveryResult,
  type DiscoveryRoot,
  discoverWorkflows as defaultDiscoverWorkflows,
} from "@keelson/workflows";

import { defaultWorkflowsDir } from "../paths.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

export type Discoverer = (roots: readonly DiscoveryRoot[]) => DiscoveryResult;

export interface WorkflowsDeps {
  discoverWorkflows?: Discoverer;
  workflowsDir?: string;
}

export async function runWorkflowsCheck(deps: WorkflowsDeps = {}): Promise<CategoryResult> {
  const dir = deps.workflowsDir ?? defaultWorkflowsDir();
  const discover = deps.discoverWorkflows ?? defaultDiscoverWorkflows;
  const result = discover([{ dir, source: "global" }]);

  const checks: CheckResult[] = [];

  checks.push({
    name: "discovery",
    status: "ok",
    detail: `${result.workflows.length} workflow(s) under ${dir}`,
  });

  if (result.errors.length === 0) {
    checks.push({
      name: "parse",
      status: "ok",
      detail: "all workflows parse cleanly",
    });
  } else {
    for (const err of result.errors) {
      checks.push({
        name: err.filename,
        status: "warn",
        detail: err.error,
        hint: "run `keelson workflow validate <name>` for the full diagnostic",
      });
    }
  }

  return { category: "workflows", checks };
}

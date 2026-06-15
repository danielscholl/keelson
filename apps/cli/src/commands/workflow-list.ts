// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { discoverWorkflows } from "@keelson/workflows";

import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { emit } from "../output.ts";
import { workflowDiscoveryRoots } from "../paths.ts";

export interface WorkflowListOptions {
  json: boolean;
  dir?: string;
}

export interface WorkflowListEntry {
  name: string;
  description: string;
  nodeCount: number;
  path: string;
  source: string;
}

export async function runWorkflowList(opts: WorkflowListOptions): Promise<never> {
  const roots = opts.dir
    ? [{ dir: opts.dir, source: "global" as const }]
    : workflowDiscoveryRoots();
  const result = discoverWorkflows(roots);

  if (result.errors.length > 0 && result.workflows.length === 0) {
    emit(
      {
        error: `failed to discover workflows: ${result.errors.map((e) => e.error).join("; ")}`,
        code: "DISCOVERY_FAILED",
      },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }

  const entries: WorkflowListEntry[] = result.workflows.map((w) => ({
    name: w.workflow.name,
    description: w.workflow.description ?? "",
    nodeCount: w.workflow.nodes.length,
    path: w.path,
    source: w.source,
  }));

  emit({ data: { workflows: entries, errors: result.errors } }, { json: opts.json });
  process.exit(EXIT_OK);
}

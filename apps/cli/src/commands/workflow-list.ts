// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { discoverWorkflows, type WorkflowWithSource } from "@keelson/workflows";

import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { isServerDownError, listWorkflows } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { workflowDiscoveryRoots } from "../paths.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowListOptions {
  json: boolean;
  dir?: string;
}

export interface WorkflowListEntry {
  name: string;
  description: string;
  nodeCount: number;
  path?: string;
  source: string;
}

function toLocalEntries(workflows: readonly WorkflowWithSource[]): WorkflowListEntry[] {
  return workflows.map((w) => ({
    name: w.workflow.name,
    description: w.workflow.description ?? "",
    nodeCount: w.workflow.nodes.length,
    path: w.path,
    source: w.source,
  }));
}

function toServerEntries(
  workflows: readonly {
    name: string;
    description: string;
    nodeCount: number;
    source?: { kind: string };
  }[],
): WorkflowListEntry[] {
  return workflows.map((w) => ({
    name: w.name,
    description: w.description,
    nodeCount: w.nodeCount,
    source: w.source?.kind ?? "server",
  }));
}

export async function runWorkflowList(opts: WorkflowListOptions): Promise<never> {
  const roots = opts.dir
    ? [{ dir: opts.dir, source: "global" as const }]
    : workflowDiscoveryRoots();

  if (!opts.dir) {
    const server = await probeServer();
    if (server) {
      try {
        const response = await listWorkflows(server.baseUrl);
        emit(
          { data: { workflows: toServerEntries(response.workflows), errors: [] } },
          { json: opts.json },
        );
        process.exit(EXIT_OK);
      } catch (err) {
        if (!isServerDownError(err)) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ error: message, code: "WORKFLOW_LIST_FAILED" }, { json: opts.json });
          process.exit(EXIT_FAIL);
        }
      }
    }
  }

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

  const entries = toLocalEntries(result.workflows);

  emit({ data: { workflows: entries, errors: result.errors } }, { json: opts.json });
  process.exit(EXIT_OK);
}

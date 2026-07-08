// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { contentBlockSchema, messageChunkSchema, tokenUsageSchema } from "./chat.ts";

// Run-level status. `running` is the value the store writes on POST; the
// executor's RunStatus union ("succeeded" | "failed" | "cancelled") flows in
// on completion. `paused` is written by the route layer when an approval
// node opens; flips back to `running` on resume.
export const workflowRunStatusSchema = z.enum([
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

// Wire-level terminal set — `paused` is intentionally NOT included (a paused
// run is mid-flight, awaiting POST /resume). Distinct from the vendored
// schema's TERMINAL_WORKFLOW_STATUSES, which uses `completed` (Archon
// naming) instead of `succeeded` (keelson naming).
export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

// How a run was triggered. `manual` = an operator started it (POST /runs, the
// CLI, a chat tool); `scheduled` = a background producer run the heartbeat or a
// surface-panel refresh fired. The runs feed defaults to `manual`, and
// `scheduled` runs are retained to a small cap per producer (the snapshot is the
// durable output). Defaulted at parse time so pre-migration rows read `manual`.
export const workflowRunOriginSchema = z.enum(["manual", "scheduled"]);
export type WorkflowRunOrigin = z.infer<typeof workflowRunOriginSchema>;

// Node-level status as persisted to workflow_node_outputs.status. Rows are
// written on completion AND on approval pause (`awaiting`) so a page-reload
// mid-pause can rehydrate the approval callout from the snapshot. The
// `node_done` frame's status is terminal-only — the executor never emits
// `awaiting` through that path; the awaiting state is broadcast via the
// dedicated `approval_awaiting` frame instead.
export const workflowNodeStatusSchema = z.enum(["succeeded", "failed", "skipped", "awaiting"]);
export type WorkflowNodeStatus = z.infer<typeof workflowNodeStatusSchema>;

// One entry per node returned in GET /api/workflows/:name. `type` is the
// node-type discriminator (`prompt`, `bash`, etc.) — present so UI can
// render a node-shape icon without re-parsing the YAML.
export const workflowNodeSummarySchema = z
  .object({
    id: z.string(),
    type: z.string(),
    dependsOn: z.array(z.string()).optional(),
    when: z.string().optional(),
    triggerRule: z.string().optional(),
    // Effective configured model for prompt / command nodes — the node's own
    // `model` or the workflow default. Present so the run trace can show which
    // model each node runs on; for Copilot `auto` this is the only signal,
    // since the provider never reports back which concrete model it resolved.
    model: z.string().optional(),
  })
  .strict();
export type WorkflowNodeSummary = z.infer<typeof workflowNodeSummarySchema>;

// Where a workflow definition came from. `local` = a YAML file in the global
// workflows dir; `rib` = contributed by an installed rib, carrying the rib's
// id + display name so the UI can badge, filter, and hide by rib; `project` =
// a YAML file under a registered project's .keelson/workflows, carrying the
// project's id + name for the same badge/filter treatment. Defaulted to
// `local` at parse time so older payloads (and the many fixtures that build a
// summary by hand) keep validating.
export const workflowSourceSchema = z
  .object({
    kind: z.enum(["local", "rib", "project"]),
    ribId: z.string().optional(),
    ribName: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
  })
  .strict();
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;

// Catalog list shape (GET /api/workflows).
export const workflowSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    nodeCount: z.number().int().nonnegative(),
    source: workflowSourceSchema.default({ kind: "local" }),
    // True for a rib-bound producer workflow the heartbeat auto-refreshes — the
    // user never starts it by hand. The SPA collapses these out of the catalog
    // by default and hides their runs from the default runs feed.
    background: z.boolean().default(false),
  })
  .strict();
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

// Worktree policy block surfaced in the detail response so the SPA can
// pre-check / pre-clear the isolation checkbox in the StartComposer.
export const workflowWorktreePolicyWireSchema = z
  .object({
    enabled: z.boolean().optional(),
    branch: z.string().optional(),
  })
  .strict();
export type WorkflowWorktreePolicyWire = z.infer<typeof workflowWorktreePolicyWireSchema>;

// Single-workflow detail (GET /api/workflows/:name).
export const workflowDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    nodes: z.array(workflowNodeSummarySchema),
    worktree: workflowWorktreePolicyWireSchema.optional(),
    requiresProject: z.boolean().optional(),
  })
  .strict();
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

// One row of workflow_node_outputs. `contentParts` is null for bash nodes
// and populated by the prompt handler with the assistant's structured turn.
export const nodeOutputRowSchema = z
  .object({
    nodeId: z.string(),
    status: workflowNodeStatusSchema,
    outputText: z.string().nullable(),
    contentParts: z.array(contentBlockSchema).nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    // Provider-reported token usage for LLM-backed nodes (migration 4).
    // Defaulted so pre-migration rows and hand-built fixtures keep parsing.
    usage: tokenUsageSchema.nullable().default(null),
    // Effective provider id / model the node ran on (migration 5; prompt +
    // command nodes). Null for non-LLM nodes. Defaulted so pre-migration rows
    // and hand-built fixtures keep parsing.
    provider: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
  })
  .strict();
export type NodeOutputRow = z.infer<typeof nodeOutputRowSchema>;

// Run header (list view). Mirrors workflow_runs row shape minus inputs.
// `conversationId` is the FK added in migration 12; nullable because
// pre-migration rows + post-FK orphans (conversation deleted) carry no link,
// but every newly-created run sets it.
//
// `projectId` / `workingDir` / `worktreePath` / `worktreeBase` are nullable on
// the wire for back-compat with rows created before the projects feature landed.
// New runs always have `workingDir`; `projectId` is set when the caller targeted
// a named project; `worktreePath` and `worktreeBase` are populated only when
// isolation is on and the value is known.
export const workflowRunSummarySchema = z
  .object({
    runId: z.string(),
    workflowName: z.string(),
    status: workflowRunStatusSchema,
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    conversationId: z.string().nullable(),
    projectId: z.string().nullable(),
    workingDir: z.string().nullable(),
    worktreePath: z.string().nullable(),
    worktreeBase: z.string().nullable().default(null),
    // Trigger provenance (migration 3). Defaulted so pre-migration rows and the
    // fixtures that predate the column keep parsing.
    origin: workflowRunOriginSchema.default("manual"),
    // The rib that owns this run's workflow, stamped at run-start from the
    // catalog so historical runs stay badgeable even after the rib is removed.
    // Null for local workflows.
    ribId: z.string().nullable().default(null),
  })
  .strict();
export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;

// Full run detail (GET /api/workflows/runs/:runId).
export const workflowRunDetailSchema = workflowRunSummarySchema
  .extend({
    inputs: z.record(z.string(), z.string()),
    nodes: z.array(nodeOutputRowSchema),
  })
  .strict();
export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>;

// Per-run isolation override. `"worktree"` forces a git-worktree run;
// `"none"` forces an in-place run; omitted → the workflow YAML's
// `worktree.enabled` decides (default: in-place).
export const isolationOverrideSchema = z.enum(["worktree", "none"]);
export type IsolationOverride = z.infer<typeof isolationOverrideSchema>;

// POST /api/workflows/:name/runs request body.
//
// At least one of `projectId` / `workingDir` must be provided: the server
// rejects requests with neither so a workflow doesn't silently target the
// server's install directory. `projectId` resolves to the project's
// `root_path`; `workingDir` overrides that (or stands alone). When both
// are given, `workingDir` wins and `projectId` is recorded for display only.
export const startWorkflowRunBodySchema = z
  .object({
    inputs: z.record(z.string(), z.string()).default({}),
    projectId: z.string().optional(),
    workingDir: z.string().optional(),
    isolation: isolationOverrideSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.projectId || v.workingDir), {
    message: "either projectId or workingDir is required",
    path: ["projectId"],
  });
export type StartWorkflowRunBody = z.infer<typeof startWorkflowRunBodySchema>;

// POST /api/workflows/:name/runs response body. `workflowName` is the canonical
// catalog name the run started under — it differs from the request-path name on
// a fuzzy match (POST /runs/smoketst → smoke-test). Optional for back-compat;
// clients should prefer it so follow-up routes ("open in Workflows", run detail)
// use the real name, not the typo.
export const startWorkflowRunResponseSchema = z
  .object({ runId: z.string(), workflowName: z.string().optional() })
  .strict();
export type StartWorkflowRunResponse = z.infer<typeof startWorkflowRunResponseSchema>;

// Non-fatal loader notices surfaced to the UI as toasts. `error`-level
// notices map to dropped workflows (file failed to load); `warning`-level
// notices map to per-node ignored capabilities / adapted fields. The loader
// already returns these via `discoverWorkflows`; this is the wire shape.
export const workflowDiscoveryNoticeSchema = z
  .object({
    level: z.enum(["error", "warning"]),
    filename: z.string(),
    nodeId: z.string().optional(),
    message: z.string(),
  })
  .strict();
export type WorkflowDiscoveryNotice = z.infer<typeof workflowDiscoveryNoticeSchema>;

// Top-level response envelopes. Defined here (not at the call site) so the web
// client can use them without taking a direct zod dependency.
export const listWorkflowsResponseSchema = z
  .object({
    workflows: z.array(workflowSummarySchema),
    discoveryNotices: z.array(workflowDiscoveryNoticeSchema).default([]),
  })
  .strict();
export type ListWorkflowsResponse = z.infer<typeof listWorkflowsResponseSchema>;

export const getWorkflowDetailResponseSchema = z
  .object({ workflow: workflowDetailSchema })
  .strict();
export type GetWorkflowDetailResponse = z.infer<typeof getWorkflowDetailResponseSchema>;

export const listRunsResponseSchema = z
  .object({ runs: z.array(workflowRunSummarySchema) })
  .strict();
export type ListRunsResponse = z.infer<typeof listRunsResponseSchema>;

export const getWorkflowRunResponseSchema = z.object({ run: workflowRunDetailSchema }).strict();
export type GetWorkflowRunResponse = z.infer<typeof getWorkflowRunResponseSchema>;

// Per-run WebSocket frame envelope. Sibling of chatFrameSchema, not a reuse
// — chat is conversation-keyed; workflows are run-keyed and node-scoped.
// `node_chunk` wraps `messageChunkSchema` verbatim so the existing
// <ToolCallsBlock> / markdown / <ThinkingBlock> components can render prompt
// nodes natively. `node_log` is the bash handler's per-line stdout channel.
export const workflowFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run_started"),
      runId: z.string(),
      workflowName: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("node_started"), nodeId: z.string() }).strict(),
  z
    .object({
      type: z.literal("node_chunk"),
      nodeId: z.string(),
      chunk: messageChunkSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("node_log"),
      nodeId: z.string(),
      line: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("node_done"),
      nodeId: z.string(),
      status: workflowNodeStatusSchema,
      error: z.string().nullable(),
      // Omitted (not null) when the node spent no reported tokens.
      usage: tokenUsageSchema.optional(),
      // Effective provider id / model an LLM-backed node ran on, so a live run
      // shows them without a reload. Omitted for non-LLM nodes.
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run_warning"),
      nodeId: z.string().nullable(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run_done"),
      status: workflowRunStatusSchema,
    })
    .strict(),
  // Broadcast when an approval node opens. Flips the client's run status
  // to `paused` and surfaces the inline approval callout. The user's reply
  // (or quick-action) lands via POST /api/workflows/runs/:runId/resume.
  // `pauseId` is a per-pause token the client must echo back so a stale or
  // duplicated POST for a prior iteration can't resolve a later interactive-
  // loop pause that happens to reuse the same nodeId.
  z
    .object({
      type: z.literal("approval_awaiting"),
      nodeId: z.string(),
      message: z.string(),
      pauseId: z.string(),
    })
    .strict(),
  // Broadcast when a paused node is resumed via POST /resume. Tells live
  // clients to clear the awaiting callout for `nodeId`. For approval nodes,
  // `node_done` follows immediately; for interactive-loop nodes, the loop
  // continues iterating without a node_done until terminal — without this
  // frame, the SPA would keep the composer open across the next iteration's
  // worth of work and retries would hit 409 on the now-cleared pending.
  z
    .object({
      type: z.literal("approval_resolved"),
      nodeId: z.string(),
    })
    .strict(),
]);
export type WorkflowFrame = z.infer<typeof workflowFrameSchema>;

// POST /api/workflows/runs/:runId/resume body. Text is bounded so a runaway
// reply (paste of a 50KB diff, etc.) can't blow up the route's memory; 16 KiB
// is far larger than any plausible approval reply but small enough to reject
// obvious abuse. `pauseId` is optional for back-compat with CLI clients that
// don't yet know the token (e.g. operator-typed `keelson workflow respond`),
// but when present the server MUST verify it matches the current pause —
// otherwise a stale POST for iteration N could resolve iteration N+1 of an
// interactive loop that reuses the same nodeId.
export const resumeWorkflowRunBodySchema = z
  .object({
    nodeId: z.string().min(1),
    text: z.string().max(16_384),
    pauseId: z.string().min(1).optional(),
  })
  .strict();
export type ResumeWorkflowRunBody = z.infer<typeof resumeWorkflowRunBodySchema>;

export const resumeWorkflowRunResponseSchema = z.object({ resumed: z.literal(true) }).strict();
export type ResumeWorkflowRunResponse = z.infer<typeof resumeWorkflowRunResponseSchema>;

// POST /api/workflows/runs/bulk-delete body. Two mutually-exclusive forms: an
// explicit list of run ids, or a filter that selects a group (e.g. all
// `scheduled` runs, or every run owned by a rib). The filter must constrain at
// least one field so a typo'd empty body can't purge the entire run history.
export const bulkDeleteRunsFilterSchema = z
  .object({
    workflowName: z.string().min(1).optional(),
    origin: workflowRunOriginSchema.optional(),
    ribId: z.string().min(1).optional(),
    statuses: z.array(workflowRunStatusSchema).min(1).optional(),
  })
  .strict()
  .refine((f) => Object.values(f).some((v) => v !== undefined), {
    message: "filter must constrain at least one of workflowName / origin / ribId / statuses",
  });
export type BulkDeleteRunsFilter = z.infer<typeof bulkDeleteRunsFilterSchema>;

export const bulkDeleteRunsBodySchema = z.union([
  z.object({ runIds: z.array(z.string().min(1)).min(1).max(1000) }).strict(),
  z.object({ filter: bulkDeleteRunsFilterSchema }).strict(),
]);
export type BulkDeleteRunsBody = z.infer<typeof bulkDeleteRunsBodySchema>;

export const bulkDeleteRunsResponseSchema = z
  .object({ deleted: z.number().int().nonnegative() })
  .strict();
export type BulkDeleteRunsResponse = z.infer<typeof bulkDeleteRunsResponseSchema>;

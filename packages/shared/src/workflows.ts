// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { contentBlockSchema, messageChunkSchema } from "./chat.ts";

// Run-level status. `running` is the value the store writes on POST; the
// executor's RunStatus union ("succeeded" | "failed" | "cancelled") flows in
// on completion. `paused` is W4.6 — the route layer writes it when an
// approval node opens and flips back to `running` on resume.
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

// Node-level status as persisted to workflow_node_outputs.status. Rows are
// written on completion AND on approval pause (`awaiting`, W4.6) so a
// page-reload mid-pause can rehydrate the approval callout from the snapshot.
// The `node_done` frame's status is terminal-only — the executor never emits
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
  })
  .strict();
export type WorkflowNodeSummary = z.infer<typeof workflowNodeSummarySchema>;

// Catalog list shape (GET /api/workflows).
export const workflowSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    nodeCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

// Single-workflow detail (GET /api/workflows/:name).
export const workflowDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    nodes: z.array(workflowNodeSummarySchema),
  })
  .strict();
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

// One row of workflow_node_outputs. `contentParts` is null for bash nodes
// and populated by W3's prompt handler with the assistant's structured turn.
export const nodeOutputRowSchema = z
  .object({
    nodeId: z.string(),
    status: workflowNodeStatusSchema,
    outputText: z.string().nullable(),
    contentParts: z.array(contentBlockSchema).nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type NodeOutputRow = z.infer<typeof nodeOutputRowSchema>;

// Run header (list view). Mirrors workflow_runs row shape minus inputs.
// `conversationId` is the FK added in migration 12 (Phase 4 W4.5); nullable
// because pre-migration rows + post-FK orphans (conversation deleted) carry no
// link, but every newly-created run sets it.
export const workflowRunSummarySchema = z
  .object({
    runId: z.string(),
    workflowName: z.string(),
    status: workflowRunStatusSchema,
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    conversationId: z.string().nullable(),
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

// POST /api/workflows/:name/runs request body.
export const startWorkflowRunBodySchema = z
  .object({
    inputs: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type StartWorkflowRunBody = z.infer<typeof startWorkflowRunBodySchema>;

// POST /api/workflows/:name/runs response body.
export const startWorkflowRunResponseSchema = z.object({ runId: z.string() }).strict();
export type StartWorkflowRunResponse = z.infer<typeof startWorkflowRunResponseSchema>;

// Non-fatal loader notices surfaced to the UI as toasts (W6). `error`-level
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

// Per-run WebSocket frame envelope (W3). Sibling of chatFrameSchema, not a
// reuse — chat is conversation-keyed; workflows are run-keyed and node-scoped.
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
  // W4.6 — broadcast when an approval node opens. Flips the client's run
  // status to `paused` and surfaces the inline approval callout. The user's
  // reply (or quick-action) lands via POST /api/workflows/runs/:runId/resume;
  // resume emits the usual `node_done` for the approval node so no separate
  // `approval_resolved` frame is needed.
  z
    .object({
      type: z.literal("approval_awaiting"),
      nodeId: z.string(),
      message: z.string(),
    })
    .strict(),
]);
export type WorkflowFrame = z.infer<typeof workflowFrameSchema>;

// W4.6 — POST /api/workflows/runs/:runId/resume body. Text is bounded so a
// runaway reply (paste of a 50KB diff, etc.) can't blow up the route's memory;
// 16 KiB is far larger than any plausible approval reply but small enough to
// reject obvious abuse.
export const resumeWorkflowRunBodySchema = z
  .object({
    nodeId: z.string().min(1),
    text: z.string().max(16_384),
  })
  .strict();
export type ResumeWorkflowRunBody = z.infer<typeof resumeWorkflowRunBodySchema>;

export const resumeWorkflowRunResponseSchema = z.object({ resumed: z.literal(true) }).strict();
export type ResumeWorkflowRunResponse = z.infer<typeof resumeWorkflowRunResponseSchema>;

/**
 * Zod schemas for workflow run state types. The on-disk YAML format is
 * compatible with the upstream specification credited in the repo NOTICE.
 *
 * Keelson stores run state in SQLite, so `conversation_id`,
 * `parent_conversation_id`, and `codebase_id` are optional here. NodeOutput
 * carries optional runtime fields (`usage`, `startedAt`, `completedAt`,
 * `durationMs`) used by the executor's lifecycle hooks.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

/** Statuses that allow a user to resume execution. */
export const RESUMABLE_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'failed',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export const nodeStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export type NodeState = z.infer<typeof nodeStateSchema>;

// ---------------------------------------------------------------------------
// TokenUsage (Keelson addition)
// ---------------------------------------------------------------------------

/**
 * Per-node token usage, harvested from the spawned child's `message_end`
 * events (sum across all assistant turns). All fields optional so providers
 * without pricing still validate and old on-disk runs that pre-date a field
 * round-trip cleanly.
 */
export const tokenUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    costUsd: z.number(),
  })
  .partial();

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

// ---------------------------------------------------------------------------
// NodeOutput
// ---------------------------------------------------------------------------

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string when
 * output_format is set). Empty string for failed/skipped nodes.
 * `error` is required when state is 'failed', absent on all other states.
 *
 * `usage` / `startedAt` / `completedAt` / `durationMs` are Keelson-only
 * runtime extras (see file header). All optional and additive.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
    usage: tokenUsageSchema.optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
    usage: tokenUsageSchema.optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    state: z.enum(['pending', 'skipped']),
    output: z.string(),
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

/**
 * Runtime workflow run state. Persisted in SQLite by the server
 * (see apps/server/src/workflow-store.ts).
 */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string().optional(),
  parent_conversation_id: z.string().nullable().optional(),
  codebase_id: z.string().nullable().optional(),
  status: workflowRunStatusSchema,
  user_message: z.string(),
  metadata: z.record(z.unknown()),
  // Dates serialize to ISO strings on disk; the schema accepts both shapes for round-trip.
  started_at: z.union([z.date(), z.string()]),
  completed_at: z.union([z.date(), z.string()]).nullable().optional(),
  last_activity_at: z.union([z.date(), z.string()]).nullable().optional(),
  working_path: z.string().nullable().optional(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** Approval context stored in workflow run metadata when paused for human review. */
export interface ApprovalContext {
  nodeId: string;
  message: string;
  /** Distinguishes approval-gate pauses from interactive-loop pauses. */
  type?: 'approval' | 'interactive_loop';
  /** Current loop iteration when paused (interactive loops only). */
  iteration?: number;
  /** Session ID to restore on resume (interactive loops only). */
  sessionId?: string;
  /** When true, the user's approval comment is stored as `$nodeId.output`. */
  captureResponse?: boolean;
  /** The on_reject prompt template (stored at pause time so reject handlers don't need the workflow def). */
  onRejectPrompt?: string;
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts?: number;
}

/**
 * Type guard for ApprovalContext.
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string'
  );
}

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning

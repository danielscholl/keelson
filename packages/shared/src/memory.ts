// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// === Enums ==================================================================
// Mirror the SQL CHECK constraints in apps/server/src/db/migrations.ts:80-227
// byte-for-byte — any drift between Zod and SQL breaks recall/writeback at
// the storage boundary.

export const memoryTypeSchema = z.enum([
  "decision",
  "output",
  "lesson",
  "constraint",
  "open_question",
  "failure",
  "artifact_reference",
  "work_log",
]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const provenanceSchema = z.enum([
  "observed",
  "inferred",
  "user_confirmed",
  "imported",
  "generated",
  "superseded",
  "disputed",
]);
export type Provenance = z.infer<typeof provenanceSchema>;

// Single-user / local only — `channel`, `workspace`, `organization` from
// the wider upstream taxonomy are intentionally dropped.
export const scopeVisibilitySchema = z.enum(["project", "personal"]);
export type ScopeVisibility = z.infer<typeof scopeVisibilitySchema>;

export const lifecycleSchema = z.enum(["active", "stale", "superseded", "disputed", "rejected"]);
export type Lifecycle = z.infer<typeof lifecycleSchema>;

export const reviewStatusSchema = z.enum([
  "pending",
  "confirmed",
  "evidence_only",
  "restricted",
  "rejected",
  "stale",
  "merged",
]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

// Imperative form posted to the M7 review-queue endpoint. The terminal
// review_status the action drives is in reviewStatusSchema above.
export const reviewActionKindSchema = z.enum([
  "confirm",
  "evidence_only",
  "restrict",
  "reject",
  "merge",
  "mark_stale",
]);
export type ReviewActionKind = z.infer<typeof reviewActionKindSchema>;

// Provenances that may be promoted to instruction — kept as a named export so
// the M7 UI and the M3 service layer read the same intent the DB CHECK does.
export const INSTRUCTION_ELIGIBLE_PROVENANCES: readonly Provenance[] = [
  "user_confirmed",
  "imported",
] as const;

// === Building blocks ========================================================

// Wire surface uses camelCase booleans; the M1 storage layer maps to 0/1
// INTEGER columns. The instruction-promotion gate is enforced on
// memorySchema below, not here, so partial-shape callers (drafts, patches)
// can compose this without tripping the cross-field check.
export const usePolicySchema = z
  .object({
    canUseAsInstruction: z.boolean(),
    canUseAsEvidence: z.boolean(),
    requiresUserConfirmation: z.boolean(),
    doNotInjectAutomatically: z.boolean(),
  })
  .strict();
export type UsePolicy = z.infer<typeof usePolicySchema>;

export const scopeSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    // `personal` does not surface in workflow recall — see PRD §Scope.
    visibility: scopeVisibilitySchema,
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;

// Free-form runtime label — `workflow:<name>`, `skill:<name>`, `chat`,
// rib-specific identifiers. Storage CHECK constraints sit only on the
// strongly-typed enums above; `runtime` is intentionally open.
export const taskSchema = z
  .object({
    runtime: z.string().min(1),
    taskId: z.string().optional(),
    flowId: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

export const sourceRefSchema = z
  .object({
    kind: z.string().min(1),
    uri: z.string().min(1),
    title: z.string().optional(),
    sourceTimestamp: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const artifactSchema = z
  .object({
    kind: z.string().min(1),
    uri: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

// === Memory record ==========================================================
// Full read shape, projected (trimmed) into recallItemSchema for the recall
// wire and reviewItemSchema for the review-queue wire. Not exposed
// over HTTP directly — storage-internal fields (idempotencyKey, contentHash)
// would leak through.

const memoryBaseSchema = z
  .object({
    id: z.string().min(1),
    type: memoryTypeSchema,
    summary: z.string().min(1),
    content: z.string().min(1),
    provenance: provenanceSchema,
    usePolicy: usePolicySchema,
    scope: scopeSchema,
    lifecycle: lifecycleSchema,
    reviewStatus: reviewStatusSchema,
    contentHash: z.string().min(1),
    idempotencyKey: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    runtime: z.string().min(1),
    taskId: z.string().optional(),
    flowId: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    staleAfter: z.string().datetime({ offset: true }).optional(),
    sourceRefs: z.array(sourceRefSchema).default([]),
    artifacts: z.array(artifactSchema).default([]),
  })
  .strict();

// Instruction-promotion gate — mirrors the cross-column SQL CHECK at
// migrations.ts:123-126. Enforced here so HTTP/WS callers fail at wire
// parse, not just at INSERT time.
export const memorySchema = memoryBaseSchema.refine(
  (m) =>
    !m.usePolicy.canUseAsInstruction ||
    m.provenance === "user_confirmed" ||
    m.provenance === "imported",
  {
    message:
      "usePolicy.canUseAsInstruction = true requires provenance in {user_confirmed, imported}",
    path: ["usePolicy", "canUseAsInstruction"],
  },
);
export type Memory = z.infer<typeof memorySchema>;

// === Recall =================================================================

export const RECALL_REQUEST_SCHEMA_VERSION = "keelson.memory.recall.v1" as const;
export const RECALL_RESPONSE_SCHEMA_VERSION = "keelson.memory.recall_response.v1" as const;

export const recallEntitiesSchema = z
  .object({
    repos: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    cves: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
  })
  .strict();
export type RecallEntities = z.infer<typeof recallEntitiesSchema>;

export const recallLimitsSchema = z
  .object({
    maxItems: z.number().int().positive().optional(),
    recencyDays: z.number().int().positive().optional(),
  })
  .strict();
export type RecallLimits = z.infer<typeof recallLimitsSchema>;

export const recallRequestSchema = z
  .object({
    schemaVersion: z.literal(RECALL_REQUEST_SCHEMA_VERSION),
    scope: scopeSchema,
    task: taskSchema,
    query: z.string().min(1),
    entities: recallEntitiesSchema.optional(),
    limits: recallLimitsSchema.optional(),
  })
  .strict();
export type RecallRequest = z.infer<typeof recallRequestSchema>;

// Trimmed projection of memorySchema — enough for the agent to cite the
// recalled item without leaking storage-internal fields like
// idempotencyKey or contentHash. `rankingScore` is the BM25 + recency +
// scope-weighted score from the M3 retrieval pass.
export const recallItemSchema = z
  .object({
    memoryId: z.string().min(1),
    type: memoryTypeSchema,
    summary: z.string().min(1),
    content: z.string().min(1),
    provenance: provenanceSchema,
    usePolicy: usePolicySchema,
    scope: scopeSchema,
    sourceRefs: z.array(sourceRefSchema).default([]),
    artifacts: z.array(artifactSchema).default([]),
    createdAt: z.string().datetime({ offset: true }),
    rankingScore: z.number().min(0).max(1),
  })
  .strict();
export type RecallItem = z.infer<typeof recallItemSchema>;

export const recallResponseSchema = z
  .object({
    schemaVersion: z.literal(RECALL_RESPONSE_SCHEMA_VERSION),
    requestId: z.string().min(1),
    items: z.array(recallItemSchema),
    trace: z
      .object({
        traceId: z.string().min(1),
        returned: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type RecallResponse = z.infer<typeof recallResponseSchema>;

// === Writeback ==============================================================

export const WRITEBACK_REQUEST_SCHEMA_VERSION = "keelson.memory.writeback.v1" as const;
export const WRITEBACK_RESPONSE_SCHEMA_VERSION = "keelson.memory.writeback_response.v1" as const;

// PRD §Write-back guardrails caps summary/content at 4 KB. Cap here is on
// JavaScript string length (UTF-16 code units); the true byte cap is
// re-checked in the M3 service layer before insert.
export const MEMORY_TEXT_LIMIT = 4096 as const;

// Provenances an agent writeback may produce. Excludes `user_confirmed` and
// `imported` (only the review-queue and import paths create those) and
// excludes `superseded` / `disputed` (lifecycle transitions, not initial
// states). The evidence-default invariant (PRD §"Load-bearing invariants"
// #1) means none of these are instruction-eligible — promotion always
// requires a review action, even if the service blindly trusted the value
// on the wire.
export const writebackProvenanceSchema = z.enum(["observed", "inferred", "generated"]);
export type WritebackProvenance = z.infer<typeof writebackProvenanceSchema>;

export const writebackMemoryDraftSchema = z
  .object({
    type: memoryTypeSchema,
    summary: z.string().min(1).max(MEMORY_TEXT_LIMIT),
    content: z.string().min(1).max(MEMORY_TEXT_LIMIT),
    // SHA256 of the normalized content, computed by the agent. The M3
    // storage layer derives each row's UNIQUE `idempotency_key` as
    // `{task.runtime}:{task.taskId}:{type}:{contentHash}`, so the hash
    // must live on the draft (not the envelope) for multi-memory writebacks
    // to stay distinct when type and task match.
    contentHash: z.string().min(1),
    provenance: writebackProvenanceSchema.default("generated"),
    sourceRefs: z.array(sourceRefSchema).default([]),
    artifacts: z.array(artifactSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    staleAfterDays: z.number().int().positive().optional(),
  })
  .strict();
export type WritebackMemoryDraft = z.infer<typeof writebackMemoryDraftSchema>;

export const writebackRequestSchema = z
  .object({
    schemaVersion: z.literal(WRITEBACK_REQUEST_SCHEMA_VERSION),
    // Request-envelope dedupe key — guards against HTTP-retry double
    // submission of the whole batch. Per-memory storage keys derive from
    // each draft's `contentHash` above, not from this field.
    idempotencyKey: z.string().min(1),
    scope: scopeSchema.optional(),
    task: taskSchema,
    memories: z.array(writebackMemoryDraftSchema).min(1),
  })
  .strict();
export type WritebackRequest = z.infer<typeof writebackRequestSchema>;

export const writebackBlockedReasonSchema = z.enum([
  "potential_secret",
  "content_too_large",
  "missing_source_ref",
]);
export type WritebackBlockedReason = z.infer<typeof writebackBlockedReasonSchema>;

export const writebackResponseSchema = z
  .object({
    schemaVersion: z.literal(WRITEBACK_RESPONSE_SCHEMA_VERSION),
    written: z
      .array(
        z
          .object({
            memoryId: z.string().min(1),
            idempotencyKey: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    blocked: z
      .array(
        z
          .object({
            reason: writebackBlockedReasonSchema,
            summary: z.string(),
          })
          .strict(),
      )
      .default([]),
    deduped: z
      .array(
        z
          .object({
            memoryId: z.string().min(1),
            reason: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type WritebackResponse = z.infer<typeof writebackResponseSchema>;

// === Review action ==========================================================
// M7's review queue posts this to advance review_status / lifecycle.

export const reviewActionRequestSchema = z
  .object({
    memoryId: z.string().min(1),
    action: reviewActionKindSchema,
    actor: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();
export type ReviewActionRequest = z.infer<typeof reviewActionRequestSchema>;

// `applied: false` is the silent-no-op shape the store returns for an
// unknown memoryId — matches `ConversationStore.delete`. M7 uses it to
// distinguish "review row vanished between list and confirm" from a real
// state transition.
export const reviewActionResponseSchema = z
  .object({
    applied: z.boolean(),
  })
  .strict();
export type ReviewActionResponse = z.infer<typeof reviewActionResponseSchema>;

// === Review queue (pending list) ============================================
// GET /api/memory/review surface for the M7 review tab. Deliberately a
// trimmed projection of Memory that drops storage-internal fields
// (`idempotencyKey`, `contentHash`) so an HTML view of the queue never
// surfaces the dedupe key publicly. Lifecycle + reviewStatus are added back
// because the reviewer needs to see the state they're about to advance.

export const REVIEW_LIST_DEFAULT_LIMIT = 50 as const;
export const REVIEW_LIST_MAX_LIMIT = 200 as const;

export const reviewItemSchema = z
  .object({
    memoryId: z.string().min(1),
    type: memoryTypeSchema,
    summary: z.string().min(1),
    content: z.string().min(1),
    provenance: provenanceSchema,
    usePolicy: usePolicySchema,
    scope: scopeSchema,
    lifecycle: lifecycleSchema,
    reviewStatus: reviewStatusSchema,
    sourceRefs: z.array(sourceRefSchema).default([]),
    artifacts: z.array(artifactSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    runtime: z.string().min(1),
    taskId: z.string().optional(),
    flowId: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    // Surfaced so the reviewer can see whether a pending row has already
    // passed its TTL — the reviewer might still want to confirm it (the
    // promotion is the explicit gesture) but should at least see the state.
    staleAfter: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ReviewItem = z.infer<typeof reviewItemSchema>;

// Opaque cursor — base64(JSON({ createdAt, id })) — paired with the
// deterministic `created_at DESC, id DESC` ordering so concurrent
// writebacks can't shuffle a page mid-walk.
export const reviewListQuerySchema = z
  .object({
    limit: z.number().int().positive().max(REVIEW_LIST_MAX_LIMIT).optional(),
    cursor: z.string().min(1).optional(),
    scopeVisibility: scopeVisibilitySchema.optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict();
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

export const reviewListResponseSchema = z
  .object({
    items: z.array(reviewItemSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

// === Runtime handle (placeholder) ===========================================
// Declaration-only — the workflow executor's `NodeContext.memory?:
// MemoryTools` slot and the prompt-handler `lifecycle.{beforeNode,
// afterNode}` hooks bind to this. M6 fleshes out the concrete
// recall/writeback/confirm methods.

export interface MemoryTools {
  readonly __phase: "pending";
}

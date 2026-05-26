/**
 * Per-node `memory:` block — declarative recall (pre-run) and writeback
 * (post-run) hooks for the M5 workflow memory integration.
 *
 * The enums below mirror `@keelson/shared/memory.ts` (memoryType, scope kind,
 * source-ref shape). They are intentionally duplicated rather than imported
 * because `@keelson/workflows` keeps its dep graph free of `@keelson/shared`
 * (same boundary discipline as `PromptHandlerProvider` and `MemoryTools` in
 * executor.ts). The executor never inspects the runtime memory adapter's
 * request body — it forwards what the binding produces — so the only
 * contract enforced here is the YAML shape an author writes.
 *
 * Evidence-default invariant (PRD #10, load-bearing rule #1): the writeback
 * block intentionally does NOT expose `provenance`. The executor hard-codes
 * `provenance: "generated"` when building the wire envelope, so a workflow
 * author cannot opt out of evidence-default by writing a different value.
 */
import { z } from "zod";

// Mirrors `memoryTypeSchema` in @keelson/shared/memory.ts.
const memoryTypeSchema = z.enum([
  "decision",
  "output",
  "lesson",
  "constraint",
  "open_question",
  "failure",
  "artifact_reference",
  "work_log",
]);

// Mirrors `sourceRefSchema` in @keelson/shared/memory.ts.
const sourceRefSchema = z
  .object({
    kind: z.string().min(1),
    uri: z.string().min(1),
    title: z.string().optional(),
    sourceTimestamp: z.string().optional(),
  })
  .strict();

// Mirrors `recallEntitiesSchema` in @keelson/shared/memory.ts.
const recallEntitiesSchema = z
  .object({
    repos: z.array(z.string().min(1)).optional(),
    files: z.array(z.string().min(1)).optional(),
    cves: z.array(z.string().min(1)).optional(),
    topics: z.array(z.string().min(1)).optional(),
  })
  .strict();

// Mirrors `recallLimitsSchema` in @keelson/shared/memory.ts.
const recallLimitsSchema = z
  .object({
    maxItems: z.number().int().positive().optional(),
    recencyDays: z.number().int().positive().optional(),
  })
  .strict();

export const nodeMemoryRecallSchema = z
  .object({
    query: z.string().min(1),
    entities: recallEntitiesSchema.optional(),
    limits: recallLimitsSchema.optional(),
  })
  .strict();

export type NodeMemoryRecall = z.infer<typeof nodeMemoryRecallSchema>;

export const nodeMemoryWritebackSchema = z
  .object({
    on: z.enum(["success", "always"]).default("success"),
    type: memoryTypeSchema,
    summary: z.string().min(1),
    content: z.string().min(1),
    sourceRefs: z.array(sourceRefSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    staleAfterDays: z.number().int().positive().optional(),
  })
  .strict();

export type NodeMemoryWriteback = z.infer<typeof nodeMemoryWritebackSchema>;

export const nodeMemoryBlockSchema = z
  .object({
    recall: nodeMemoryRecallSchema.optional(),
    writeback: nodeMemoryWritebackSchema.optional(),
  })
  .strict();

export type NodeMemoryBlock = z.infer<typeof nodeMemoryBlockSchema>;

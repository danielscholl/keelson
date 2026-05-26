/**
 * Per-node `memory:` block — declarative recall (pre-run) and writeback
 * (post-run) hooks for the M5 workflow memory integration.
 *
 * The enums below mirror `@keelson/shared/memory.ts` (memoryType, scope kind,
 * source-ref shape). They are intentionally duplicated rather than imported
 * because `@keelson/workflows` keeps its dep graph free of `@keelson/shared`
 * (same boundary discipline as `PromptHandlerProvider` and `MemoryTools` in
 * executor.ts). The constraints applied here must match the shared wire
 * schema byte-for-byte — drift means a workflow parses at load time and
 * then fails at the server adapter's Zod re-parse, which is a worse author
 * experience than a deterministic load-time error.
 *
 * Evidence-default invariant (PRD #10, load-bearing rule #1): the writeback
 * block intentionally does NOT expose `provenance`. The executor hard-codes
 * `provenance: "generated"` when building the wire envelope, so a workflow
 * author cannot opt out of evidence-default by writing a different value.
 */
import { z } from "zod";

// Mirrors `MEMORY_TEXT_LIMIT` in @keelson/shared/memory.ts. The shared
// schema caps summary/content at 4 KB of UTF-16 code units; mirror it so
// authors get a load-time error rather than an adapter-time parse failure.
const MEMORY_TEXT_LIMIT = 4096 as const;

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

// Mirrors `sourceRefSchema` in @keelson/shared/memory.ts. `sourceTimestamp`
// must be RFC3339 with offset — a plain string would parse here and then
// fail at the adapter Zod re-parse on every writeback.
const sourceRefSchema = z
  .object({
    kind: z.string().min(1),
    uri: z.string().min(1),
    title: z.string().optional(),
    sourceTimestamp: z.string().datetime({ offset: true }).optional(),
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
    summary: z.string().min(1).max(MEMORY_TEXT_LIMIT),
    content: z.string().min(1).max(MEMORY_TEXT_LIMIT),
    sourceRefs: z.array(sourceRefSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    staleAfterDays: z.number().int().positive().optional(),
  })
  .strict();

export type NodeMemoryWriteback = z.infer<typeof nodeMemoryWritebackSchema>;

// `memory: {}` with neither sub-block is dead config — it adds no recall or
// writeback behavior but still trips the headless server-required gate.
// Reject at parse time so authors get a deterministic error instead of a
// surprise exit-3 with nothing actually declared.
export const nodeMemoryBlockSchema = z
  .object({
    recall: nodeMemoryRecallSchema.optional(),
    writeback: nodeMemoryWritebackSchema.optional(),
  })
  .strict()
  .refine((m) => m.recall !== undefined || m.writeback !== undefined, {
    message: "memory must include at least one of 'recall' or 'writeback'",
  });

export type NodeMemoryBlock = z.infer<typeof nodeMemoryBlockSchema>;

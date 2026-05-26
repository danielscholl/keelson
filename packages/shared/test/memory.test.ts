// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import {
  artifactSchema,
  INSTRUCTION_ELIGIBLE_PROVENANCES,
  lifecycleSchema,
  MEMORY_TEXT_LIMIT,
  memorySchema,
  memoryTypeSchema,
  provenanceSchema,
  RECALL_REQUEST_SCHEMA_VERSION,
  RECALL_RESPONSE_SCHEMA_VERSION,
  recallItemSchema,
  recallRequestSchema,
  recallResponseSchema,
  reviewActionKindSchema,
  reviewActionRequestSchema,
  reviewStatusSchema,
  scopeSchema,
  scopeVisibilitySchema,
  sourceRefSchema,
  taskSchema,
  usePolicySchema,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
  WRITEBACK_RESPONSE_SCHEMA_VERSION,
  writebackMemoryDraftSchema,
  writebackProvenanceSchema,
  writebackRequestSchema,
  writebackResponseSchema,
} from "../src/memory.ts";

// Mirrors apps/server/test/memory-schema.test.ts:57-87 but in camelCase wire
// shape. Defaults track the M1 column defaults so reads off storage round-trip.
function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem_01",
    type: "decision" as const,
    summary: "Use bun:sqlite",
    content: "We pick bun:sqlite over better-sqlite3 for native bundling.",
    provenance: "user_confirmed" as const,
    usePolicy: {
      canUseAsInstruction: false,
      canUseAsEvidence: true,
      requiresUserConfirmation: false,
      doNotInjectAutomatically: false,
    },
    scope: { visibility: "project" as const },
    lifecycle: "active" as const,
    reviewStatus: "pending" as const,
    contentHash: "sha256:abc",
    idempotencyKey: "chat:t1:decision:sha256:abc",
    runtime: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceRefs: [],
    artifacts: [],
    ...overrides,
  };
}

describe("memoryTypeSchema", () => {
  it.each([
    "decision",
    "output",
    "lesson",
    "constraint",
    "open_question",
    "failure",
    "artifact_reference",
    "work_log",
  ])("accepts %s", (v) => {
    expect(memoryTypeSchema.parse(v)).toBe(v);
  });

  it("rejects an unknown type", () => {
    expect(() => memoryTypeSchema.parse("note")).toThrow();
  });
});

describe("provenanceSchema", () => {
  it.each([
    "observed",
    "inferred",
    "user_confirmed",
    "imported",
    "generated",
    "superseded",
    "disputed",
  ])("accepts %s", (v) => {
    expect(provenanceSchema.parse(v)).toBe(v);
  });

  it("rejects an unknown provenance", () => {
    expect(() => provenanceSchema.parse("guessed")).toThrow();
  });
});

describe("scopeVisibilitySchema", () => {
  it.each(["project", "personal"])("accepts %s", (v) => {
    expect(scopeVisibilitySchema.parse(v)).toBe(v);
  });

  it("rejects scopes keelson dropped (channel/workspace/organization)", () => {
    expect(() => scopeVisibilitySchema.parse("channel")).toThrow();
    expect(() => scopeVisibilitySchema.parse("workspace")).toThrow();
    expect(() => scopeVisibilitySchema.parse("organization")).toThrow();
  });
});

describe("lifecycleSchema", () => {
  it.each(["active", "stale", "superseded", "disputed", "rejected"])("accepts %s", (v) => {
    expect(lifecycleSchema.parse(v)).toBe(v);
  });

  it("rejects unknown lifecycle", () => {
    expect(() => lifecycleSchema.parse("draft")).toThrow();
  });
});

describe("reviewStatusSchema", () => {
  it.each([
    "pending",
    "confirmed",
    "evidence_only",
    "restricted",
    "rejected",
    "stale",
    "merged",
  ])("accepts %s", (v) => {
    expect(reviewStatusSchema.parse(v)).toBe(v);
  });

  it("rejects unknown review_status", () => {
    expect(() => reviewStatusSchema.parse("approved")).toThrow();
  });
});

describe("reviewActionKindSchema", () => {
  it.each([
    "confirm",
    "evidence_only",
    "restrict",
    "reject",
    "merge",
    "mark_stale",
  ])("accepts %s", (v) => {
    expect(reviewActionKindSchema.parse(v)).toBe(v);
  });

  it("rejects unknown action", () => {
    expect(() => reviewActionKindSchema.parse("approve")).toThrow();
  });
});

describe("INSTRUCTION_ELIGIBLE_PROVENANCES", () => {
  it("matches the SQL CHECK at migrations.ts:123-126", () => {
    expect(INSTRUCTION_ELIGIBLE_PROVENANCES).toContain("user_confirmed");
    expect(INSTRUCTION_ELIGIBLE_PROVENANCES).toContain("imported");
    expect(INSTRUCTION_ELIGIBLE_PROVENANCES.length).toBe(2);
  });
});

describe("usePolicySchema", () => {
  it("round-trips all four flags", () => {
    const policy = {
      canUseAsInstruction: true,
      canUseAsEvidence: false,
      requiresUserConfirmation: true,
      doNotInjectAutomatically: true,
    };
    expect(usePolicySchema.parse(policy)).toEqual(policy);
  });

  it("rejects 0/1 integers (wire shape is boolean, not the storage 0/1)", () => {
    expect(() =>
      usePolicySchema.parse({
        canUseAsInstruction: 1,
        canUseAsEvidence: 1,
        requiresUserConfirmation: 0,
        doNotInjectAutomatically: 0,
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      usePolicySchema.parse({
        canUseAsInstruction: false,
        canUseAsEvidence: true,
        requiresUserConfirmation: false,
        doNotInjectAutomatically: false,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("scopeSchema", () => {
  it("round-trips project visibility with projectId", () => {
    expect(scopeSchema.parse({ visibility: "project", projectId: "keelson" })).toEqual({
      visibility: "project",
      projectId: "keelson",
    });
  });

  it("allows omitting projectId", () => {
    expect(scopeSchema.parse({ visibility: "personal" })).toEqual({
      visibility: "personal",
    });
  });

  it("rejects empty projectId", () => {
    expect(() => scopeSchema.parse({ visibility: "project", projectId: "" })).toThrow();
  });
});

describe("taskSchema", () => {
  it("round-trips a runtime + optional fields", () => {
    expect(
      taskSchema.parse({
        runtime: "workflow:classify-changes",
        taskId: "run_42",
        flowId: "flow_7",
        model: "claude-opus-4-7",
        provider: "anthropic",
      }),
    ).toMatchObject({ runtime: "workflow:classify-changes" });
  });

  it("requires runtime", () => {
    expect(() => taskSchema.parse({})).toThrow();
  });
});

describe("sourceRefSchema / artifactSchema", () => {
  it("sourceRef accepts a sourceTimestamp with offset", () => {
    expect(
      sourceRefSchema.parse({
        kind: "pr",
        uri: "https://github.com/x/y/pull/1",
        title: "Fix",
        sourceTimestamp: "2026-05-25T00:00:00-07:00",
      }),
    ).toMatchObject({ kind: "pr" });
  });

  it("artifact accepts kind+uri with optional description", () => {
    expect(artifactSchema.parse({ kind: "commit", uri: "abc1234" })).toMatchObject({
      kind: "commit",
      uri: "abc1234",
    });
  });
});

describe("memorySchema", () => {
  it("round-trips a representative fixture", () => {
    const m = makeMemory();
    expect(memorySchema.parse(m)).toMatchObject({ id: "mem_01", type: "decision" });
  });

  it("defaults sourceRefs and artifacts to empty arrays when omitted", () => {
    const { sourceRefs: _s, artifacts: _a, ...rest } = makeMemory();
    const parsed = memorySchema.parse(rest);
    expect(parsed.sourceRefs).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => memorySchema.parse({ ...makeMemory(), extra: "nope" })).toThrow();
  });

  it("rejects confidence below 0", () => {
    expect(() => memorySchema.parse(makeMemory({ confidence: -0.01 }))).toThrow();
  });

  it("rejects confidence above 1", () => {
    expect(() => memorySchema.parse(makeMemory({ confidence: 1.01 }))).toThrow();
  });

  describe("instruction-promotion gate", () => {
    it("rejects canUseAsInstruction=true with provenance=generated", () => {
      const result = memorySchema.safeParse(
        makeMemory({
          provenance: "generated",
          usePolicy: {
            canUseAsInstruction: true,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: false,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects canUseAsInstruction=true with provenance=observed", () => {
      const result = memorySchema.safeParse(
        makeMemory({
          provenance: "observed",
          usePolicy: {
            canUseAsInstruction: true,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: false,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it.each([
      "user_confirmed",
      "imported",
    ] as const)("accepts canUseAsInstruction=true with provenance=%s", (provenance) => {
      const result = memorySchema.safeParse(
        makeMemory({
          provenance,
          usePolicy: {
            canUseAsInstruction: true,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: false,
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("permits canUseAsInstruction=false with any provenance", () => {
      const result = memorySchema.safeParse(
        makeMemory({
          provenance: "generated",
          usePolicy: {
            canUseAsInstruction: false,
            canUseAsEvidence: true,
            requiresUserConfirmation: true,
            doNotInjectAutomatically: false,
          },
        }),
      );
      expect(result.success).toBe(true);
    });
  });
});

describe("recallRequestSchema", () => {
  const minimal = {
    schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
    scope: { visibility: "project" as const },
    task: { runtime: "chat" },
    query: "previous migration choices",
  };

  it("round-trips a minimal request", () => {
    expect(recallRequestSchema.parse(minimal)).toMatchObject({ query: minimal.query });
  });

  it("round-trips a full request with entities + limits", () => {
    const full = {
      ...minimal,
      entities: {
        repos: ["danielscholl/keelson"],
        files: ["apps/server/src/db/migrations.ts"],
        cves: [],
        topics: ["migrations"],
      },
      limits: { maxItems: 8, recencyDays: 30 },
    };
    expect(recallRequestSchema.parse(full).entities?.repos).toEqual(["danielscholl/keelson"]);
  });

  it("rejects wrong schemaVersion literal", () => {
    expect(() =>
      recallRequestSchema.parse({ ...minimal, schemaVersion: "keelson.memory.recall.v2" }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => recallRequestSchema.parse({ ...minimal, extra: true })).toThrow();
  });

  it("rejects empty query", () => {
    expect(() => recallRequestSchema.parse({ ...minimal, query: "" })).toThrow();
  });
});

describe("recallItemSchema", () => {
  const item = {
    memoryId: "mem_42",
    type: "decision" as const,
    summary: "s",
    content: "c",
    provenance: "user_confirmed" as const,
    usePolicy: {
      canUseAsInstruction: true,
      canUseAsEvidence: true,
      requiresUserConfirmation: false,
      doNotInjectAutomatically: false,
    },
    scope: { visibility: "project" as const },
    sourceRefs: [],
    artifacts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    rankingScore: 0.87,
  };

  it("round-trips a fixture", () => {
    expect(recallItemSchema.parse(item)).toMatchObject({ memoryId: "mem_42" });
  });

  it("rejects rankingScore > 1", () => {
    expect(() => recallItemSchema.parse({ ...item, rankingScore: 1.01 })).toThrow();
  });

  it("rejects rankingScore < 0", () => {
    expect(() => recallItemSchema.parse({ ...item, rankingScore: -0.01 })).toThrow();
  });
});

describe("recallResponseSchema", () => {
  it("round-trips an empty result set", () => {
    expect(
      recallResponseSchema.parse({
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId: "req_1",
        items: [],
        trace: { traceId: "trace_1", returned: 0 },
      }),
    ).toMatchObject({ requestId: "req_1" });
  });

  it("rejects wrong schemaVersion literal", () => {
    expect(() =>
      recallResponseSchema.parse({
        schemaVersion: "keelson.memory.recall.v1",
        requestId: "req_1",
        items: [],
        trace: { traceId: "trace_1", returned: 0 },
      }),
    ).toThrow();
  });
});

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    type: "lesson" as const,
    summary: "s",
    content: "c",
    contentHash: "sha256:abc",
    ...overrides,
  };
}

describe("writebackProvenanceSchema", () => {
  it.each(["observed", "inferred", "generated"])("accepts %s (agent-authored provenances)", (v) => {
    expect(writebackProvenanceSchema.parse(v)).toBe(v);
  });

  it.each([
    "user_confirmed",
    "imported",
    "superseded",
    "disputed",
  ])("rejects %s (review-queue / lifecycle-only provenance)", (v) => {
    expect(() => writebackProvenanceSchema.parse(v)).toThrow();
  });
});

describe("writebackMemoryDraftSchema", () => {
  it("defaults provenance to 'generated' (evidence-default invariant)", () => {
    const parsed = writebackMemoryDraftSchema.parse(makeDraft());
    expect(parsed.provenance).toBe("generated");
    expect(parsed.sourceRefs).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
  });

  it("requires contentHash (no envelope-level fallback)", () => {
    const { contentHash: _h, ...withoutHash } = makeDraft();
    expect(() => writebackMemoryDraftSchema.parse(withoutHash)).toThrow();
  });

  it.each(["observed", "inferred", "generated"] as const)("accepts provenance=%s", (provenance) => {
    expect(writebackMemoryDraftSchema.parse(makeDraft({ provenance }))).toMatchObject({
      provenance,
    });
  });

  it.each([
    "user_confirmed",
    "imported",
    "superseded",
    "disputed",
  ])("rejects provenance=%s — closes the review-bypass hole", (provenance) => {
    expect(() => writebackMemoryDraftSchema.parse(makeDraft({ provenance }))).toThrow();
  });

  it("enforces the 4 KB cap on summary", () => {
    expect(() =>
      writebackMemoryDraftSchema.parse(makeDraft({ summary: "x".repeat(MEMORY_TEXT_LIMIT + 1) })),
    ).toThrow();
  });

  it("enforces the 4 KB cap on content", () => {
    expect(() =>
      writebackMemoryDraftSchema.parse(makeDraft({ content: "x".repeat(MEMORY_TEXT_LIMIT + 1) })),
    ).toThrow();
  });

  it("rejects empty summary or content", () => {
    expect(() => writebackMemoryDraftSchema.parse(makeDraft({ summary: "" }))).toThrow();
    expect(() => writebackMemoryDraftSchema.parse(makeDraft({ content: "" }))).toThrow();
  });
});

describe("writebackRequestSchema", () => {
  const minimal = {
    schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
    idempotencyKey: "wb_1",
    task: { runtime: "workflow:classify-changes" },
    memories: [makeDraft()],
  };

  it("round-trips a single-memory request", () => {
    expect(writebackRequestSchema.parse(minimal).memories.length).toBe(1);
  });

  it("preserves distinct contentHashes across multiple memories", () => {
    const parsed = writebackRequestSchema.parse({
      ...minimal,
      memories: [
        makeDraft({ contentHash: "sha256:aaa", content: "first" }),
        makeDraft({ contentHash: "sha256:bbb", content: "second" }),
      ],
    });
    expect(parsed.memories.map((m) => m.contentHash)).toEqual(["sha256:aaa", "sha256:bbb"]);
  });

  it("requires at least one memory", () => {
    expect(() => writebackRequestSchema.parse({ ...minimal, memories: [] })).toThrow();
  });

  it("rejects an envelope-level contentHash (moved to each draft)", () => {
    expect(() =>
      writebackRequestSchema.parse({ ...minimal, contentHash: "sha256:envelope" }),
    ).toThrow();
  });

  it("rejects wrong schemaVersion literal", () => {
    expect(() =>
      writebackRequestSchema.parse({
        ...minimal,
        schemaVersion: "keelson.memory.writeback.v2",
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => writebackRequestSchema.parse({ ...minimal, extra: 1 })).toThrow();
  });
});

describe("writebackResponseSchema", () => {
  it("round-trips an empty response (all arrays default to [])", () => {
    const parsed = writebackResponseSchema.parse({
      schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
    });
    expect(parsed.written).toEqual([]);
    expect(parsed.blocked).toEqual([]);
    expect(parsed.deduped).toEqual([]);
  });

  it("round-trips a populated response", () => {
    const parsed = writebackResponseSchema.parse({
      schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
      written: [{ memoryId: "mem_1", idempotencyKey: "wb_1" }],
      blocked: [{ reason: "potential_secret", summary: "redacted" }],
      deduped: [{ memoryId: "mem_2", reason: "content_hash_collision" }],
    });
    expect(parsed.written[0]?.memoryId).toBe("mem_1");
    expect(parsed.blocked[0]?.reason).toBe("potential_secret");
  });

  it("rejects an unknown blocked reason", () => {
    expect(() =>
      writebackResponseSchema.parse({
        schemaVersion: WRITEBACK_RESPONSE_SCHEMA_VERSION,
        blocked: [{ reason: "vibes", summary: "x" }],
      }),
    ).toThrow();
  });
});

describe("reviewActionRequestSchema", () => {
  it("round-trips a fixture", () => {
    expect(
      reviewActionRequestSchema.parse({
        memoryId: "mem_1",
        action: "confirm",
        actor: "user@local",
        notes: "looks right",
      }),
    ).toMatchObject({ action: "confirm" });
  });

  it("requires memoryId, action, actor", () => {
    expect(() => reviewActionRequestSchema.parse({ action: "confirm" })).toThrow();
  });
});

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import {
  APPROVAL_ARTIFACT_MAX_CHARS,
  APPROVAL_ARTIFACTS_MAX,
  approvalArtifactPaths,
  pendingApprovalWithArtifacts,
} from "../src/approval-artifacts.ts";

describe("approvalArtifactPaths", () => {
  test("reads each referenced path once, trimming prose punctuation and wrappers", () => {
    const prompt = [
      "Approve this plan, or send changes.",
      "",
      "$ARTIFACTS_DIR/plan.md",
      "See [$ARTIFACTS_DIR/triage.md] and `$ARTIFACTS_DIR/report(1).md`.",
      "Again: $ARTIFACTS_DIR/plan.md.",
    ].join("\n");
    expect(approvalArtifactPaths(prompt)).toEqual(["plan.md", "triage.md", "report(1).md"]);
  });

  test("names nothing when the prompt references no artifact", () => {
    expect(approvalArtifactPaths("ship it?")).toEqual([]);
  });

  test("keeps at most the cap", () => {
    const prompt = Array.from({ length: 10 }, (_, i) => `$ARTIFACTS_DIR/f${i}.md`).join("\n");
    expect(approvalArtifactPaths(prompt)).toHaveLength(APPROVAL_ARTIFACTS_MAX);
  });
});

describe("pendingApprovalWithArtifacts", () => {
  test("cuts a long file to the cap and marks it truncated", () => {
    const long = "x".repeat(APPROVAL_ARTIFACT_MAX_CHARS + 10);
    const gate = pendingApprovalWithArtifacts("review", "$ARTIFACTS_DIR/plan.md", "p1", () => ({
      ok: true,
      content: long,
    }));
    expect(gate.pauseId).toBe("p1");
    expect(gate.artifacts?.[0]?.text).toHaveLength(APPROVAL_ARTIFACT_MAX_CHARS);
    expect(gate.artifacts?.[0]?.truncated).toBe(true);
  });

  test("omits artifacts for a gate that names none", () => {
    expect(
      pendingApprovalWithArtifacts("review", "ship it?", undefined, () => ({
        ok: true,
        content: "",
      })),
    ).toEqual({ nodeId: "review", prompt: "ship it?" });
  });
});

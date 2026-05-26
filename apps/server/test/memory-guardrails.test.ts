// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import type { WritebackMemoryDraft } from "@keelson/shared";
import {
  checkSize,
  detectSecret,
  evaluateDraft,
  MEMORY_BYTE_LIMIT,
  requireSourceRef,
} from "../src/memory-guardrails.ts";

function makeDraft(overrides: Partial<WritebackMemoryDraft> = {}): WritebackMemoryDraft {
  return {
    type: "lesson",
    summary: "test summary",
    content: "test content body",
    contentHash: "abc123",
    provenance: "generated",
    sourceRefs: [],
    artifacts: [],
    ...overrides,
  };
}

describe("detectSecret", () => {
  test("matches AWS access key id", () => {
    expect(detectSecret("token AKIAIOSFODNN7EXAMPLE found")).toEqual({
      blocked: true,
      reason: "potential_secret",
    });
  });

  test("does not match AKIA prefix without 16 trailing chars", () => {
    expect(detectSecret("AKIAshort here")).toBeNull();
  });

  test("matches GitHub personal access token (ghp_)", () => {
    const ghp = `ghp_${"A".repeat(36)}`;
    expect(detectSecret(`leaking ${ghp} oops`)?.reason).toBe("potential_secret");
  });

  test("matches GitHub OAuth token (gho_) and server-to-server (ghs_)", () => {
    expect(detectSecret(`gho_${"A".repeat(36)}`)?.reason).toBe("potential_secret");
    expect(detectSecret(`ghs_${"B".repeat(36)}`)?.reason).toBe("potential_secret");
  });

  test("matches JWT", () => {
    const jwt = "eyJabc123.eyJdef456.ghi-_jkl789";
    expect(detectSecret(`auth ${jwt}`)?.reason).toBe("potential_secret");
  });

  test("matches PEM private key headers", () => {
    expect(detectSecret("-----BEGIN RSA PRIVATE KEY-----\nfoo")?.reason).toBe("potential_secret");
    expect(detectSecret("-----BEGIN OPENSSH PRIVATE KEY-----")?.reason).toBe("potential_secret");
  });

  test("matches Slack tokens", () => {
    expect(detectSecret("ping xoxb-12345-abcdef")?.reason).toBe("potential_secret");
    expect(detectSecret("xoxp-1-2-3-token")?.reason).toBe("potential_secret");
  });

  test("clean text passes", () => {
    expect(detectSecret("just a normal sentence about code")).toBeNull();
  });

  test("AKIA-like string inside larger word does not false-positive", () => {
    expect(detectSecret("AKIAINSIDELONGWORDTAILING")).toBeNull();
  });
});

describe("checkSize", () => {
  test("ascii under limit passes", () => {
    expect(checkSize("hello world")).toBeNull();
  });

  test("ascii at limit passes; one byte over blocks", () => {
    expect(checkSize("a".repeat(MEMORY_BYTE_LIMIT))).toBeNull();
    expect(checkSize("a".repeat(MEMORY_BYTE_LIMIT + 1))).toEqual({
      blocked: true,
      reason: "content_too_large",
    });
  });

  test("emoji content measured in UTF-8 bytes, not UTF-16 code units", () => {
    // 😀 = 4 UTF-8 bytes, 2 UTF-16 code units
    const emojisOverLimit = Math.ceil((MEMORY_BYTE_LIMIT + 4) / 4);
    expect(checkSize("😀".repeat(emojisOverLimit))?.reason).toBe("content_too_large");
  });

  test("custom limit honored", () => {
    expect(checkSize("aaaa", 3)?.reason).toBe("content_too_large");
    expect(checkSize("aa", 3)).toBeNull();
  });
});

describe("requireSourceRef", () => {
  test("artifact_reference without sourceRef blocks", () => {
    expect(requireSourceRef(makeDraft({ type: "artifact_reference" }))?.reason).toBe(
      "missing_source_ref",
    );
  });

  test("output without sourceRef blocks", () => {
    expect(requireSourceRef(makeDraft({ type: "output" }))?.reason).toBe("missing_source_ref");
  });

  test("artifact_reference with sourceRef passes", () => {
    expect(
      requireSourceRef(
        makeDraft({
          type: "artifact_reference",
          sourceRefs: [{ kind: "pr", uri: "https://github.com/foo/bar/pull/1" }],
        }),
      ),
    ).toBeNull();
  });

  test("non-required types pass without sourceRef", () => {
    for (const type of [
      "lesson",
      "decision",
      "constraint",
      "open_question",
      "failure",
      "work_log",
    ] as const) {
      expect(requireSourceRef(makeDraft({ type }))).toBeNull();
    }
  });
});

describe("evaluateDraft (composed)", () => {
  test("returns null when no rule blocks", () => {
    expect(evaluateDraft(makeDraft())).toBeNull();
  });

  test("secret in content blocks", () => {
    expect(evaluateDraft(makeDraft({ content: "AKIAIOSFODNN7EXAMPLE" }))?.reason).toBe(
      "potential_secret",
    );
  });

  test("secret in summary blocks", () => {
    expect(evaluateDraft(makeDraft({ summary: "leaked AKIAIOSFODNN7EXAMPLE" }))?.reason).toBe(
      "potential_secret",
    );
  });

  test("missing sourceRef caught by composed evaluator", () => {
    expect(evaluateDraft(makeDraft({ type: "output" }))?.reason).toBe("missing_source_ref");
  });

  test("secret check fires before missing_source_ref", () => {
    expect(
      evaluateDraft(
        makeDraft({
          type: "output",
          sourceRefs: [],
          content: "AKIAIOSFODNN7EXAMPLE",
        }),
      )?.reason,
    ).toBe("potential_secret");
  });
});

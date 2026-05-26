// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { WritebackBlockedReason, WritebackMemoryDraft } from "@keelson/shared";

export interface GuardrailVerdict {
  blocked: true;
  reason: WritebackBlockedReason;
}

// Byte-length floor. The M2 wire schema already caps summary/content at 4096
// UTF-16 code units; this byte cap is defense in depth — emoji-heavy content
// passes the code-unit check but can exceed the storage budget.
export const MEMORY_BYTE_LIMIT = 8192 as const;

// Invariant #4 in #10: source references, not raw content. For types whose
// purpose is to point at an external artifact, we hard-require a sourceRef.
const SOURCE_REF_REQUIRED_TYPES: ReadonlySet<WritebackMemoryDraft["type"]> = new Set([
  "artifact_reference",
  "output",
]);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_classic_pat", pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "github_oauth", pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: "github_app", pattern: /\bgh[su]_[A-Za-z0-9]{36}\b/ },
  // Fine-grained PAT body is officially [A-Za-z0-9]{22}_[A-Za-z0-9]{59};
  // we allow underscore throughout to keep one regex.
  { name: "github_fine_grained_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: "pem_private_key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: "slack_token", pattern: /\bxox[bsp]-[A-Za-z0-9-]+\b/ },
];

export function detectSecret(text: string): GuardrailVerdict | null {
  for (const { pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { blocked: true, reason: "potential_secret" };
  }
  return null;
}

export function checkSize(
  text: string,
  limit: number = MEMORY_BYTE_LIMIT,
): GuardrailVerdict | null {
  if (new TextEncoder().encode(text).byteLength > limit) {
    return { blocked: true, reason: "content_too_large" };
  }
  return null;
}

export function requireSourceRef(draft: WritebackMemoryDraft): GuardrailVerdict | null {
  if (SOURCE_REF_REQUIRED_TYPES.has(draft.type) && draft.sourceRefs.length === 0) {
    return { blocked: true, reason: "missing_source_ref" };
  }
  return null;
}

// Composed evaluator — first hit wins; null means the draft passes.
export function evaluateDraft(draft: WritebackMemoryDraft): GuardrailVerdict | null {
  return (
    detectSecret(draft.content) ??
    detectSecret(draft.summary) ??
    checkSize(draft.content) ??
    checkSize(draft.summary) ??
    requireSourceRef(draft)
  );
}

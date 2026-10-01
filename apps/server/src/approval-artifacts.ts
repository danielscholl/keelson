// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRecord, RibApprovalArtifact, RibPendingApproval } from "@keelson/shared";
import type { RunArtifactRead } from "./workflows-handler.ts";

export const APPROVAL_ARTIFACTS_MAX = 4;
export const APPROVAL_ARTIFACT_MAX_CHARS = 32_000;

// The token shape the SPA's RunTrace recognizes, so a rib reads the same files the
// approval canvas opens.
const ARTIFACT_REF = /\$ARTIFACTS_DIR\/([^\s`'"]+)/g;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

// Drops trailing prose punctuation and unbalanced closers, so `[$ARTIFACTS_DIR/plan.md]`
// yields `plan.md` while `report(1).md` stays whole.
function trimRef(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s.slice(-1);
    const opener = CLOSERS[last];
    if (".,;:".includes(last) || (opener && count(s, last) > count(s, opener))) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

export function approvalArtifactPaths(prompt: string): string[] {
  const out = new Set<string>();
  for (const match of prompt.matchAll(ARTIFACT_REF)) {
    const rel = trimRef(match[1] ?? "");
    if (rel) out.add(rel);
  }
  return [...out].slice(0, APPROVAL_ARTIFACTS_MAX);
}

export function approvalArtifacts(
  prompt: string,
  read: (rel: string) => RunArtifactRead,
): RibApprovalArtifact[] {
  return approvalArtifactPaths(prompt).map((path) => {
    const file = read(path);
    if (!file.ok) return { path, error: file.error };
    return file.content.length > APPROVAL_ARTIFACT_MAX_CHARS
      ? { path, text: file.content.slice(0, APPROVAL_ARTIFACT_MAX_CHARS), truncated: true }
      : { path, text: file.content };
  });
}

export function pendingApprovalWithArtifacts(
  nodeId: string,
  prompt: string,
  pauseId: string | undefined,
  read: (rel: string) => RunArtifactRead,
): RibPendingApproval {
  const artifacts = approvalArtifacts(prompt, read);
  return {
    nodeId,
    prompt,
    ...(pauseId !== undefined ? { pauseId } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

// Where a gate's reviewer record lands in the run's artifacts dir, so the
// verdict can be opened from the trace and read by later nodes.
export function reviewerVerdictArtifactPath(nodeId: string): string {
  return `approvals/${nodeId}.reviewer.json`;
}

export function persistReviewerRecord(
  artifactsDir: string | undefined,
  nodeId: string,
  record: ApprovalRecord,
): void {
  if (artifactsDir === undefined) return;
  try {
    const path = join(artifactsDir, reviewerVerdictArtifactPath(nodeId));
    mkdirSync(join(artifactsDir, "approvals"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workflows] failed to persist reviewer record for ${nodeId}: ${msg}`);
  }
}

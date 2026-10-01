// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ApprovalRecord, ApprovalReview } from "@keelson/shared";

// One line for a gate the reviewer answered; undefined for an operator-answered
// gate so callers print nothing new for the default path.
export function formatReviewerAnswer(
  nodeId: string,
  record: ApprovalRecord | null,
): string | undefined {
  if (record === null || record.answeredBy !== "reviewer" || record.reviewerVerdict === undefined) {
    return undefined;
  }
  const v = record.reviewerVerdict;
  return `gate ${nodeId} answered by reviewer (confidence ${v.confidence}): ${v.reason}`;
}

// Lines explaining why a reviewed gate still reached the operator.
export function formatReviewLines(review: ApprovalReview | undefined): string[] {
  if (review === undefined) return [];
  if (review.reviewerVerdict !== undefined) {
    const v = review.reviewerVerdict;
    return [
      `reviewer: ${v.decision} (confidence ${v.confidence}): ${v.reason}`,
      ...(v.changes !== undefined ? [`changes: ${v.changes}`] : []),
    ];
  }
  if (review.reviewerError !== undefined)
    return [`reviewer: no usable verdict (${review.reviewerError})`];
  return [];
}

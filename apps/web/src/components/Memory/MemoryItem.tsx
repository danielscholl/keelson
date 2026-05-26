// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  INSTRUCTION_ELIGIBLE_PROVENANCES,
  type ReviewActionKind,
  type ReviewItem,
} from "@keelson/shared";
import { useState } from "react";

interface MemoryItemProps {
  item: ReviewItem;
  // Provided by the view; null while a row is mid-action so the buttons
  // disable to prevent double-click → double-fire.
  onAction: ((memoryId: string, action: ReviewActionKind) => void) | null;
  // Read-only mode hides the action bar — used by the "All" sub-tab where
  // rows have already been resolved.
  readOnly?: boolean;
}

const TYPE_LABELS: Record<ReviewItem["type"], string> = {
  decision: "decision",
  output: "output",
  lesson: "lesson",
  constraint: "constraint",
  open_question: "open question",
  failure: "failure",
  artifact_reference: "artifact ref",
  work_log: "work log",
};

const REVIEW_STATUS_LABELS: Record<ReviewItem["reviewStatus"], string> = {
  pending: "pending",
  confirmed: "confirmed",
  evidence_only: "evidence-only",
  restricted: "restricted",
  rejected: "rejected",
  stale: "stale",
  merged: "merged",
};

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderSourceRef(ref: ReviewItem["sourceRefs"][number], idx: number) {
  const label = ref.title ?? ref.uri;
  // URL-shaped uris (http/https) link out; everything else is plain text so
  // a chat_message uri like `conversation/.../message/...` doesn't 404 from
  // a click.
  const isHttp = ref.uri.startsWith("http://") || ref.uri.startsWith("https://");
  return (
    <span key={`${ref.kind}-${idx}`} className="memory-source-ref">
      <span className="memory-source-kind">{ref.kind}</span>
      {isHttp ? (
        <a href={ref.uri} target="_blank" rel="noreferrer noopener">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}

export function MemoryItem({ item, onAction, readOnly = false }: MemoryItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isPromotable = INSTRUCTION_ELIGIBLE_PROVENANCES.includes(item.provenance);
  const policyBadge = item.usePolicy.canUseAsInstruction
    ? { label: "★ instruction", className: "memory-pill memory-pill-instr" }
    : isPromotable
      ? { label: "★ promotable", className: "memory-pill memory-pill-prom" }
      : { label: "⚠ evidence-only", className: "memory-pill memory-pill-ev" };

  const dispatch = (action: ReviewActionKind) => {
    if (!onAction) return;
    onAction(item.memoryId, action);
  };

  return (
    <li className={`memory-item${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="memory-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="memory-chevron" aria-hidden>
          {expanded ? "▼" : "▶"}
        </span>
        <span className="memory-summary">{item.summary}</span>
        <span className="memory-chips">
          <span className="memory-pill memory-pill-type">{TYPE_LABELS[item.type]}</span>
          <span className="memory-pill memory-pill-prov">{item.provenance}</span>
          <span className={policyBadge.className}>{policyBadge.label}</span>
          <span className="memory-pill memory-pill-status">
            {REVIEW_STATUS_LABELS[item.reviewStatus]}
          </span>
          <span className="memory-meta">{item.runtime}</span>
          <span className="memory-meta">{formatAge(item.createdAt)}</span>
        </span>
      </button>

      {expanded && (
        <div className="memory-detail">
          <pre className="memory-content">{item.content}</pre>

          {item.sourceRefs.length > 0 && (
            <div className="memory-detail-row">
              <span className="memory-detail-label">Sources</span>
              <span className="memory-detail-value">{item.sourceRefs.map(renderSourceRef)}</span>
            </div>
          )}

          <div className="memory-detail-row">
            <span className="memory-detail-label">Origin</span>
            <span className="memory-detail-value">
              <code>{item.runtime}</code>
              {item.taskId && (
                <>
                  {" · "}
                  <code>{item.taskId}</code>
                </>
              )}
              {item.model && (
                <>
                  {" · "}
                  <code>{item.model}</code>
                </>
              )}
              {item.provider && (
                <>
                  {" · "}
                  <code>{item.provider}</code>
                </>
              )}
            </span>
          </div>

          {item.confidence !== undefined && (
            <div className="memory-detail-row">
              <span className="memory-detail-label">Confidence</span>
              <span className="memory-detail-value">{item.confidence.toFixed(2)}</span>
            </div>
          )}

          {item.staleAfter !== undefined && (
            <div className="memory-detail-row">
              <span className="memory-detail-label">Stale after</span>
              <span className="memory-detail-value">{item.staleAfter}</span>
            </div>
          )}

          {!readOnly && (
            <div className="memory-actions">
              <button
                type="button"
                className="btn-action btn-action-confirm"
                disabled={!onAction}
                onClick={() => dispatch("confirm")}
                title={
                  isPromotable
                    ? "Confirm — promotes to instruction"
                    : "Confirm — promotes provenance to user_confirmed (becomes instruction-eligible)"
                }
              >
                Confirm
              </button>
              <button
                type="button"
                className="btn-action"
                disabled={!onAction}
                onClick={() => dispatch("evidence_only")}
                title="Keep as evidence only — never injected as instruction"
              >
                Evidence-only
              </button>
              <button
                type="button"
                className="btn-action"
                disabled={!onAction}
                onClick={() => dispatch("restrict")}
                title="Restrict — flagged do-not-auto-inject"
              >
                Restrict
              </button>
              <button
                type="button"
                className="btn-action btn-action-reject"
                disabled={!onAction}
                onClick={() => dispatch("reject")}
                title="Reject — lifecycle:rejected"
              >
                Reject
              </button>
              <button
                type="button"
                className="btn-action btn-action-secondary"
                disabled={!onAction}
                onClick={() => dispatch("mark_stale")}
                title="Mark stale — lifecycle:stale"
              >
                Mark stale
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  MEMORY_TEXT_LIMIT,
  type MemoryType,
  type RememberChatMessageRequest,
  type ScopeVisibility,
} from "@keelson/shared";
import { useEffect, useState } from "react";

interface SaveToMemoryModalProps {
  open: boolean;
  conversationId: string;
  messageId: string;
  // Pre-fill from the chat message the operator clicked Save on.
  initialContent: string;
  // Role drives the default memoryType heuristic — assistant turns are
  // typically lessons; user turns are typically constraints / preferences.
  role: "user" | "assistant";
  onClose: () => void;
  onSubmit: (draft: RememberChatMessageRequest) => Promise<void>;
  // Disable the submit button while the request is in flight so a double-
  // click can't fire two requests.
  submitting: boolean;
}

const TYPE_OPTIONS: { value: MemoryType; label: string }[] = [
  { value: "lesson", label: "lesson" },
  { value: "constraint", label: "constraint" },
  { value: "decision", label: "decision" },
  { value: "output", label: "output" },
  { value: "open_question", label: "open question" },
  { value: "failure", label: "failure" },
  { value: "artifact_reference", label: "artifact ref" },
  { value: "work_log", label: "work log" },
];

// First non-empty line, capped to a sensible summary length. The 80-char cap
// here is UI-visible only; the wire limit is MEMORY_TEXT_LIMIT.
function deriveSummary(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? content.trim();
  return firstLine.slice(0, 80);
}

export function SaveToMemoryModal(props: SaveToMemoryModalProps) {
  const { open, conversationId, messageId, initialContent, role, onClose, onSubmit, submitting } =
    props;

  const [type, setType] = useState<MemoryType>(role === "assistant" ? "lesson" : "constraint");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [scopeVisibility, setScopeVisibility] = useState<ScopeVisibility>("project");

  // Reset state every time the modal re-opens against a different message,
  // so stale edits from a previous Save don't bleed into the next one.
  useEffect(() => {
    if (!open) return;
    const trimmed = initialContent.trim().slice(0, MEMORY_TEXT_LIMIT);
    setContent(trimmed);
    setSummary(deriveSummary(trimmed));
    setType(role === "assistant" ? "lesson" : "constraint");
    setScopeVisibility("project");
  }, [open, initialContent, role]);

  // Escape closes the modal — pairs with the backdrop click. Submitting
  // suppresses the close so a mid-flight network error doesn't lose the
  // operator's edits.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const canSubmit = summary.trim().length > 0 && content.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const draft: RememberChatMessageRequest = {
      type,
      summary: summary.trim(),
      content: content.trim(),
      scope: { visibility: scopeVisibility },
    };
    await onSubmit(draft);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes via the document-level handler in useEffect above
    <div
      className="save-memory-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Save to memory"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="save-memory-modal">
        <h2>Save to memory</h2>
        <div className="save-memory-sub">
          Saved as <strong>pending</strong> with provenance <code>observed</code>. Confirm it in the
          Memory tab to promote to instruction.
        </div>

        <div className="save-memory-field">
          <label htmlFor="save-memory-summary">Summary</label>
          <input
            id="save-memory-summary"
            type="text"
            value={summary}
            maxLength={MEMORY_TEXT_LIMIT}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One-line summary"
            disabled={submitting}
          />
        </div>

        <div className="save-memory-field">
          <label htmlFor="save-memory-content">Content</label>
          <textarea
            id="save-memory-content"
            value={content}
            maxLength={MEMORY_TEXT_LIMIT}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Body — what to remember"
            disabled={submitting}
          />
        </div>

        <div className="save-memory-field">
          <label htmlFor="save-memory-type">Type</label>
          <select
            id="save-memory-type"
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType)}
            disabled={submitting}
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="save-memory-field">
          <label htmlFor="save-memory-scope">Scope</label>
          <select
            id="save-memory-scope"
            value={scopeVisibility}
            onChange={(e) => setScopeVisibility(e.target.value as ScopeVisibility)}
            disabled={submitting}
          >
            <option value="project">project (default)</option>
            <option value="personal">personal (operator-scoped)</option>
          </select>
        </div>

        <div className="save-memory-field">
          <div className="save-memory-source-label">Source ref</div>
          <div className="save-memory-source">
            chat_message · conversation/{conversationId}/message/{messageId}
          </div>
        </div>

        <div className="save-memory-actions">
          <button
            type="button"
            className="btn-action btn-action-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-action btn-action-confirm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

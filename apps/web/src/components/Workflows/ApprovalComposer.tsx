// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type KeyboardEvent, useState } from "react";

export interface ApprovalComposerProps {
  // Just for callers that want a stable key per pause; not used internally.
  nodeId: string;
  onSubmit: (text: string) => Promise<void>;
  onAbandon: () => Promise<void>;
  // "dock" is the review-decision dock docked in the canvas footer (approval is
  // the dominant action, abandon is muted); "inline" is the compact trace
  // fallback shown when the canvas is dismissed.
  variant?: "inline" | "dock";
}

// Free-text composer rendered inside the Trace pane's approval callout when a
// run is paused on an `approval` node. Send routes the typed text through;
// the "Approve & continue" shortcut sends the literal "approve" so downstream
// `when:` rules can branch on it.
export function ApprovalComposer({
  nodeId,
  onSubmit,
  onAbandon,
  variant = "inline",
}: ApprovalComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = text.trim();
  const canSend = !busy && trimmed.length > 0;

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setText("");
    } catch (err) {
      // The hook surfaces resume errors through its own state; log here for
      // dev visibility without doubling up on toasts.
      console.warn("[approval-composer] submit failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void submit(trimmed);
    }
  };

  const onApproveClick = () => {
    if (!busy) void submit("approve");
  };

  const onAbandonClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAbandon();
    } catch (err) {
      console.warn("[approval-composer] abandon failed:", err);
    } finally {
      setBusy(false);
    }
  };

  // Shared in both variants: an input card with an embedded Send (chat-composer
  // pattern), then a decision row where Approve & continue is the primary action
  // (far right) and Abandon is the muted/destructive escape.
  const inputCard = (
    <div className="approval-input">
      <textarea
        className="approval-input-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type requested changes or notes… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={busy}
        aria-label="Workflow approval response"
      />
      {trimmed.length > 0 && (
        <button
          type="button"
          className="chat-send"
          onClick={() => void submit(trimmed)}
          disabled={!canSend}
        >
          Send
        </button>
      )}
    </div>
  );
  const decisionRow = (
    <div className="approval-actions">
      <button type="button" className="btn abandon" onClick={onAbandonClick} disabled={busy}>
        ✕ Abandon run
      </button>
      <button type="button" className="btn primary" onClick={onApproveClick} disabled={busy}>
        ✓ Approve &amp; continue
      </button>
    </div>
  );

  if (variant === "dock") {
    return (
      <div className="approval-dock" data-node-id={nodeId}>
        <div className="approval-dock-head">
          <span className="approval-dock-title">Review plan</span>
          <span className="approval-dock-sub">
            Approve this plan to continue, or send requested changes.
          </span>
        </div>
        {inputCard}
        {decisionRow}
      </div>
    );
  }

  return (
    <div className="approval-composer" data-node-id={nodeId}>
      {inputCard}
      {decisionRow}
    </div>
  );
}

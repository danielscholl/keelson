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
}

// Free-text composer rendered inside the Trace pane's approval callout when a
// run is paused on an `approval` node. Send routes the typed text through;
// the "Approve & continue" shortcut sends the literal "approve" so downstream
// `when:` rules can branch on it.
export function ApprovalComposer({ nodeId, onSubmit, onAbandon }: ApprovalComposerProps) {
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

  return (
    <div className="approval-composer" data-node-id={nodeId}>
      <textarea
        className="approval-composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a response… (Enter to send, Shift+Enter for newline)"
        rows={2}
        disabled={busy}
        aria-label="Workflow approval response"
      />
      <div className="approval-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => void submit(trimmed)}
          disabled={!canSend}
        >
          Send
        </button>
        <button type="button" className="btn approve" onClick={onApproveClick} disabled={busy}>
          ✓ Approve &amp; continue
        </button>
        <button type="button" className="btn danger" onClick={onAbandonClick} disabled={busy}>
          ✕ Abandon run
        </button>
      </div>
    </div>
  );
}

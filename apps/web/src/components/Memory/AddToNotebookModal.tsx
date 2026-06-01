// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useState } from "react";

// Mirrors the server's DEFAULT_NOTEBOOK_SECTION; the one-click path omits the
// section and lets the server default, so this is only the modal's prefill.
const DEFAULT_SECTION = "Log";
const SECTION_SUGGESTIONS = ["Log", "Conventions", "Gotchas", "Decisions", "Glossary"];

interface AddToNotebookModalProps {
  open: boolean;
  // Pre-fill from the chat message the operator clicked Edit on.
  initialEntry: string;
  onClose: () => void;
  onSubmit: (entry: string, section: string) => Promise<void>;
  // Disable submit while the request is in flight so a double-click can't fire
  // two appends.
  submitting: boolean;
}

export function AddToNotebookModal(props: AddToNotebookModalProps) {
  const { open, initialEntry, onClose, onSubmit, submitting } = props;

  const [entry, setEntry] = useState("");
  const [section, setSection] = useState(DEFAULT_SECTION);

  // Reset every time the modal re-opens against a different message so stale
  // edits don't bleed into the next add.
  useEffect(() => {
    if (!open) return;
    setEntry(initialEntry.trim());
    setSection(DEFAULT_SECTION);
  }, [open, initialEntry]);

  // Escape closes — pairs with the backdrop click. Submitting suppresses close
  // so a mid-flight error doesn't lose the operator's edits.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const canSubmit = entry.trim().length > 0 && section.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit(entry.trim(), section.trim());
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes via the document-level handler in useEffect above
    <div
      className="save-memory-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add to notebook"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="save-memory-modal">
        <h2>Add to notebook</h2>
        <div className="save-memory-sub">
          Appended as a dated bullet to the project notebook — always-on context, editable in the
          Memory tab. Not the governed memory ledger.
        </div>

        <div className="save-memory-field">
          <label htmlFor="notebook-section">Section</label>
          <input
            id="notebook-section"
            type="text"
            value={section}
            list="notebook-section-suggestions"
            onChange={(e) => setSection(e.target.value)}
            placeholder={DEFAULT_SECTION}
            disabled={submitting}
          />
          <datalist id="notebook-section-suggestions">
            {SECTION_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="save-memory-field">
          <label htmlFor="notebook-entry">Entry</label>
          <textarea
            id="notebook-entry"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="One line — what to remember about this project"
            disabled={submitting}
          />
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
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

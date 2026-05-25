// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Confirmation modal with two modes:
//   - "simple": one-line proceed / cancel.
//   - "typed":  user must type a literal value (e.g. a destination name)
//               before Confirm enables. Use for destructive operations.

import { useCallback, useEffect, useRef, useState } from "react";

export type ConfirmModalMode =
  | { kind: "simple" }
  | { kind: "typed"; expectedValue: string; label: string };

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  mode: ConfirmModalMode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  mode,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps): React.ReactElement | null {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset typed-text every open transition so a prior session's value can't
  // leak into a fresh confirmation — without this, a user could cancel
  // mid-typing and re-open to one-click confirm.
  useEffect(() => {
    if (open) {
      setTyped("");
      // Autofocus the typed input or the confirm button so the user can drive
      // the modal entirely from the keyboard.
      const t = setTimeout(() => {
        if (mode.kind === "typed") inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, mode.kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  const confirmEnabled =
    mode.kind === "simple" ? true : typed === mode.expectedValue;

  const handleConfirm = useCallback(() => {
    if (!confirmEnabled) return;
    onConfirm();
  }, [confirmEnabled, onConfirm]);

  if (!open) return null;

  return (
    <>
      <div className="confirm-backdrop" onClick={onCancel} aria-hidden="true" />
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <header className="confirm-modal-header">
          <span id="confirm-modal-title" className="confirm-modal-title">
            {title}
          </span>
          <button
            type="button"
            className="confirm-modal-close"
            onClick={onCancel}
            aria-label="Cancel"
          >
            ×
          </button>
        </header>
        <div className="confirm-modal-body">{body}</div>
        {mode.kind === "typed" && (
          <div className="confirm-modal-typed">
            <label className="confirm-modal-typed-label">
              {mode.label}
              <input
                ref={inputRef}
                type="text"
                className="confirm-modal-typed-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConfirm();
                }}
                spellCheck={false}
                autoComplete="off"
                aria-label={mode.label}
              />
            </label>
            <div className="confirm-modal-typed-hint">
              Type <code>{mode.expectedValue}</code> to enable {confirmLabel}.
            </div>
          </div>
        )}
        <footer className="confirm-modal-footer">
          <button
            type="button"
            className="confirm-modal-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-modal-confirm${danger ? " danger" : ""}`}
            onClick={handleConfirm}
            disabled={!confirmEnabled}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </>
  );
}

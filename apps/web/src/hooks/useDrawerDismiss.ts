// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { type RefObject, useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open drawers, oldest first. A drawer can open another over itself (the run
// drawer's trace opens a canvas on ⤢), and every drawer listens on `document`,
// so without this one keypress would reach the whole stack instead of only the
// topmost dialog.
const openDrawers: string[] = [];

export interface DrawerDismiss {
  // Attach to the dialog element — bounds the focus trap.
  dialogRef: RefObject<HTMLElement | null>;
  // Attach to the close button — receives focus on open.
  closeRef: RefObject<HTMLButtonElement | null>;
}

// The dismiss + focus contract every app drawer shares: Escape closes, focus
// moves to the close button on open and returns to the opener on unmount, and
// Tab cycles within the dialog. Callers must only mount the hook's host while
// the drawer is open — mount/unmount is what brackets the focus restore.
export function useDrawerDismiss(onClose: () => void): DrawerDismiss {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const token = useId();

  useEffect(() => {
    openDrawers.push(token);
    return () => {
      const i = openDrawers.lastIndexOf(token);
      if (i !== -1) openDrawers.splice(i, 1);
    };
  }, [token]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Both keys are handled at document scope rather than on the dialog: the page
  // beneath isn't inert, so once focus escapes the dialog the keydown is
  // dispatched from a background element and never reaches a dialog-scoped
  // handler — exactly the case the trap has to recover from.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openDrawers[openDrawers.length - 1] !== token) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      // Focus outside the dialog is a boundary in both directions.
      const outside = !root.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, token]);

  return { dialogRef, closeRef };
}

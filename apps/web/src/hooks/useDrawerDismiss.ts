// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type React from "react";
import { type RefObject, useCallback, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DrawerDismiss {
  // Attach to the dialog element — bounds the focus trap.
  dialogRef: RefObject<HTMLElement | null>;
  // Attach to the close button — receives focus on open.
  closeRef: RefObject<HTMLButtonElement | null>;
  // Attach to the dialog element's onKeyDown.
  onKeyDown: (e: React.KeyboardEvent) => void;
}

// The dismiss + focus contract every app drawer shares: Escape closes, focus
// moves to the close button on open and returns to the opener on unmount, and
// Tab cycles within the dialog. Callers must only mount the hook's host while
// the drawer is open — mount/unmount is what brackets the focus restore.
export function useDrawerDismiss(onClose: () => void): DrawerDismiss {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // The page beneath the drawer isn't inert, so without this Tab would walk
  // focus to controls hidden behind it.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return { dialogRef, closeRef, onKeyDown };
}

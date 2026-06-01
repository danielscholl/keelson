// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useState } from "react";
import { appendProjectNotebook, putProjectNotebook } from "../api.ts";
import { useToast } from "../components/Toast.tsx";

export interface NotebookAppend {
  // Appends to the active project's notebook and surfaces an Undo toast that
  // PUTs the pre-append content back (best-effort, last-write-wins — fine for a
  // local single-user notebook). Resolves true on success.
  appendWithUndo: (entry: string, section?: string) => Promise<boolean>;
  // In-flight flag for disabling the trigger buttons / modal submit.
  saving: boolean;
}

export function useNotebookAppend(activeProjectId: string | null): NotebookAppend {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const appendWithUndo = useCallback(
    async (entry: string, section?: string): Promise<boolean> => {
      if (!activeProjectId) {
        toast.push({ kind: "error", message: "Pick a project in Chat to give it a notebook." });
        return false;
      }
      const projectId = activeProjectId;
      setSaving(true);
      try {
        const res = await appendProjectNotebook(projectId, entry, section);
        const previous = res.previousContent;
        toast.push({
          kind: "ok",
          message: "Added to notebook.",
          action: {
            label: "Undo",
            onClick: () => {
              void putProjectNotebook(projectId, previous).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                toast.push({ kind: "error", message: `Undo failed: ${msg}` });
              });
            },
          },
        });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `Add to notebook failed: ${msg}` });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [activeProjectId, toast],
  );

  return { appendWithUndo, saving };
}

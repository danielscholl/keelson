// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { DEFAULT_PROJECT_NAME, type Project } from "@keelson/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteProject, updateProject } from "../../api.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";

interface ProjectPickerPopoverProps {
  popoverId: string;
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (id: string) => void;
  onProjectUpdated: (project: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}

export function ProjectPickerPopover({
  popoverId,
  projects,
  activeProjectId,
  onSelect,
  onProjectUpdated,
  onProjectDeleted,
}: ProjectPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const trigger = document.querySelector<HTMLElement>(`[popovertarget="${popoverId}"]`);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const margin = 6;
    const openDown = spaceBelow >= 240 || spaceBelow >= spaceAbove;
    if (openDown) {
      popoverEl.style.top = `${Math.round(rect.bottom + margin)}px`;
      popoverEl.style.bottom = "auto";
      popoverEl.style.maxHeight = `${Math.max(180, Math.round(spaceBelow - margin * 2))}px`;
    } else {
      popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
      popoverEl.style.top = "auto";
      popoverEl.style.maxHeight = `${Math.max(180, Math.round(spaceAbove - margin * 2))}px`;
    }
    popoverEl.style.left = `${Math.round(rect.left)}px`;
    popoverEl.style.minWidth = `${Math.max(320, Math.round(rect.width))}px`;
  }, [popoverId]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onToggle = (e: Event) => {
      const evt = e as ToggleEvent;
      if (evt.newState === "open") {
        reposition();
        setEditingId(null);
      }
    };
    popoverEl.addEventListener("toggle", onToggle);
    return () => popoverEl.removeEventListener("toggle", onToggle);
  }, [reposition]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onResize = () => {
      if (!popoverEl.matches(":popover-open")) return;
      reposition();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reposition]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      popoverRef.current?.hidePopover();
    },
    [onSelect],
  );

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="model-picker-popover"
      role="dialog"
      aria-label="Pick a project"
    >
      <div className="model-picker-popover-body">
        {projects.length === 0 ? (
          <div className="model-picker-popover-empty">
            No projects yet. Use <code>/project &lt;url-or-path&gt;</code> in chat to add one.
          </div>
        ) : (
          <div className="model-picker-popover-section">
            <div className="model-picker-popover-section-rows">
              {projects.map((project) =>
                editingId === project.id ? (
                  <ProjectEditRow
                    key={project.id}
                    project={project}
                    onCancel={() => setEditingId(null)}
                    onSaved={(updated) => {
                      onProjectUpdated(updated);
                      setEditingId(null);
                    }}
                    onDeleted={(deletedId) => {
                      onProjectDeleted(deletedId);
                      setEditingId(null);
                    }}
                  />
                ) : (
                  <ProjectRow
                    key={project.id}
                    popoverId={popoverId}
                    project={project}
                    isActive={activeProjectId === project.id}
                    onSelect={() => handleSelect(project.id)}
                    onEdit={() => setEditingId(project.id)}
                  />
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ProjectRowProps {
  popoverId: string;
  project: Project;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

function ProjectRow({ popoverId, project, isActive, onSelect, onEdit }: ProjectRowProps) {
  // Default project has no editable settings — it IS the workspace, not a
  // user project. The slash-command `/project layout` still works for the
  // rare case someone needs to change layout on a real project.
  const isDefault = project.name === DEFAULT_PROJECT_NAME;
  return (
    <div className={`model-picker-popover-row${isActive ? " active" : ""}`}>
      {isDefault ? (
        <span
          className="model-picker-popover-fav model-picker-popover-fav--passive"
          aria-hidden="true"
        />
      ) : (
        <button
          type="button"
          className="model-picker-popover-fav"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="Edit project"
          title="Rename or remove"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      )}
      <button
        type="button"
        className="model-picker-popover-pick"
        onClick={onSelect}
        popoverTarget={popoverId}
        popoverTargetAction="hide"
        title={project.rootPath}
      >
        <span className="model-picker-popover-pick-id">{project.name}</span>
        <span className="model-picker-popover-pick-meta">{project.worktreeLayout}</span>
      </button>
    </div>
  );
}

interface ProjectEditRowProps {
  project: Project;
  onCancel: () => void;
  onSaved: (project: Project) => void;
  onDeleted: (projectId: string) => void;
}

function ProjectEditRow({ project, onCancel, onSaved, onDeleted }: ProjectEditRowProps) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleSave = useCallback(async () => {
    if (name === project.name) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProject(project.id, { name });
      onSaved(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [name, onCancel, onSaved, project.id, project.name]);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    setConfirmingDelete(false);
    setBusy(true);
    setError(null);
    try {
      await deleteProject(project.id);
      onDeleted(project.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, onDeleted, project.id]);

  return (
    <div className="model-picker-popover-row project-edit-row">
      <div className="project-edit-fields">
        <label className="project-edit-label">
          Name
          <input
            type="text"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            aria-label="Project name"
          />
        </label>
        {error && <div className="project-edit-error">{error}</div>}
        <div className="project-edit-actions">
          <button
            type="button"
            className="project-edit-delete"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
          >
            Remove
          </button>
          <span className="project-edit-actions-spacer" />
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <ConfirmModal
        open={confirmingDelete}
        title="Remove project"
        body={
          <>
            Remove <strong>{project.name}</strong> from Keelson? This forgets the project in the
            database — the repo on disk at <code>{project.rootPath}</code> is not touched.
          </>
        }
        mode={{ kind: "simple" }}
        confirmLabel="Remove"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

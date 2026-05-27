// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Project } from "@keelson/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { createProject, deleteProject, listProjects } from "../api.ts";
import { useToast } from "../components/Toast.tsx";

interface AddFormState {
  name: string;
  rootPath: string;
  submitting: boolean;
}

const INITIAL_FORM: AddFormState = { name: "", rootPath: "", submitting: false };

export function Projects() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<AddFormState>(INITIAL_FORM);

  const refresh = useCallback(async () => {
    try {
      const next = await listProjects();
      setProjects(next);
      setLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (form.submitting) return;
      const name = form.name.trim();
      const rootPath = form.rootPath.trim();
      if (name.length === 0 || rootPath.length === 0) {
        toast.push({ kind: "error", message: "Both name and rootPath are required" });
        return;
      }
      setForm((prev) => ({ ...prev, submitting: true }));
      try {
        const project = await createProject({ name, rootPath });
        toast.push({ kind: "info", message: `Added project '${project.name}'` });
        setForm(INITIAL_FORM);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `Couldn't add project: ${msg}` });
        setForm((prev) => ({ ...prev, submitting: false }));
      }
    },
    [form, refresh, toast],
  );

  const handleDelete = useCallback(
    async (project: Project) => {
      const confirmed = window.confirm(
        `Remove project '${project.name}'? Existing runs that reference it remain in history but can't be re-run against this pointer.`,
      );
      if (!confirmed) return;
      try {
        await deleteProject(project.id);
        toast.push({ kind: "info", message: `Removed project '${project.name}'` });
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `Couldn't remove project: ${msg}` });
      }
    },
    [refresh, toast],
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Projects</h1>
        <span className="page-sub">
          Named pointers to local directories that workflow runs target
        </span>
      </div>

      <form className="projects-add-form" onSubmit={handleSubmit}>
        <div className="projects-form-row">
          <label className="projects-form-field">
            <span className="projects-form-label">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="work-mono"
              disabled={form.submitting}
              autoComplete="off"
            />
          </label>
          <label className="projects-form-field projects-form-field--grow">
            <span className="projects-form-label">Root path</span>
            <input
              type="text"
              value={form.rootPath}
              onChange={(e) => setForm((prev) => ({ ...prev, rootPath: e.target.value }))}
              placeholder="/Users/me/source/work-mono"
              disabled={form.submitting}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="submit"
            className="btn primary"
            disabled={
              form.submitting || form.name.trim().length === 0 || form.rootPath.trim().length === 0
            }
          >
            {form.submitting ? "Adding…" : "Add project"}
          </button>
        </div>
      </form>

      {loadError && (
        <div className="empty-state" style={{ marginTop: 14 }}>
          <div className="empty-state-icon">⚠</div>
          <div className="empty-state-title">Couldn't load projects</div>
          <div className="empty-state-body">{loadError}</div>
        </div>
      )}

      {!loadError && projects !== null && projects.length === 0 && (
        <div className="empty-state" style={{ marginTop: 14 }}>
          <div className="empty-state-icon">📁</div>
          <div className="empty-state-title">No projects yet</div>
          <div className="empty-state-body">
            Add a project above to point workflow runs at a local directory.
          </div>
        </div>
      )}

      {projects && projects.length > 0 && (
        <ul className="projects-list">
          {projects.map((project) => (
            <li key={project.id} className="projects-item">
              <div className="projects-item-main">
                <span className="projects-item-name">{project.name}</span>
                <code className="projects-item-path">{project.rootPath}</code>
              </div>
              <button
                type="button"
                className="btn danger"
                onClick={() => void handleDelete(project)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { Project } from "@keelson/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listProjects } from "../api.ts";

const ACTIVE_KEY = "keelson.activeProjectId";

function readStoredId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeStoredId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Quota or disabled storage — non-fatal.
  }
}

let currentActiveId: string | null = readStoredId();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return currentActiveId;
}

function setActiveId(next: string | null): void {
  if (next === currentActiveId) return;
  currentActiveId = next;
  writeStoredId(next);
  for (const l of listeners) l();
}

export interface ActiveProjectState {
  projects: Project[];
  activeProject: Project | null;
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refresh: () => Promise<void>;
  error: string | null;
  loading: boolean;
}

let cachedProjects: Project[] | null = null;
const projectListeners = new Set<() => void>();

function subscribeProjects(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

function getProjectsSnapshot(): Project[] | null {
  return cachedProjects;
}

function setProjects(next: Project[]): void {
  cachedProjects = next;
  for (const l of projectListeners) l();
}

let inflight: Promise<Project[]> | null = null;
// Monotonic generation: only the latest started fetch is allowed to update
// `cachedProjects`. An earlier non-forced fetch resolving after a forced
// refresh must NOT overwrite the post-mutation cache.
let latestGen = 0;
async function fetchProjects({ force = false }: { force?: boolean } = {}): Promise<Project[]> {
  if (!force && inflight) return inflight;
  const gen = ++latestGen;
  const promise = listProjects()
    .then((projects) => {
      if (gen === latestGen) setProjects(projects);
      return projects;
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  if (!force) inflight = promise;
  return promise;
}

export function useActiveProject(): ActiveProjectState {
  const activeProjectId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const projects = useSyncExternalStore(
    subscribeProjects,
    getProjectsSnapshot,
    getProjectsSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(cachedProjects === null);

  useEffect(() => {
    if (cachedProjects !== null) return;
    setLoading(true);
    fetchProjects()
      .then(() => setError(null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const list = projects ?? [];
  const fallback = list.find((p) => p.name === "default") ?? list[0] ?? null;
  const activeProject =
    (activeProjectId ? list.find((p) => p.id === activeProjectId) : null) ?? fallback;
  // Stored id wins until the project list resolves; a chat send during the
  // initial load otherwise binds the conversation to the default project
  // and diverges from the chip the user reloaded with.
  const projectsLoaded = projects !== null;
  const resolvedActiveProjectId =
    !projectsLoaded && activeProjectId !== null ? activeProjectId : (activeProject?.id ?? null);

  const setActiveProject = useCallback((id: string | null) => {
    setActiveId(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      await fetchProjects({ force: true });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    projects: list,
    activeProject,
    activeProjectId: resolvedActiveProjectId,
    setActiveProject,
    refresh,
    error,
    loading,
  };
}

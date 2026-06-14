// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { CreateProjectBody, ListProjectsResponse, Project } from "@keelson/shared";
import { normalizeBase, originHeader } from "./base.ts";
import { HttpError } from "./workflow-client.ts";

function defaultHeaders(baseUrl: string): Record<string, string> {
  return { accept: "application/json", origin: originHeader(baseUrl) };
}

interface ErrorBody {
  error?: string;
}

async function errorMessage(res: Response, label: string): Promise<string> {
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Body wasn't JSON; fall back to status text.
  }
  return `${label} failed: ${res.status} ${res.statusText}`;
}

export async function listProjects(baseUrl: string): Promise<Project[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/projects`, {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, "GET /api/projects"));
  const body = (await res.json()) as ListProjectsResponse;
  return body.projects;
}

export async function createProject(baseUrl: string, input: CreateProjectBody): Promise<Project> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/projects`, {
    method: "POST",
    headers: { ...defaultHeaders(baseUrl), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, "POST /api/projects"));
  const body = (await res.json()) as { project: Project };
  return body.project;
}

export async function deleteProject(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await errorMessage(res, `DELETE /api/projects/${id}`));
  }
}

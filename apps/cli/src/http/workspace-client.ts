// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { normalizeBase, originHeader } from "./base.ts";
import { HttpError } from "./workflow-client.ts";

export interface WorkspaceLeaseRecord {
  id: string;
  projectId: string | null;
  purpose: string;
  owner: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
}

function defaultHeaders(baseUrl: string): Record<string, string> {
  return { accept: "application/json", origin: originHeader(baseUrl) };
}

export async function listWorkspaceLeases(baseUrl: string): Promise<WorkspaceLeaseRecord[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/workspaces/leases`, {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, `GET /api/workspaces/leases failed: ${res.status}`);
  const body = (await res.json()) as { leases?: unknown };
  if (!Array.isArray(body.leases)) return [];
  return body.leases.filter((lease): lease is WorkspaceLeaseRecord => {
    if (typeof lease !== "object" || lease === null) return false;
    const row = lease as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      (typeof row.projectId === "string" || row.projectId === null) &&
      typeof row.purpose === "string" &&
      typeof row.owner === "string" &&
      typeof row.branch === "string" &&
      typeof row.worktreePath === "string" &&
      typeof row.createdAt === "string"
    );
  });
}

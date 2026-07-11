// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Project, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import type { ProjectsStore } from "./projects-store.ts";
import { emitResult } from "./workflow-tools.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

export interface CreateWorkspaceToolsDeps {
  manager: WorkspaceManager;
  projectsStore: Pick<ProjectsStore, "get" | "getByName">;
}

const leaseInputSchema = z.object({
  project: z.string().min(1),
  purpose: z.string().min(1),
  branch: z.string().min(1).optional(),
});

const releaseInputSchema = z.object({
  id: z.string().min(1),
});

function resolveProjectSelection(
  projectsStore: Pick<ProjectsStore, "get" | "getByName">,
  selector: string,
): { ok: true; project: Project } | { ok: false; message: string } {
  const projectId = selector.trim();
  if (projectId.length === 0) {
    return { ok: false, message: "invalid project selector: empty" };
  }
  const byId = projectsStore.get(projectId);
  const byName = projectsStore.getByName(projectId);
  if (byId && byName && byId.id !== byName.id) {
    return {
      ok: false,
      message: `project selector "${selector}" is ambiguous; use project id "${byId.id}" or exact name "${byName.name}"`,
    };
  }
  if (byId) return { ok: true, project: byId };
  if (byName) return { ok: true, project: byName };
  return {
    ok: false,
    message: `unknown project "${selector}". Use a registered project id or exact project name.`,
  };
}

export function createWorkspaceTools({
  manager,
  projectsStore,
}: CreateWorkspaceToolsDeps): ToolDefinition[] {
  const workspaceLease: ToolDefinition = {
    name: "workspace_lease",
    description:
      "Create an isolated git worktree checkout for a registered project, with dependencies installed when applicable. Use this before mutation-heavy tool work so changes do not clobber the live project root. Release it with workspace_release when finished.",
    inputSchema: leaseInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = leaseInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const selectedProject = resolveProjectSelection(projectsStore, parsed.data.project);
      if (!selectedProject.ok) {
        emitResult(ctx, selectedProject.message, true);
        return;
      }
      try {
        const lease = await manager.acquire({
          projectId: selectedProject.project.id,
          purpose: parsed.data.purpose,
          owner: "tool",
          abortSignal: ctx.abortSignal,
          ...(parsed.data.branch !== undefined ? { branch: parsed.data.branch } : {}),
        });
        emitResult(
          ctx,
          [
            `Workspace lease ${lease.id} acquired.`,
            `Path: ${lease.path}`,
            `Branch: ${lease.branch}`,
            "Use this isolated checkout for edits, then call workspace_release with this lease id.",
          ].join("\n"),
        );
      } catch (err) {
        emitResult(
          ctx,
          `workspace lease failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  };

  const workspaceRelease: ToolDefinition = {
    name: "workspace_release",
    description:
      "Release a workspace lease created by workspace_lease and remove its isolated worktree. Safe to call again for an already-released lease.",
    inputSchema: releaseInputSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = releaseInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      try {
        await manager.release(parsed.data.id);
        emitResult(ctx, `Workspace lease ${parsed.data.id} released.`);
      } catch (err) {
        emitResult(
          ctx,
          `workspace release failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  };

  return [workspaceLease, workspaceRelease];
}

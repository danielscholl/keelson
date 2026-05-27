// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  cloneProjectBodySchema,
  createProjectBodySchema,
  createProjectResponseSchema,
  DEFAULT_PROJECT_NAME,
  listProjectsResponseSchema,
  projectNameSchema,
  updateProjectBodySchema,
} from "@keelson/shared";
import type { Hono } from "hono";

import { DuplicateProjectNameError, type ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

// `~` and `~/...` expand to the user's home dir. Only the leading segment
// is replaced; tilde anywhere else is treated as a literal character.
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

export interface ProjectsHandlerOptions {
  store: ProjectsStore;
  // Destination root for `/api/projects/clone`. Required so `/project <url>`
  // lands in a predictable place; rejects relative or unset configurations.
  projectsRoot?: string;
}

function normalizeRootPath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = expandTilde(raw.trim());
  if (trimmed.length === 0) return { ok: false, error: "rootPath must not be empty" };
  if (!isAbsolute(trimmed)) {
    return { ok: false, error: "rootPath must be an absolute path" };
  }
  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) {
    return { ok: false, error: `rootPath does not exist: ${resolved}` };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: `rootPath is not a directory: ${resolved}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `rootPath stat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, path: resolved };
}

function deriveProjectNameFromUrl(url: string): string | null {
  // Trailing slashes must come off before `.git` so that `repo.git/` strips
  // both layers; otherwise the candidate keeps the `.git` suffix and trips
  // the project-name regex.
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const start = Math.max(lastSlash, lastColon);
  const candidate = trimmed.slice(start + 1).toLowerCase();
  return projectNameSchema.safeParse(candidate).success ? candidate : null;
}

async function gitClone(
  url: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proc = Bun.spawn({
    cmd: ["git", "clone", "--", url, dest],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, error: stderr.trim() || `git clone exited ${exitCode}` };
  }
  return { ok: true };
}

export function projectsRoutes(app: Hono, opts: ProjectsHandlerOptions): void {
  const { store, projectsRoot } = opts;

  app.get("/api/projects", (c) => {
    return c.json(listProjectsResponseSchema.parse({ projects: store.list() }));
  });

  app.post("/api/projects", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = createProjectBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const normalized = normalizeRootPath(parsed.data.rootPath);
    if (!normalized.ok) {
      return c.json({ error: normalized.error }, 400);
    }
    try {
      const project = store.create({
        name: parsed.data.name,
        rootPath: normalized.path,
        ...(parsed.data.worktreeLayout !== undefined
          ? { worktreeLayout: parsed.data.worktreeLayout }
          : {}),
      });
      return c.json(createProjectResponseSchema.parse({ project }), 201);
    } catch (err) {
      if (err instanceof DuplicateProjectNameError) {
        return c.json({ error: err.message }, 409);
      }
      console.warn(`[projects] create failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.post("/api/projects/clone", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (!projectsRoot) {
      return c.json({ error: "projects root is not configured" }, 500);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = cloneProjectBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const name = parsed.data.name ?? deriveProjectNameFromUrl(parsed.data.url);
    if (!name) {
      return c.json(
        {
          error:
            "could not derive project name from url; pass `name` explicitly (lowercase letters, digits, '-' or '_')",
        },
        400,
      );
    }
    const dest = resolve(join(projectsRoot, name));
    if (existsSync(dest)) {
      return c.json({ error: `destination already exists: ${dest}` }, 409);
    }
    if (store.getByName(name)) {
      return c.json({ error: `project name '${name}' already exists` }, 409);
    }
    const result = await gitClone(parsed.data.url, dest);
    if (!result.ok) {
      return c.json({ error: `git clone failed: ${result.error}` }, 502);
    }
    try {
      const project = store.create({
        name,
        rootPath: dest,
        ...(parsed.data.worktreeLayout !== undefined
          ? { worktreeLayout: parsed.data.worktreeLayout }
          : {}),
      });
      return c.json(createProjectResponseSchema.parse({ project }), 201);
    } catch (err) {
      if (err instanceof DuplicateProjectNameError) {
        return c.json({ error: err.message }, 409);
      }
      console.warn(
        `[projects] clone register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.patch("/api/projects/:id", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const id = c.req.param("id");
    const existing = store.get(id);
    if (!existing) {
      return c.json({ error: `unknown project '${id}'` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = updateProjectBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    if (
      existing.name === DEFAULT_PROJECT_NAME &&
      parsed.data.name !== undefined &&
      parsed.data.name !== DEFAULT_PROJECT_NAME
    ) {
      return c.json({ error: "the default project cannot be renamed" }, 400);
    }
    try {
      const project = store.update(id, parsed.data);
      if (!project) {
        return c.json({ error: `unknown project '${id}'` }, 404);
      }
      return c.json(createProjectResponseSchema.parse({ project }));
    } catch (err) {
      if (err instanceof DuplicateProjectNameError) {
        return c.json({ error: err.message }, 409);
      }
      console.warn(`[projects] update failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.delete("/api/projects/:id", (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const id = c.req.param("id");
    const existing = store.get(id);
    if (!existing) {
      return c.json({ error: `unknown project '${id}'` }, 404);
    }
    if (existing.name === DEFAULT_PROJECT_NAME) {
      return c.json({ error: "the default project cannot be removed" }, 400);
    }
    if (!store.delete(id)) {
      return c.json({ error: `unknown project '${id}'` }, 404);
    }
    return c.json({ deleted: true });
  });
}

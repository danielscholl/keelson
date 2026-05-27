// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createProjectBodySchema,
  createProjectResponseSchema,
  listProjectsResponseSchema,
} from "@keelson/shared";
import type { Hono } from "hono";

import { DuplicateProjectNameError, type ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

export interface ProjectsHandlerOptions {
  store: ProjectsStore;
}

// Resolve to an absolute path the runtime can actually `cd` into. Reject
// non-existent paths at create time so the user gets immediate feedback rather
// than a confusing failure when the first run tries to spawn a subprocess.
function normalizeRootPath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
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

export function projectsRoutes(app: Hono, opts: ProjectsHandlerOptions): void {
  const { store } = opts;

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
      const project = store.create({ name: parsed.data.name, rootPath: normalized.path });
      return c.json(createProjectResponseSchema.parse({ project }), 201);
    } catch (err) {
      if (err instanceof DuplicateProjectNameError) {
        return c.json({ error: err.message }, 409);
      }
      console.warn(`[projects] create failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.delete("/api/projects/:id", (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const id = c.req.param("id");
    if (!store.delete(id)) {
      return c.json({ error: `unknown project '${id}'` }, 404);
    }
    return c.json({ deleted: true });
  });
}

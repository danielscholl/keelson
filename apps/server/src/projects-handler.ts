// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  cloneProjectBodySchema,
  createProjectBodySchema,
  createProjectResponseSchema,
  DEFAULT_PROJECT_NAME,
  listProjectsResponseSchema,
  ProjectOperationError,
  updateProjectBodySchema,
} from "@keelson/shared";
import type { Context, Hono } from "hono";

import type { createProjectsService } from "./projects-service.ts";
import { DuplicateProjectNameError, type ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

function originForbidden(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !isAllowedOrigin(c.req.header("origin"));
}

export interface ProjectsHandlerOptions {
  store: ProjectsStore;
  service: ReturnType<typeof createProjectsService>;
}

function operationFailure(c: Context, error: unknown) {
  if (error instanceof ProjectOperationError) {
    const status = error.status;
    if (status === 400 || status === 409 || status === 500 || status === 502 || status === 503) {
      return c.json({ error: error.message }, status);
    }
  }
  console.warn(
    `[projects] operation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return c.json({ error: "internal server error" }, 500);
}

export function projectsRoutes(app: Hono, opts: ProjectsHandlerOptions): void {
  const { store, service } = opts;

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
    try {
      const project = await service.createProject(parsed.data);
      return c.json(createProjectResponseSchema.parse({ project }), 201);
    } catch (err) {
      return operationFailure(c, err);
    }
  });

  app.post("/api/projects/clone", async (c) => {
    if (originForbidden(c)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = cloneProjectBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const project = await service.cloneProject(parsed.data);
      return c.json(createProjectResponseSchema.parse({ project }), 201);
    } catch (err) {
      return operationFailure(c, err);
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

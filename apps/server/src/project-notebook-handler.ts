// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { NOTEBOOK_CONTENT_LIMIT, type ProjectNotebookStore } from "./project-notebook-store.ts";
import type { ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface ProjectNotebookRoutesDeps {
  store: ProjectNotebookStore;
  projectsStore: ProjectsStore;
}

const putNotebookSchema = z
  .object({
    content: z.string().max(NOTEBOOK_CONTENT_LIMIT),
  })
  .strict();

const appendNotebookSchema = z
  .object({
    entry: z.string().min(1).max(NOTEBOOK_CONTENT_LIMIT),
    section: z.string().min(1).optional(),
  })
  .strict();

export function projectNotebookRoutes(app: Hono, deps: ProjectNotebookRoutesDeps): void {
  const { store, projectsStore } = deps;

  // Same CSRF posture as memoryRoutes — a missing Origin (curl on loopback) is
  // allowed but a foreign Origin is rejected. The base path matches exactly, so
  // the sub-path guard covers /notebook/append (and any future sub-route).
  const originGuard: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
  app.use("/api/projects/:id/notebook", originGuard);
  app.use("/api/projects/:id/notebook/*", originGuard);

  app.get("/api/projects/:id/notebook", (c) => {
    const id = c.req.param("id");
    if (!projectsStore.get(id)) {
      return c.json({ error: "project not found" }, 404);
    }
    const notebook = store.get(id);
    return c.json({ content: notebook?.content ?? "", updatedAt: notebook?.updatedAt ?? null });
  });

  app.put("/api/projects/:id/notebook", async (c) => {
    const id = c.req.param("id");
    if (!projectsStore.get(id)) {
      return c.json({ error: "project not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = putNotebookSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const notebook = store.upsert(id, parsed.data.content);
    return c.json({ content: notebook.content, updatedAt: notebook.updatedAt });
  });

  // Append a dated bullet to a section without round-tripping the whole doc.
  // Returns previousContent so the UI can offer a one-click Undo via PUT.
  app.post("/api/projects/:id/notebook/append", async (c) => {
    const id = c.req.param("id");
    if (!projectsStore.get(id)) {
      return c.json({ error: "project not found" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = appendNotebookSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const result = store.appendEntry(id, parsed.data.entry, parsed.data.section);
    if (!result.ok) {
      return c.json({ error: "notebook is full" }, 413);
    }
    return c.json({
      content: result.notebook.content,
      updatedAt: result.notebook.updatedAt,
      previousContent: result.previousContent,
    });
  });
}

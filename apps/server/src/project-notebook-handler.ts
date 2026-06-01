// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { Hono } from "hono";
import { z } from "zod";
import type { ProjectNotebookStore } from "./project-notebook-store.ts";
import type { ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface ProjectNotebookRoutesDeps {
  store: ProjectNotebookStore;
  projectsStore: ProjectsStore;
}

// Generous headroom above the ~6 KB injected budget so a notebook can grow
// before Tidy compacts it, while still bounding a runaway write.
const NOTEBOOK_CONTENT_LIMIT = 200_000;

const putNotebookSchema = z
  .object({
    content: z.string().max(NOTEBOOK_CONTENT_LIMIT),
  })
  .strict();

export function projectNotebookRoutes(app: Hono, deps: ProjectNotebookRoutesDeps): void {
  const { store, projectsStore } = deps;

  // Same CSRF posture as memoryRoutes — a missing Origin (curl on loopback) is
  // allowed but a foreign Origin is rejected.
  app.use("/api/projects/:id/notebook", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

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
}

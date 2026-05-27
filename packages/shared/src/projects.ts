// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// A "project" in Keelson is a named pointer to a local directory. It's the
// target a workflow run operates against. Intentionally minimal — no repo URL,
// no clone, no per-project env vars. Add columns when there is a concrete use
// case (see `project_swamp_design_borrows` memory for the wider Archon model
// we explicitly chose not to adopt).
export const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rootPath: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

// Names are used as filesystem path segments under `~/.keelson/worktrees/<name>/...`
// so the allowed character set is conservative. 64 chars is generous for a
// short handle and well under POSIX_PATH_MAX even after concatenation.
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const createProjectBodySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        PROJECT_NAME_PATTERN,
        "name must start with a letter or digit and contain only letters, digits, '-' or '_'",
      ),
    rootPath: z.string().min(1),
  })
  .strict();
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

export const listProjectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const createProjectResponseSchema = z.object({ project: projectSchema }).strict();
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

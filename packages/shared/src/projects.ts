// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

export const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rootPath: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const projectNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    PROJECT_NAME_PATTERN,
    "name must start with a lowercase letter or digit and contain only lowercase letters, digits, '-' or '_'",
  );

export const createProjectBodySchema = z
  .object({
    name: projectNameSchema,
    rootPath: z.string().min(1),
  })
  .strict();
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

export const cloneProjectBodySchema = z
  .object({
    url: z.string().min(1),
    name: projectNameSchema.optional(),
  })
  .strict();
export type CloneProjectBody = z.infer<typeof cloneProjectBodySchema>;

export const updateProjectBodySchema = z
  .object({
    name: projectNameSchema,
  })
  .strict();
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

export const listProjectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const createProjectResponseSchema = z.object({ project: projectSchema }).strict();
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const DEFAULT_PROJECT_NAME = "default";

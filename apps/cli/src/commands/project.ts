// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isAbsolute, resolve } from "node:path";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { createProject, deleteProject, listProjects } from "../http/projects-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { DEFAULT_SERVER_BASE_URL } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

// Skip probeServer here: a request against `--base-url` (or the default) lets
// the actual HTTP call surface "connection refused" via `isServerDownError`,
// which is the same signal at fewer round-trips.
function effectiveBaseUrl(opts: BaseOptions): string {
  return opts.baseUrl ?? DEFAULT_SERVER_BASE_URL;
}

function noServer(opts: BaseOptions): never {
  emit(
    {
      error: "project commands require `keelson serve` to be running",
      code: "NO_SERVER",
    },
    { json: opts.json },
  );
  process.exit(EXIT_NO_SERVER);
}

function failHttp(err: unknown, opts: BaseOptions, label: string): never {
  if (isServerDownError(err)) noServer(opts);
  if (err instanceof HttpError) {
    emit(
      {
        error: err.message,
        code: err.status === 404 ? "NOT_FOUND" : err.status === 409 ? "CONFLICT" : "REQUEST_FAILED",
      },
      { json: opts.json },
    );
    process.exit(err.status === 404 ? EXIT_NOT_FOUND : EXIT_FAIL);
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: `${label}: ${message}`, code: "REQUEST_FAILED" }, { json: opts.json });
  process.exit(EXIT_FAIL);
}

export async function runProjectList(opts: BaseOptions): Promise<never> {
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const projects = await listProjects(baseUrl);
    emit({ data: { projects } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list projects");
  }
}

export type ProjectAddOptions = BaseOptions;

export async function runProjectAdd(
  name: string,
  rootPath: string,
  opts: ProjectAddOptions,
): Promise<never> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    emit({ error: "project name must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const trimmedPath = rootPath.trim();
  if (trimmedPath.length === 0) {
    emit({ error: "rootPath must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const absolutePath = isAbsolute(trimmedPath) ? trimmedPath : resolve(process.cwd(), trimmedPath);
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const project = await createProject(baseUrl, {
      name: trimmedName,
      rootPath: absolutePath,
    });
    emit({ data: { project } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "create project");
  }
}

export async function runProjectRemove(nameOrId: string, opts: BaseOptions): Promise<never> {
  const trimmed = nameOrId.trim();
  if (trimmed.length === 0) {
    emit(
      { error: "project name or id must not be empty", code: "BAD_INPUTS" },
      { json: opts.json },
    );
    process.exit(EXIT_BAD_ARGS);
  }
  const baseUrl = effectiveBaseUrl(opts);
  try {
    // Accept either a UUID id or the human name. Look up by name first so the
    // common case (`keelson project remove work-mono`) works without the
    // operator knowing the id.
    const projects = await listProjects(baseUrl);
    const match = projects.find((p) => p.name === trimmed || p.id === trimmed);
    if (!match) {
      emit({ error: `no project named '${trimmed}'`, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    await deleteProject(baseUrl, match.id);
    emit({ data: { deleted: match } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "remove project");
  }
}

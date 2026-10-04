// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CreateProjectBody,
  createProjectBodySchema,
  type Project,
  ProjectOperationError,
} from "@keelson/shared";
import { runText } from "@keelson/shared/exec";
import { canonicalPath, DuplicateProjectNameError, type ProjectsStore } from "./projects-store.ts";

function pathStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRootPath(raw: string): string {
  let path = raw.trim();
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!path) throw new ProjectOperationError(400, "rootPath must not be empty");
  if (!isAbsolute(path)) {
    throw new ProjectOperationError(400, "rootPath must be an absolute path");
  }
  return resolve(path);
}

export function createProjectsService(opts: {
  store: ProjectsStore;
  workspaceRoot: string;
  runGit?: typeof runText;
}) {
  const { store } = opts;
  const workspaceRoot = normalizeRootPath(opts.workspaceRoot);
  const exec = opts.runGit ?? runText;
  const names = new Set<string>();
  const roots = new Set<string>();
  const gitEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    ...(process.platform === "win32"
      ? {}
      : { GIT_ASKPASS: "/usr/bin/true", SSH_ASKPASS: "/usr/bin/true" }),
  };

  function checkConflicts(name: string, root: string): void {
    if (store.getByName(name)) {
      throw new ProjectOperationError(409, `project name '${name}' already exists`);
    }
    if (store.list().some((project) => canonicalPath(project.rootPath) === root)) {
      throw new ProjectOperationError(409, `project root already registered: ${root}`);
    }
  }

  function reserve(name: string, rootPath: string): () => void {
    const root = canonicalPath(rootPath);
    checkConflicts(name, root);
    if (names.has(name) || roots.has(root)) {
      throw new ProjectOperationError(409, "project name or root is already being registered");
    }
    names.add(name);
    roots.add(root);
    return () => {
      names.delete(name);
      roots.delete(root);
    };
  }

  function register(name: string, rootPath: string): Project {
    checkConflicts(name, canonicalPath(rootPath));
    try {
      return store.create({ name, rootPath });
    } catch (error) {
      if (error instanceof DuplicateProjectNameError) {
        throw new ProjectOperationError(409, error.message);
      }
      throw new ProjectOperationError(500, `project registration failed: ${message(error)}`);
    }
  }

  async function git(args: string[], cwd: string) {
    return exec("git", args, { cwd, env: gitEnv, timeoutMs: 60_000 });
  }

  function createDirectories(path: string, owned: Map<string, Stats>): void {
    if (pathStat(path)) {
      if (!statSync(path).isDirectory()) {
        throw new ProjectOperationError(400, `rootPath is not a directory: ${path}`);
      }
      return;
    }
    createDirectories(dirname(path), owned);
    mkdirSync(path);
    owned.set(path, lstatSync(path));
  }

  function cleanup(owned: Map<string, Stats>, gitDir?: string): string[] {
    const failures: string[] = [];
    for (const [path, identity] of [...owned].reverse()) {
      try {
        const current = pathStat(path);
        if (!current) continue;
        if (
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.isSymbolicLink()
        ) {
          failures.push(`retained replaced path: ${path}`);
          continue;
        }
        if (path === gitDir) rmSync(path, { recursive: true });
        else rmdirSync(path);
      } catch (error) {
        failures.push(`retained ${path}: ${message(error)}`);
      }
    }
    return failures;
  }

  return {
    async createProject(body: CreateProjectBody): Promise<Project> {
      const parsed = createProjectBodySchema.safeParse(body);
      if (!parsed.success) throw new ProjectOperationError(400, parsed.error.message);
      const rootPath =
        parsed.data.rootPath === undefined
          ? resolve(workspaceRoot, parsed.data.name)
          : normalizeRootPath(parsed.data.rootPath);
      const release = reserve(parsed.data.name, rootPath);
      const owned = new Map<string, Stats>();
      const gitDir = join(rootPath, ".git");
      try {
        createDirectories(rootPath, owned);
        const contents = readdirSync(rootPath);
        if (contents.includes(".git")) {
          const result = await git(["rev-parse", "--show-toplevel"], rootPath);
          if (!result.ok) {
            throw new ProjectOperationError(400, `invalid Git repository: ${result.error}`);
          }
          if (canonicalPath(result.data.trim()) !== canonicalPath(rootPath)) {
            throw new ProjectOperationError(400, "rootPath is not a Git checkout root");
          }
        } else if (contents.length === 0) {
          mkdirSync(gitDir);
          owned.set(gitDir, lstatSync(gitDir));
          const init = await git(["init"], rootPath);
          if (!init.ok) {
            throw new ProjectOperationError(500, `Git initialization failed: ${init.error}`);
          }
          const commit = await git(
            ["commit", "--allow-empty", "-m", "Initialize project"],
            rootPath,
          );
          if (!commit.ok) {
            const missing: string[] = [];
            for (const key of ["user.name", "user.email"]) {
              const value = await git(["config", "--get", key], rootPath);
              if (!value.ok || !value.data.trim()) missing.push(key);
            }
            const diagnostic = missing.length
              ? `configure Git ${missing.join(" and ")} (git config --global <key> <value>)`
              : commit.error;
            throw new ProjectOperationError(500, `Git initialization commit failed: ${diagnostic}`);
          }
        }
        return register(parsed.data.name, rootPath);
      } catch (error) {
        const failure =
          error instanceof ProjectOperationError
            ? error
            : new ProjectOperationError(500, `project initialization failed: ${message(error)}`);
        const failures = cleanup(owned, gitDir);
        if (failures.length) {
          throw new ProjectOperationError(
            failure.status,
            `${failure.message}; cleanup failed: ${failures.join("; ")}`,
          );
        }
        throw failure;
      } finally {
        release();
      }
    },
  };
}

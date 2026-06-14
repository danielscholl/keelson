// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { Project } from "@keelson/shared";
import { HttpError } from "../src/http/workflow-client.ts";
import {
  pathContains,
  resolveProjectBinding,
  sanitizeProjectName,
} from "../src/interactive/project.ts";

function project(name: string, rootPath: string): Project {
  return { id: `id-${name}`, name, rootPath, createdAt: "2026-01-01T00:00:00.000Z" };
}

function deps(overrides: {
  cwd: string;
  gitRoot?: string | null;
  projects?: Project[];
  createProject?: (input: { name: string; rootPath: string }) => Promise<Project>;
}) {
  const created: { name: string; rootPath: string }[] = [];
  return {
    created,
    deps: {
      cwd: overrides.cwd,
      detectGitRoot: () => overrides.gitRoot ?? null,
      listProjects: () => Promise.resolve(overrides.projects ?? []),
      createProject:
        overrides.createProject ??
        ((input: { name: string; rootPath: string }) => {
          created.push(input);
          return Promise.resolve(project(input.name, input.rootPath));
        }),
    },
  };
}

describe("pathContains", () => {
  test("matches the root itself and nested paths", () => {
    expect(pathContains("/a/b", "/a/b")).toBe(true);
    expect(pathContains("/a/b", "/a/b/c/d")).toBe(true);
  });

  test("rejects siblings sharing a name prefix", () => {
    expect(pathContains("/a/b", "/a/bc")).toBe(false);
    expect(pathContains("/a/b", "/a")).toBe(false);
  });
});

describe("sanitizeProjectName", () => {
  test("lowercases and collapses runs of disallowed chars to a dash", () => {
    expect(sanitizeProjectName("Crispy-Chainsaw")).toBe("crispy-chainsaw");
    expect(sanitizeProjectName("My Repo!!")).toBe("my-repo");
    expect(sanitizeProjectName("OSDU")).toBe("osdu");
  });

  test("strips leading separators down to a leading alphanumeric", () => {
    expect(sanitizeProjectName("__leading")).toBe("leading");
    expect(sanitizeProjectName(".dotfolder")).toBe("dotfolder");
  });

  test("caps length at 64", () => {
    expect(sanitizeProjectName("a".repeat(100))).toHaveLength(64);
  });

  test("returns null when nothing valid survives", () => {
    expect(sanitizeProjectName("...")).toBeNull();
    expect(sanitizeProjectName("")).toBeNull();
  });
});

describe("resolveProjectBinding", () => {
  test("registered project containing cwd wins without touching git", async () => {
    const { deps: d, created } = deps({
      cwd: "/home/me/repo/src",
      gitRoot: "/home/me/repo",
      projects: [project("repo", "/home/me/repo")],
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.projectId).toBe("id-repo");
    expect(binding.name).toBe("repo");
    expect(binding.autoRegistered).toBe(false);
    expect(created).toHaveLength(0);
  });

  test("longest registered root wins when projects nest", async () => {
    const { deps: d } = deps({
      cwd: "/home/me/repo/sub/dir",
      projects: [project("outer", "/home/me/repo"), project("inner", "/home/me/repo/sub")],
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.name).toBe("inner");
  });

  test("unregistered git repo auto-registers under its basename", async () => {
    const { deps: d, created } = deps({
      cwd: "/home/me/newrepo/lib",
      gitRoot: "/home/me/newrepo",
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.autoRegistered).toBe(true);
    expect(binding.name).toBe("newrepo");
    expect(binding.rootPath).toBe("/home/me/newrepo");
    expect(created).toEqual([{ name: "newrepo", rootPath: "/home/me/newrepo" }]);
  });

  test("auto-register sanitizes a basename outside the project-name charset", async () => {
    const { deps: d, created } = deps({
      cwd: "/home/me/Crispy Chainsaw/lib",
      gitRoot: "/home/me/Crispy Chainsaw",
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.autoRegistered).toBe(true);
    expect(binding.name).toBe("crispy-chainsaw");
    expect(created).toEqual([{ name: "crispy-chainsaw", rootPath: "/home/me/Crispy Chainsaw" }]);
  });

  test("auto-register falls back to default when the basename sanitizes to empty", async () => {
    const { deps: d, created } = deps({
      cwd: "/home/me/...",
      gitRoot: "/home/me/...",
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.projectId).toBeUndefined();
    expect(binding.name).toBe("default");
    expect(binding.autoRegistered).toBe(false);
    expect(binding.note).toContain("...");
    expect(created).toHaveLength(0);
  });

  test("name collision on auto-register falls back to the default workspace", async () => {
    const { deps: d } = deps({
      cwd: "/home/me/newrepo",
      gitRoot: "/home/me/newrepo",
      createProject: () => Promise.reject(new HttpError(409, "project name 'newrepo' exists")),
    });
    const binding = await resolveProjectBinding(d);
    expect(binding.projectId).toBeUndefined();
    expect(binding.name).toBe("default");
    expect(binding.note).toContain("newrepo");
  });

  test("non-repo cwd binds to the default workspace without creating", async () => {
    const { deps: d, created } = deps({ cwd: "/home/me/scratch", gitRoot: null });
    const binding = await resolveProjectBinding(d);
    expect(binding.projectId).toBeUndefined();
    expect(binding.name).toBe("default");
    expect(binding.autoRegistered).toBe(false);
    expect(created).toHaveLength(0);
  });

  test("non-409 create failures propagate", async () => {
    const { deps: d } = deps({
      cwd: "/home/me/newrepo",
      gitRoot: "/home/me/newrepo",
      createProject: () => Promise.reject(new HttpError(500, "boom")),
    });
    await expect(resolveProjectBinding(d)).rejects.toThrow("boom");
  });
});

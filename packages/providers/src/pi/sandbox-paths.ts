// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProfile } from "@keelson/shared";
import type { ToolCallGate } from "../types.ts";

// pi's file tools run in-process, outside the OS sandbox, so a sandboxed turn
// holds them to the profile here: denied paths stay unreadable and writes land
// only in the writable roots.
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Recursive tools: a root above a denied path would walk into it.
const SEARCH_TOOLS = new Set(["grep", "find"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Resolves symlinks through the nearest existing entry, so a new file under a
// symlinked directory is judged where it would really land. lstat, not
// existsSync: a dangling link is an entry, and since its target cannot be
// resolved the result is undefined and the call is refused.
function canonical(path: string): string | undefined {
  const tail: string[] = [];
  let current = path;
  while (!entryExists(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...tail);
  } catch {
    return undefined;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function identity(path: string): string | undefined {
  try {
    const st = statSync(path);
    // A filesystem that reports no inode would make every entry look alike.
    return st.ino === 0 ? undefined : `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

// The identities of a path's existing entries, from itself up to the root.
function lineage(path: string): Set<string> {
  const ids = new Set<string>();
  for (let current = path; ; current = dirname(current)) {
    const id = identity(current);
    if (id !== undefined) ids.add(id);
    if (dirname(current) === current) return ids;
  }
}

// Spelling alone misses a case variant on a case-insensitive volume, or a hard
// link, so a root that exists also matches by filesystem identity.
interface Root {
  path: string;
  id: string | undefined;
}

function rootOf(path: string): Root {
  const canonicalPath = canonical(path) ?? path;
  return { path: canonicalPath, id: identity(canonicalPath) };
}

function within(root: Root, path: string, pathLineage: Set<string>): boolean {
  return inside(root.path, path) || (root.id !== undefined && pathLineage.has(root.id));
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Mirrors pi's own normalizePath for its file tools, so the gate judges the
// path pi will open. pi's win32 shell-path rewrite is out of scope on macOS.
function normalizePiPath(raw: string): string {
  let path = raw.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (/^file:\/\//.test(path)) return fileURLToPath(path);
  return path;
}

export function sandboxPathRefusal(
  tool: string,
  args: unknown,
  profile: SandboxProfile,
  cwd: string,
): string | undefined {
  const write = WRITE_TOOLS.has(tool);
  if (!write && !READ_TOOLS.has(tool)) return undefined;
  const raw =
    args !== null &&
    typeof args === "object" &&
    typeof (args as { path?: unknown }).path === "string"
      ? (args as { path: string }).path
      : "";
  const shown = raw || ".";
  let normalized: string;
  try {
    normalized = normalizePiPath(raw);
  } catch {
    return `path '${shown}' is not a file URL the sandbox can resolve`;
  }
  const target = canonical(resolve(cwd, normalized || "."));
  if (target === undefined) return `path '${shown}' goes through a link the sandbox cannot resolve`;
  const targetLineage = lineage(target);
  const denied = profile.filesystem.denied.map(rootOf);
  if (denied.some((d) => within(d, target, targetLineage))) {
    return `path '${shown}' is denied by the sandbox`;
  }
  if (SEARCH_TOOLS.has(tool)) {
    const self: Root = { path: target, id: identity(target) };
    if (denied.some((d) => within(self, d.path, lineage(d.path)))) {
      return `path '${shown}' contains a path the sandbox denies; search a narrower path`;
    }
  }
  const writable = profile.filesystem.readwrite.map(rootOf);
  const readonly = profile.filesystem.readonly.map(rootOf);
  if (write) {
    // A read-only root carves out of a writable one, as the OS sandbox does.
    return writable.some((r) => within(r, target, targetLineage)) &&
      !readonly.some((r) => within(r, target, targetLineage))
      ? undefined
      : `path '${shown}' is not writable in the sandbox`;
  }
  const readable = [...writable, ...readonly];
  return readable.some((r) => within(r, target, targetLineage))
    ? undefined
    : `path '${shown}' is outside the sandbox's readable roots`;
}

export function withSandboxPathGate(
  gate: ToolCallGate | undefined,
  profile: SandboxProfile,
  cwd: string,
): ToolCallGate {
  return async (call) => {
    const refusal = sandboxPathRefusal(call.tool, call.args, profile, cwd);
    if (refusal !== undefined) return { outcome: "deny", reason: refusal };
    return gate !== undefined ? gate(call) : { outcome: "allow" };
  };
}

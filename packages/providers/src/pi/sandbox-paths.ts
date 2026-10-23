// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function canonicalRoot(path: string): string {
  return canonical(path) ?? path;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
  const expanded =
    raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const shown = raw || ".";
  const target = canonical(resolve(cwd, expanded || "."));
  if (target === undefined) return `path '${shown}' goes through a link the sandbox cannot resolve`;
  const denied = profile.filesystem.denied.map(canonicalRoot);
  if (denied.some((d) => inside(d, target))) return `path '${shown}' is denied by the sandbox`;
  if (SEARCH_TOOLS.has(tool) && denied.some((d) => inside(target, d))) {
    return `path '${shown}' contains a path the sandbox denies; search a narrower path`;
  }
  const writable = profile.filesystem.readwrite.map(canonicalRoot);
  const readonly = profile.filesystem.readonly.map(canonicalRoot);
  if (write) {
    // A read-only root carves out of a writable one, as the OS sandbox does.
    return writable.some((r) => inside(r, target)) && !readonly.some((r) => inside(r, target))
      ? undefined
      : `path '${shown}' is not writable in the sandbox`;
  }
  const readable = [...writable, ...readonly];
  return readable.some((r) => inside(r, target))
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

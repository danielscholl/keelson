// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SandboxProfile } from "@keelson/shared";
import type { ToolCallGate } from "../types.ts";

// pi's file tools run in-process, outside the OS sandbox, so a sandboxed turn
// holds them to the profile here: denied paths stay unreadable and writes land
// only in the writable roots.
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Recursive tools: a root above a denied path would walk into it.
const SEARCH_TOOLS = new Set(["grep", "find"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

// Resolves symlinks through the nearest existing ancestor, so a new file under
// a symlinked directory is judged where it would really land.
function canonical(path: string): string {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...tail);
  } catch {
    return path;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  const target = canonical(resolve(cwd, expanded || "."));
  const shown = raw || ".";
  const denied = profile.filesystem.denied.map(canonical);
  if (denied.some((d) => inside(d, target))) return `path '${shown}' is denied by the sandbox`;
  if (SEARCH_TOOLS.has(tool) && denied.some((d) => inside(target, d))) {
    return `path '${shown}' contains a path the sandbox denies; search a narrower path`;
  }
  const writable = profile.filesystem.readwrite.map(canonical);
  if (write) {
    return writable.some((r) => inside(r, target))
      ? undefined
      : `path '${shown}' is not writable in the sandbox`;
  }
  const readable = [...writable, ...profile.filesystem.readonly.map(canonical)];
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

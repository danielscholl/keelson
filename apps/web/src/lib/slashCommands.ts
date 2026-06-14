// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export type SlashCommandFamily = "project" | "workflow" | "mind";

export interface SlashCommand {
  name: string;
  family: SlashCommandFamily;
  description: string;
  usage: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "project",
    family: "project",
    description: "Register and manage projects — clone, use, remove",
    usage: "<url> [name]  ·  use <name>  ·  remove <name>  ·  (no args: list)",
  },
  {
    name: "workflow",
    family: "workflow",
    description: "List workflows and start a run",
    usage: "run <name> [arguments]  ·  (no args: list)",
  },
  {
    name: "mind",
    family: "mind",
    description: "Open a mind as a seeded chat",
    usage: "<slug>  ·  (no args: list)",
  },
];

export function matchSlashCommand(input: string): SlashCommand | null {
  if (!input.startsWith("/")) return null;
  const stripped = input.slice(1);
  const head = stripped.split(/\s/, 1)[0] ?? "";
  return SLASH_COMMANDS.find((c) => c.name === head) ?? null;
}

export function filterSlashCommands(input: string): SlashCommand[] {
  const stripped = input.startsWith("/") ? input.slice(1) : input;
  const head = stripped.split(/\s/, 1)[0] ?? "";
  const q = head.toLowerCase();
  if (q.length === 0) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
}

// Parses the text after `/workflow` into a sub-action. `run` keeps everything
// after the name as free-form $ARGUMENTS text (preserving spaces and `#`)
// rather than splitting it into key=value pairs, which silently dropped tokens.
export type WorkflowCommand =
  | { kind: "list" }
  | { kind: "run"; name: string; args: string }
  | { kind: "usage" };

export function parseWorkflowCommand(rest: string): WorkflowCommand {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return { kind: "list" };
  const head = trimmed.split(/\s/, 1)[0];
  if (head === "list") return { kind: "list" };
  if (head === "run") {
    const match = trimmed.match(/^run\s+(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return { kind: "usage" };
    return { kind: "run", name: match[1]!, args: (match[2] ?? "").trim() };
  }
  return { kind: "usage" };
}

// When the input is `/workflow run <partial>` and the name token is still being
// typed (no trailing space yet), returns that partial (`""` right after
// `run `). Returns null otherwise. Drives name type-ahead in the picker.
const WORKFLOW_RUN_NAME_RE = /^\/workflow\s+run\s+(\S*)$/;
export function workflowRunNamePartial(input: string): string | null {
  const m = WORKFLOW_RUN_NAME_RE.exec(input);
  return m ? m[1]! : null;
}

// `/mind <partial>` — the slug is the first token after the name (no `run`
// sub-verb), so the partial is whatever's typed after `/mind `. Drives the
// persona type-ahead in the picker.
const MIND_NAME_RE = /^\/mind\s+(\S*)$/;
export function mindNamePartial(input: string): string | null {
  const m = MIND_NAME_RE.exec(input);
  return m ? m[1]! : null;
}

// Forgiving filter for name type-ahead: compares on lowercased alphanumerics so
// `smo`, `smoke`, and `smoke-t` all surface `smoke-test`. Empty partial lists
// all. Capped so the popover never renders an unbounded set.
export function filterWorkflowNames<T extends { name: string }>(
  items: readonly T[],
  partial: string,
  limit = 8,
): T[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const q = norm(partial);
  // `/workflow run <name>` parses the first whitespace-delimited token as the
  // name, so a name containing whitespace can't be expressed as a command —
  // don't suggest one we couldn't actually run.
  const runnable = items.filter((it) => !/\s/.test(it.name));
  const matched = q === "" ? runnable : runnable.filter((it) => norm(it.name).includes(q));
  return matched.slice(0, limit);
}

// Returns true when the input is `/<name> ` (name followed by whitespace) —
// i.e. the user has committed to a command and is typing args. The picker
// uses this to switch from list mode to help-strip mode.
export function isCommittedToCommand(input: string): boolean {
  if (!input.startsWith("/")) return false;
  const stripped = input.slice(1);
  if (stripped.length === 0) return false;
  const firstSpace = stripped.search(/\s/);
  if (firstSpace === -1) return false;
  const head = stripped.slice(0, firstSpace);
  return SLASH_COMMANDS.some((c) => c.name === head);
}

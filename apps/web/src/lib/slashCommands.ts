// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export type SlashCommandFamily = "project";

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
    description: "Register and manage projects — clone, use, remove, layout",
    usage:
      "<url> [name]  ·  use <name>  ·  remove <name>  ·  layout <name> <mode>  ·  (no args: list)",
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

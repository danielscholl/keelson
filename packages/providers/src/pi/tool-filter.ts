// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { type CopilotPermissionKind, GATED_KINDS, toolKind } from "../copilot/tool-names.ts";

// pi built-ins and the pi-web-access tools by the capability a workflow's
// Claude-style names (Read, Bash, WebFetch, …) map to.
const PI_TOOL_KIND: Readonly<Record<string, CopilotPermissionKind>> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  edit: "write",
  write: "write",
  bash: "shell",
  web_search: "url",
  fetch_content: "url",
  get_search_content: "url",
};

function gatedKinds(names: readonly string[]): Set<CopilotPermissionKind> {
  const out = new Set<CopilotPermissionKind>();
  for (const name of names) {
    const kind = toolKind(name);
    if (kind !== undefined && GATED_KINDS.has(kind)) out.add(kind);
  }
  return out;
}

// Narrows a pi session's built-in and extension tools to a node's
// allowed_tools / denied_tools. A tool is covered by a list when the list names
// it exactly or names any tool of the same capability.
export function filterPiTools(
  names: readonly string[],
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): string[] {
  const allowedKinds = allowedTools === undefined ? undefined : gatedKinds(allowedTools);
  const deniedKinds = disallowedTools === undefined ? undefined : gatedKinds(disallowedTools);
  const covered = (name: string, list: readonly string[], kinds: Set<CopilotPermissionKind>) => {
    const kind = PI_TOOL_KIND[name];
    return list.includes(name) || (kind !== undefined && kinds.has(kind));
  };
  return names.filter(
    (name) =>
      (allowedTools === undefined ||
        covered(name, allowedTools, allowedKinds as Set<CopilotPermissionKind>)) &&
      (disallowedTools === undefined ||
        !covered(name, disallowedTools, deniedKinds as Set<CopilotPermissionKind>)),
  );
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Reconciles tool names between the workflow YAML (Claude-style: Read, Write,
// Bash, …) and the Copilot CLI's built-in tools (read_file, str_replace_editor,
// bash, …) by collapsing both onto the SDK's permission `kind`. The Copilot
// permission handler only ever sees a coarse `kind`, never a tool name, so the
// per-node allow/deny rail is enforced at this granularity — which is also why
// it can't leak: every write-capable built-in (create / edit / apply_patch /
// str_replace_editor) reports kind "write", so denying the capability denies
// them all without needing an exhaustive name list.

// Mirrors @github/copilot-sdk's PermissionRequest["kind"] union. Inlined to keep
// this layer free of a static SDK import.
export type CopilotPermissionKind =
  | "shell"
  | "write"
  | "mcp"
  | "read"
  | "url"
  | "custom-tool"
  | "memory"
  | "hook";

// Built-in capability kinds the per-node rail governs. `custom-tool` / `mcp` /
// `hook` pass through untouched — our rib tools are already filtered upstream by
// the workflow prompt handler, so re-gating them here would double-enforce.
export const GATED_KINDS: ReadonlySet<CopilotPermissionKind> = new Set([
  "read",
  "write",
  "shell",
  "url",
  "memory",
]);

// Lowercased tool name → capability kind. Covers the Claude tool names workflows
// author against and the Copilot CLI built-ins observed on `tool.execution_start`
// / PreToolUse input. Names absent here (rib tools, unknown built-ins) return
// undefined and are treated as non-capability tools by callers.
const NAME_TO_KIND: Readonly<Record<string, CopilotPermissionKind>> = {
  // read / search
  read: "read",
  read_file: "read",
  view: "read",
  explore: "read",
  ls: "read",
  glob: "read",
  grep: "read",
  search: "read",
  file_search: "read",
  grep_search: "read",
  semantic_search: "read",
  notebookread: "read",
  // write / edit
  write: "write",
  edit: "write",
  create: "write",
  str_replace: "write",
  str_replace_editor: "write",
  apply_patch: "write",
  git_apply_patch: "write",
  multiedit: "write",
  notebookedit: "write",
  // shell
  bash: "shell",
  shell: "shell",
  // memory
  memory: "memory",
  store_memory: "memory",
  create_memory: "memory",
  update_memory: "memory",
  delete_memory: "memory",
  // web / url
  fetch: "url",
  web_fetch: "url",
  webfetch: "url",
  websearch: "url",
};

// Resolve a tool name (either naming convention) to its capability kind, or
// undefined when the name isn't a known built-in capability. Used to translate
// author-supplied allow/deny tool names into the kinds the permission gate
// governs — a name listed by the author carries unambiguous intent, so the
// static map is the right granularity here.
export function toolKind(name: string): CopilotPermissionKind | undefined {
  return NAME_TO_KIND[name.toLowerCase()];
}

// Resolve the capability kind of an actual tool invocation, refining the static
// map with the call's args for multi-mode tools. Copilot's `str_replace_editor`
// is read (`command: "view"`) or write (every other command) depending on args;
// the hook matcher needs this so a view doesn't trigger Write/Edit hooks.
export function toolKindForInvocation(
  name: string,
  args: unknown,
): CopilotPermissionKind | undefined {
  if (name.toLowerCase() === "str_replace_editor" && args && typeof args === "object") {
    if ((args as Record<string, unknown>).command === "view") return "read";
  }
  return toolKind(name);
}

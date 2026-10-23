// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// MCP-projected tools register as `mcp__<server>__<tool>`; allow/deny lists may
// use either the bare or qualified form. Strip the wrapper so both match — the
// server segment is consumed up to the next `__` (mirrors the workflow handler).
export function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const serverEnd = name.indexOf("__", 5);
  if (serverEnd < 0) return name;
  return name.slice(serverEnd + 2);
}

// Intersect the projected tool list with `allowedTools` and subtract
// `disallowedTools`, comparing on bare names. An empty `allowedTools` yields no
// tools, satisfying the documented "no tools" contract.
export function filterToolsByRail<T extends { name: string }>(
  tools: T[],
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): T[] {
  let result = tools;
  if (allowedTools !== undefined) {
    const allow = new Set(allowedTools.map(stripMcpPrefix));
    result = result.filter((t) => allow.has(stripMcpPrefix(t.name)));
  }
  if (disallowedTools !== undefined) {
    const deny = new Set(disallowedTools.map(stripMcpPrefix));
    result = result.filter((t) => !deny.has(stripMcpPrefix(t.name)));
  }
  return result;
}

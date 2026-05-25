// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The Claude SDK wraps harness-registered tools through its MCP surface, so
// tool_use events arrive named `mcp__<server>__<tool>`. The popover reads
// from /api/tools (clean names) and the ToolCallsBlock reads from streamed
// events (wrapped names); applying this helper in both keeps the rendered
// surface consistent regardless of which channel produced the name.
//
// Splits on `__` and drops the first two tokens (`mcp` + `<server>`). The
// server name itself can contain underscores (e.g. `claude_ai_Gmail`); only
// the literal `__` separator divides tokens, so single underscores inside
// the server name are preserved.
export function displayToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  if (parts.length < 3) return name;
  const tail = parts.slice(2).join("__");
  return tail.length > 0 ? tail : name;
}

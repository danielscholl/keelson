// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Map-backed, idempotent re-register throws. Mirrors
// `@keelson/providers/registry.ts`.

import type { ToolDefinition } from "@keelson/shared";

const registry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  if (registry.has(tool.name)) {
    throw new Error(`Tool '${tool.name}' is already registered`);
  }
  registry.set(tool.name, tool);
}

export function getToolByName(name: string): ToolDefinition {
  const tool = registry.get(name);
  if (!tool) {
    const available = [...registry.keys()];
    const list = available.length > 0 ? available.join(", ") : "<none>";
    throw new Error(`Unknown tool '${name}'. Available tools: ${list}`);
  }
  return tool;
}

export function getRegisteredTools(): ToolDefinition[] {
  return [...registry.values()];
}

export function isRegisteredTool(name: string): boolean {
  return registry.has(name);
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
}

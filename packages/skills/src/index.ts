// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Re-exported for ergonomic single-import — skill authors and tool adapters
// pull the contract types and the registry API from one place.
export type {
  MessageChunk,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
export {
  clearRegistry,
  getRegisteredTools,
  getToolByName,
  isRegisteredTool,
  registerTool,
} from "./registry.ts";

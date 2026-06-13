// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import type { ToolDefinition } from "./types.ts";

// Projects a tool's ZodObject input schema into the JSON Schema an SDK ships
// to the model, using Zod 4's built-in `z.toJSONSchema()`. Returns undefined
// for truly zero-arg tools so callers can omit the parameters block entirely.
// Non-object / non-Zod schemas fall back to a permissive shape; runtime zod
// validation in each adapter's handler is the actual enforcement layer.
export function deriveToolParametersJsonSchema(
  tool: ToolDefinition,
): Record<string, unknown> | undefined {
  const def = (tool.inputSchema as { _def?: { type?: string } })._def;
  if (def?.type !== "object") {
    return { type: "object", additionalProperties: true };
  }
  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<string, unknown>;
  } catch {
    return { type: "object", additionalProperties: true };
  }
  // `$schema` is the JSON Schema draft URI; SDKs don't need it.
  delete jsonSchema.$schema;
  const properties = jsonSchema.properties as Record<string, unknown> | undefined;
  const hasNamedProps = !!properties && Object.keys(properties).length > 0;
  // `z.object({}).passthrough()` / `z.object({}).catchall(...)` project to a
  // schema with no named properties but `additionalProperties: true` (or a
  // schema). Omitting `parameters` for those would advertise a zero-arg tool
  // and silently drop the dynamic keys the rib intends to accept.
  const additional = jsonSchema.additionalProperties;
  const patternProps = jsonSchema.patternProperties as Record<string, unknown> | undefined;
  const allowsDynamicKeys =
    additional === true ||
    (typeof additional === "object" && additional !== null) ||
    (!!patternProps && Object.keys(patternProps).length > 0);
  if (!hasNamedProps && !allowsDynamicKeys) return undefined;
  return jsonSchema;
}

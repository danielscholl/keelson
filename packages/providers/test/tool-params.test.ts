// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { deriveToolParametersJsonSchema } from "../src/tool-params.ts";

function toolWith(inputSchema: unknown): ToolDefinition {
  return {
    name: "t",
    description: "test tool",
    inputSchema,
    execute: async () => {},
  } as unknown as ToolDefinition;
}

describe("deriveToolParametersJsonSchema", () => {
  it("closes a plain z.object against extra keys", () => {
    const schema = deriveToolParametersJsonSchema(toolWith(z.object({ a: z.string() })));
    expect(schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("closes a .strict() object the same way", () => {
    const schema = deriveToolParametersJsonSchema(toolWith(z.object({ a: z.string() }).strict()));
    expect(schema?.additionalProperties).toBe(false);
  });

  it("keeps nested objects closed", () => {
    const schema = deriveToolParametersJsonSchema(
      toolWith(
        z.object({ n: z.object({ b: z.number() }), arr: z.array(z.object({ c: z.string() })) }),
      ),
    );
    const props = schema?.properties as Record<string, Record<string, unknown>>;
    expect(props.n).toMatchObject({ additionalProperties: false });
    expect(props.arr?.items).toMatchObject({ additionalProperties: false });
  });

  it("leaves a .passthrough() object open with additionalProperties: true", () => {
    const schema = deriveToolParametersJsonSchema(
      toolWith(z.object({ a: z.string() }).passthrough()),
    );
    expect(schema?.additionalProperties).toBe(true);
    expect(schema?.properties).toEqual({ a: { type: "string" } });
  });

  it("keeps a typed catchall schema on additionalProperties", () => {
    const schema = deriveToolParametersJsonSchema(toolWith(z.object({}).catchall(z.number())));
    expect(schema?.additionalProperties).toEqual({ type: "number" });
  });

  it("omits parameters for a zero-arg object", () => {
    expect(deriveToolParametersJsonSchema(toolWith(z.object({})))).toBeUndefined();
    expect(deriveToolParametersJsonSchema(toolWith(z.object({}).strict()))).toBeUndefined();
  });

  it("falls back to a permissive object for non-object schemas", () => {
    expect(deriveToolParametersJsonSchema(toolWith(z.string()))).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("strips the $schema draft URI", () => {
    const schema = deriveToolParametersJsonSchema(toolWith(z.object({ a: z.string() })));
    expect(schema).not.toHaveProperty("$schema");
  });
});

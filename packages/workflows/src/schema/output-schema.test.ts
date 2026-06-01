// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { outputSchemaSchema, validateOutput } from "./output-schema.ts";

describe("outputSchemaSchema (declaration parsing)", () => {
  test("accepts a nested object/array declaration", () => {
    const parsed = outputSchemaSchema.safeParse({
      type: "object",
      required: ["nodes", "edges"],
      properties: {
        nodes: { type: "array", items: { type: "object", required: ["id"] } },
        edges: { type: "array" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown type", () => {
    expect(outputSchemaSchema.safeParse({ type: "tuple" }).success).toBe(false);
  });

  test("strict: rejects unknown/unsupported keywords (typo, enum, additionalProperties)", () => {
    expect(
      outputSchemaSchema.safeParse({ type: "object", additionalProperties: false }).success,
    ).toBe(false);
    expect(outputSchemaSchema.safeParse({ type: "string", enum: ["a", "b"] }).success).toBe(false);
    // nested declarations are strict too
    expect(
      outputSchemaSchema.safeParse({
        type: "object",
        properties: { x: { type: "string", minLength: 1 } },
      }).success,
    ).toBe(false);
  });

  test("rejects keywords on an incompatible type", () => {
    expect(outputSchemaSchema.safeParse({ type: "string", required: ["x"] }).success).toBe(false);
    expect(
      outputSchemaSchema.safeParse({ type: "array", properties: { x: { type: "string" } } })
        .success,
    ).toBe(false);
    expect(
      outputSchemaSchema.safeParse({ type: "object", items: { type: "string" } }).success,
    ).toBe(false);
    // the matching pairings still parse
    expect(
      outputSchemaSchema.safeParse({ type: "array", items: { type: "object", required: ["id"] } })
        .success,
    ).toBe(true);
  });
});

describe("validateOutput", () => {
  test("object: passes when required keys present, fails when missing", () => {
    const schema = { type: "object", required: ["nodes", "edges"] } as const;
    expect(validateOutput({ nodes: [], edges: [] }, schema)).toEqual({ ok: true });
    const bad = validateOutput({ nodes: [] }, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("missing required property 'edges'");
  });

  test("object: rejects array and null as the value", () => {
    const schema = { type: "object" } as const;
    expect(validateOutput([], schema).ok).toBe(false);
    expect(validateOutput(null, schema).ok).toBe(false);
    expect(validateOutput("x", schema).ok).toBe(false);
  });

  test("array: validates each item against items schema (path reported)", () => {
    const schema = {
      type: "array",
      items: { type: "object", required: ["id"] },
    } as const;
    expect(validateOutput([{ id: "a" }, { id: "b" }], schema)).toEqual({ ok: true });
    const bad = validateOutput([{ id: "a" }, { name: "b" }], schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("output[1]: missing required property 'id'");
  });

  test("nested property mismatch reports a dotted path", () => {
    const schema = {
      type: "object",
      properties: { meta: { type: "object", properties: { count: { type: "integer" } } } },
    } as const;
    const bad = validateOutput({ meta: { count: 1.5 } }, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("output.meta.count: expected integer");
  });

  test("scalars: string / number / integer / boolean / null", () => {
    expect(validateOutput("hi", { type: "string" }).ok).toBe(true);
    expect(validateOutput(3, { type: "number" }).ok).toBe(true);
    expect(validateOutput(3, { type: "integer" }).ok).toBe(true);
    expect(validateOutput(3.5, { type: "integer" }).ok).toBe(false);
    expect(validateOutput(true, { type: "boolean" }).ok).toBe(true);
    expect(validateOutput(null, { type: "null" }).ok).toBe(true);
    expect(validateOutput(Number.NaN, { type: "number" }).ok).toBe(false);
  });

  test("optional declared property is only checked when present", () => {
    const schema = { type: "object", properties: { tags: { type: "array" } } } as const;
    expect(validateOutput({}, schema)).toEqual({ ok: true });
    expect(validateOutput({ tags: "no" }, schema).ok).toBe(false);
  });
});

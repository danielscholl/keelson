/**
 * Declarative per-node output schema — a JSON Schema subset (`type` / `required`
 * / `properties` / `items`) an author writes in YAML. The executor validates a
 * node's captured value against it fail-closed before recording output, so a
 * producer node that emits the wrong shape fails fast instead of feeding a
 * malformed `$nodeId.output` to downstream nodes.
 *
 * This is a lightweight node-level guard, not the strict payload contract: the
 * authoritative check on a published snapshot key is a separate rib-owned
 * validator on `SnapshotManager.register`.
 */
import { z } from "zod";

export const OUTPUT_SCHEMA_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

export const outputSchemaTypeSchema = z.enum(OUTPUT_SCHEMA_TYPES);
export type OutputSchemaType = z.infer<typeof outputSchemaTypeSchema>;

export interface OutputSchema {
  readonly type: OutputSchemaType;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, OutputSchema>>;
  readonly items?: OutputSchema;
}

export const outputSchemaSchema: z.ZodType<OutputSchema> = z.lazy(() =>
  // `.strict()`: a fail-closed guard must reject an unknown/misspelled keyword
  // (`enum`, `additionalProperties`, a typo) at load rather than silently
  // dropping it and validating against a weaker schema than the author wrote.
  // The refine rejects keywords on an incompatible `type` (e.g. `required` on a
  // string, `items` on an object) — those constraints would be silently ignored.
  z
    .object({
      type: outputSchemaTypeSchema,
      required: z.array(z.string()).optional(),
      properties: z.record(z.string(), outputSchemaSchema).optional(),
      items: outputSchemaSchema.optional(),
    })
    .strict()
    .superRefine((schema, ctx) => {
      if (schema.type !== "object" && schema.required !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'required' is only valid when type is 'object'",
          path: ["required"],
        });
      }
      if (schema.type !== "object" && schema.properties !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'properties' is only valid when type is 'object'",
          path: ["properties"],
        });
      }
      if (schema.type !== "array" && schema.items !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'items' is only valid when type is 'array'",
          path: ["items"],
        });
      }
    }),
);

// ---------------------------------------------------------------------------
// Validation — pure, domain-free. The executor calls this on a node's captured
// value and fails the node on the first mismatch (fail-closed).
// ---------------------------------------------------------------------------

export type OutputSchemaValidation = { ok: true } | { ok: false; error: string };

export function validateOutput(value: unknown, schema: OutputSchema): OutputSchemaValidation {
  const error = checkValue(value, schema, "output");
  return error === null ? { ok: true } : { ok: false, error };
}

function checkValue(value: unknown, schema: OutputSchema, path: string): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path}: expected object, got ${describe(value)}`;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(obj, key)) {
          return `${path}: missing required property '${key}'`;
        }
      }
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(obj, key)) {
          const err = checkValue(obj[key], propSchema, `${path}.${key}`);
          if (err !== null) return err;
        }
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${path}: expected array, got ${describe(value)}`;
      }
      if (schema.items !== undefined) {
        for (let i = 0; i < value.length; i++) {
          const err = checkValue(value[i], schema.items, `${path}[${i}]`);
          if (err !== null) return err;
        }
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${path}: expected string, got ${describe(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${path}: expected number, got ${describe(value)}`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : `${path}: expected integer, got ${describe(value)}`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path}: expected boolean, got ${describe(value)}`;
    case "null":
      return value === null ? null : `${path}: expected null, got ${describe(value)}`;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

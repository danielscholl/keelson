// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type OutputSchema, outputSchemaSchema } from "../schema/output-schema.ts";
import { seededRandom } from "./stats.ts";

export const EVAL_GRADER_TYPES = [
  "exact",
  "contains",
  "regex",
  "json_schema",
  "bash",
  "judge",
] as const;
export type EvalGraderType = (typeof EVAL_GRADER_TYPES)[number];

export const EVAL_SPLITS = ["train", "test"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

const graderBase = {
  type: z.enum(EVAL_GRADER_TYPES),
  // Overrides the case set's graded node for cases using this grader.
  node: z.string().min(1).optional(),
};

export const evalGraderSchema = z
  .object({
    ...graderBase,
    grader_reps: z.number().int().min(1).max(10).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((grader, ctx) => {
    if (grader.type !== "judge") {
      for (const key of ["grader_reps", "provider", "model"] as const) {
        if (grader[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `'${key}' is only valid on the judge grader`,
            path: [key],
          });
        }
      }
    }
    if (grader.type !== "bash" && grader.type !== "judge" && grader.timeout_ms !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "'timeout_ms' is only valid on the bash and judge graders",
        path: ["timeout_ms"],
      });
    }
  });
export type EvalGrader = z.infer<typeof evalGraderSchema>;

const expectSchemas: Record<EvalGraderType, z.ZodTypeAny> = {
  exact: z.object({ text: z.string() }).passthrough(),
  contains: z.object({ strings: z.array(z.string().min(1)).min(1) }).passthrough(),
  regex: z
    .object({ pattern: z.string().min(1), flags: z.string().optional() })
    .passthrough()
    .superRefine((value, ctx) => {
      try {
        new RegExp(value.pattern, value.flags);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
          path: ["pattern"],
        });
      }
    }),
  json_schema: z.object({ schema: outputSchemaSchema }).passthrough(),
  bash: z.object({ script: z.string().min(1) }).passthrough(),
  judge: z.object({ claims: z.array(z.string().min(1)).min(1) }).passthrough(),
};

export const evalCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "case id must be alphanumeric with . _ -"),
    arguments: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    expect: z.record(z.string(), z.unknown()),
    grader: evalGraderSchema.optional(),
    node: z.string().min(1).optional(),
  })
  .strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

const explicitSplitSchema = z
  .object({
    train: z.array(z.string()).default([]),
    test: z.array(z.string()).default([]),
  })
  .strict();

const seededSplitSchema = z
  .object({
    seed: z.number().int(),
    train_fraction: z.number().min(0).max(1),
  })
  .strict();

export const evalSplitSchema = z.union([explicitSplitSchema, seededSplitSchema]);
export type EvalSplitSpec = z.infer<typeof evalSplitSchema>;

export const evalCaseFileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "name must be alphanumeric with . _ -"),
    workflow: z.string().min(1),
    project: z.string().min(1).optional(),
    reps: z.number().int().min(1).default(1),
    split: evalSplitSchema.optional(),
    grader: evalGraderSchema.optional(),
    node: z.string().min(1).optional(),
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict();
export type EvalCaseFileRaw = z.infer<typeof evalCaseFileSchema>;

export interface ResolvedEvalCase {
  readonly id: string;
  readonly split: EvalSplit;
  readonly inputs: Readonly<Record<string, string>>;
  readonly expect: Readonly<Record<string, unknown>>;
  readonly grader: EvalGrader;
  // Node whose output is graded; undefined means the run's final output.
  readonly node: string | undefined;
}

export interface EvalCaseSet {
  readonly name: string;
  readonly workflow: string;
  readonly project: string | undefined;
  readonly reps: number;
  readonly cases: readonly ResolvedEvalCase[];
}

export class EvalCaseFileError extends Error {
  constructor(
    message: string,
    public readonly filename: string,
  ) {
    super(`${filename}: ${message}`);
    this.name = "EvalCaseFileError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function assignSplits(
  ids: readonly string[],
  spec: EvalSplitSpec | undefined,
): Map<string, EvalSplit> {
  const out = new Map<string, EvalSplit>();
  if (spec === undefined) {
    for (const id of ids) out.set(id, "test");
    return out;
  }
  if ("seed" in spec) {
    const sorted = [...ids].sort();
    const random = seededRandom(spec.seed);
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = sorted[i] as string;
      sorted[i] = sorted[j] as string;
      sorted[j] = a;
    }
    const trainCount = Math.round(sorted.length * spec.train_fraction);
    for (const [index, id] of sorted.entries()) out.set(id, index < trainCount ? "train" : "test");
    return out;
  }
  const known = new Set(ids);
  for (const split of EVAL_SPLITS) {
    for (const id of spec[split]) {
      if (!known.has(id)) throw new Error(`split.${split} names unknown case '${id}'`);
      const prior = out.get(id);
      if (prior !== undefined && prior !== split) {
        throw new Error(`case '${id}' appears in both train and test splits`);
      }
      out.set(id, split);
    }
  }
  for (const id of ids) {
    if (!out.has(id)) throw new Error(`case '${id}' is in neither split.train nor split.test`);
  }
  return out;
}

export function validateExpect(grader: EvalGrader, expect: Record<string, unknown>): string | null {
  const parsed = expectSchemas[grader.type].safeParse(expect);
  return parsed.success
    ? null
    : `expect for grader '${grader.type}': ${formatIssues(parsed.error)}`;
}

export function expectJsonSchema(expect: Readonly<Record<string, unknown>>): OutputSchema {
  return outputSchemaSchema.parse(expect.schema);
}

export function resolveEvalCaseSet(raw: EvalCaseFileRaw, filename = "<memory>"): EvalCaseSet {
  const ids = raw.cases.map((c) => c.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new EvalCaseFileError(`duplicate case id '${id}'`, filename);
    seen.add(id);
  }
  let splits: Map<string, EvalSplit>;
  try {
    splits = assignSplits(ids, raw.split);
  } catch (err) {
    throw new EvalCaseFileError(err instanceof Error ? err.message : String(err), filename);
  }
  const cases = raw.cases.map((c): ResolvedEvalCase => {
    const grader = c.grader ?? raw.grader;
    if (grader === undefined) {
      throw new EvalCaseFileError(
        `case '${c.id}' has no grader and the file declares no default grader`,
        filename,
      );
    }
    const expectError = validateExpect(grader, c.expect);
    if (expectError !== null) {
      throw new EvalCaseFileError(`case '${c.id}': ${expectError}`, filename);
    }
    const inputs: Record<string, string> = { ...(c.inputs ?? {}) };
    if (c.arguments !== undefined) {
      if (Object.hasOwn(inputs, "ARGUMENTS")) {
        throw new EvalCaseFileError(
          `case '${c.id}' sets both 'arguments' and inputs.ARGUMENTS`,
          filename,
        );
      }
      inputs.ARGUMENTS = c.arguments;
    }
    return {
      id: c.id,
      split: splits.get(c.id) ?? "test",
      inputs,
      expect: c.expect,
      grader,
      node: c.node ?? grader.node ?? raw.node,
    };
  });
  return {
    name: raw.name,
    workflow: raw.workflow,
    project: raw.project,
    reps: raw.reps,
    cases,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

// Stable over everything that decides a verdict (ids, split, inputs, graded
// node, grader, expect); key order and the file's comments do not matter.
export function caseSetFingerprint(caseSet: EvalCaseSet): string {
  const body = canonical({
    workflow: caseSet.workflow,
    cases: caseSet.cases.map((c) => ({
      id: c.id,
      split: c.split,
      inputs: c.inputs,
      node: c.node ?? null,
      grader: c.grader,
      expect: c.expect,
    })),
  });
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function parseEvalCaseFile(content: string, filename = "<memory>"): EvalCaseSet {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new EvalCaseFileError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      filename,
    );
  }
  const parsed = evalCaseFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new EvalCaseFileError(formatIssues(parsed.error), filename);
  }
  return resolveEvalCaseSet(parsed.data, filename);
}

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { prependPath, resolveBash } from "../handlers/shell.ts";
import { runSubprocess, SubprocessSpawnError } from "../handlers/subprocess.ts";
import { validateOutput } from "../schema/output-schema.ts";
import { type EvalGrader, expectJsonSchema } from "./case-file.ts";

export type GradeStatus = "pass" | "fail" | "error";

export interface JudgeClaimVerdict {
  readonly claim: string;
  readonly met: boolean;
  readonly evidence: string;
}

export interface JudgeDetail {
  readonly reps: number;
  readonly verdicts: readonly GradeStatus[];
  readonly disagreement: boolean;
  readonly claims: readonly JudgeClaimVerdict[];
}

export interface GradeResult {
  readonly status: GradeStatus;
  readonly detail: string;
  readonly judge?: JudgeDetail;
}

export interface GradeInput {
  readonly caseId: string;
  readonly runId: string;
  readonly output: string;
  readonly outputFile: string;
  readonly expect: Readonly<Record<string, unknown>>;
  readonly grader: EvalGrader;
}

export interface JudgeRequest {
  readonly prompt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export type JudgeFn = (request: JudgeRequest) => Promise<string>;

export interface GraderDeps {
  readonly cwd: string;
  readonly judge?: JudgeFn;
  readonly env?: Readonly<Record<string, string>>;
}

export const DEFAULT_JUDGE_REPS = 2;
const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export async function gradeOutput(input: GradeInput, deps: GraderDeps): Promise<GradeResult> {
  switch (input.grader.type) {
    case "exact":
      return gradeExact(input);
    case "contains":
      return gradeContains(input);
    case "regex":
      return gradeRegex(input);
    case "json_schema":
      return gradeJsonSchema(input);
    case "bash":
      return await gradeBash(input, deps);
    case "judge":
      return await gradeJudge(input, deps);
  }
}

function gradeExact(input: GradeInput): GradeResult {
  const expected = String(input.expect.text).trim();
  const actual = input.output.trim();
  return actual === expected
    ? { status: "pass", detail: "output equals expect.text" }
    : { status: "fail", detail: `output differs from expect.text (got ${preview(actual)})` };
}

function gradeContains(input: GradeInput): GradeResult {
  const strings = input.expect.strings as readonly string[];
  const missing = strings.filter((s) => !input.output.includes(s));
  return missing.length === 0
    ? { status: "pass", detail: `all ${strings.length} expected string(s) present` }
    : { status: "fail", detail: `missing: ${missing.map((s) => JSON.stringify(s)).join(", ")}` };
}

function gradeRegex(input: GradeInput): GradeResult {
  const pattern = String(input.expect.pattern);
  const flags = typeof input.expect.flags === "string" ? input.expect.flags : undefined;
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    return { status: "error", detail: `invalid regex: ${(err as Error).message}` };
  }
  return re.test(input.output)
    ? { status: "pass", detail: `output matches /${pattern}/${flags ?? ""}` }
    : { status: "fail", detail: `output does not match /${pattern}/${flags ?? ""}` };
}

function gradeJsonSchema(input: GradeInput): GradeResult {
  const parsed = extractJson(input.output);
  if (!parsed.ok) return { status: "fail", detail: `output is not JSON: ${parsed.error}` };
  const schema = expectJsonSchema(input.expect);
  const result = validateOutput(parsed.value, schema);
  return result.ok
    ? { status: "pass", detail: "output validates against expect.schema" }
    : { status: "fail", detail: result.error };
}

type JsonExtraction = { ok: true; value: unknown } | { ok: false; error: string };

// Model output often wraps JSON in prose or a code fence; accept the first
// balanced object or array rather than demanding a bare document.
export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace >= 0) {
    const open = trimmed[firstBrace];
    const close = open === "{" ? "}" : "]";
    const last = trimmed.lastIndexOf(close);
    if (last > firstBrace) candidates.push(trimmed.slice(firstBrace, last + 1));
  }
  let lastError = "empty output";
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

function envKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

export function expectEnv(expect: Readonly<Record<string, unknown>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(expect)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      env[`EVAL_EXPECT_${envKey(key)}`] = String(value);
    }
  }
  return env;
}

async function gradeBash(input: GradeInput, deps: GraderDeps): Promise<GradeResult> {
  const script = String(input.expect.script);
  const timeoutMs = input.grader.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS;
  const env: Record<string, string> = {
    ...(deps.env ?? (process.env as Record<string, string>)),
    ...expectEnv(input.expect),
    EVAL_OUTPUT: input.output,
    EVAL_OUTPUT_FILE: input.outputFile,
    EVAL_CASE_ID: input.caseId,
    EVAL_RUN_ID: input.runId,
  };
  let outcome: Awaited<ReturnType<typeof runSubprocess>>;
  try {
    const bash = resolveBash();
    outcome = await runSubprocess({
      cmd: bash.cmd,
      args: ["-c", script],
      cwd: deps.cwd,
      env: prependPath(env, bash.pathDirs),
      timeoutMs,
      abortSignal: new AbortController().signal,
      emit: () => {},
    });
  } catch (err) {
    if (err instanceof SubprocessSpawnError) {
      return { status: "error", detail: `bash grader spawn failed: ${err.message}` };
    }
    throw err;
  }
  if (outcome.killReason === "timeout") {
    return { status: "error", detail: `bash grader timed out after ${timeoutMs}ms` };
  }
  const tail = outcome.stderrTail.trim() || outcome.stdoutText.trim().split("\n").at(-1) || "";
  const suffix = tail ? `: ${tail}` : "";
  if (outcome.exitCode === 0) return { status: "pass", detail: `bash grader exit 0${suffix}` };
  if (outcome.exitCode === 1) return { status: "fail", detail: `bash grader exit 1${suffix}` };
  return { status: "error", detail: `bash grader exit ${outcome.exitCode}${suffix}` };
}

export function buildJudgePrompt(output: string, claims: readonly string[]): string {
  const claimLines = claims.map((claim, i) => `${i + 1}. ${claim}`).join("\n");
  return [
    "You are grading the output of an automated workflow against a rubric of checkable claims.",
    "For each claim decide whether the output meets it. Quote the evidence from the output that",
    "supports your decision; when a claim is not met, say what is missing or wrong.",
    "",
    "Respond with JSON only, no prose, in exactly this shape:",
    '{"claims":[{"claim":"<claim text>","met":true,"evidence":"<quote or reason>"}]}',
    "Include every claim, in order.",
    "",
    "CLAIMS:",
    claimLines,
    "",
    "OUTPUT:",
    "<<<",
    output,
    ">>>",
  ].join("\n");
}

type JudgeParse = { ok: true; claims: JudgeClaimVerdict[] } | { ok: false; error: string };

export function parseJudgeResponse(text: string, claims: readonly string[]): JudgeParse {
  const extracted = extractJson(text);
  if (!extracted.ok) return { ok: false, error: `judge returned no JSON: ${extracted.error}` };
  const value = extracted.value as { claims?: unknown };
  if (typeof value !== "object" || value === null || !Array.isArray(value.claims)) {
    return { ok: false, error: "judge JSON lacks a 'claims' array" };
  }
  const rows = value.claims as unknown[];
  if (rows.length !== claims.length) {
    return {
      ok: false,
      error: `judge returned ${rows.length} claim verdict(s) for ${claims.length} claim(s)`,
    };
  }
  const verdicts: JudgeClaimVerdict[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { claim?: unknown; met?: unknown; evidence?: unknown };
    if (typeof row !== "object" || row === null || typeof row.met !== "boolean") {
      return { ok: false, error: `judge verdict ${i + 1} lacks a boolean 'met'` };
    }
    verdicts.push({
      claim: claims[i] as string,
      met: row.met,
      evidence: typeof row.evidence === "string" ? row.evidence : "",
    });
  }
  return { ok: true, claims: verdicts };
}

async function gradeJudge(input: GradeInput, deps: GraderDeps): Promise<GradeResult> {
  if (deps.judge === undefined) {
    return { status: "error", detail: "judge grader requires a provider; none is wired" };
  }
  const claims = input.expect.claims as readonly string[];
  const reps = input.grader.grader_reps ?? DEFAULT_JUDGE_REPS;
  const prompt = buildJudgePrompt(input.output, claims);
  const verdicts: GradeStatus[] = [];
  const perRep: JudgeClaimVerdict[][] = [];
  const errors: string[] = [];
  for (let rep = 0; rep < reps; rep++) {
    let text: string;
    try {
      text = await deps.judge({
        prompt,
        ...(input.grader.provider !== undefined ? { provider: input.grader.provider } : {}),
        ...(input.grader.model !== undefined ? { model: input.grader.model } : {}),
        ...(input.grader.timeout_ms !== undefined ? { timeoutMs: input.grader.timeout_ms } : {}),
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      verdicts.push("error");
      perRep.push([]);
      continue;
    }
    const parsed = parseJudgeResponse(text, claims);
    if (!parsed.ok) {
      errors.push(parsed.error);
      verdicts.push("error");
      perRep.push([]);
      continue;
    }
    verdicts.push(parsed.claims.every((c) => c.met) ? "pass" : "fail");
    perRep.push(parsed.claims);
  }
  const graded = verdicts.filter((v) => v !== "error");
  const passes = graded.filter((v) => v === "pass").length;
  const disagreement = graded.length > 1 && passes > 0 && passes < graded.length;
  if (graded.length === 0) {
    return {
      status: "error",
      detail: `judge produced no usable verdict: ${errors.join("; ")}`,
      judge: { reps, verdicts, disagreement: false, claims: [] },
    };
  }
  // Majority rules; a tie (which 2 reps always are when they disagree) reads
  // as fail so grader noise never inflates the pass rate.
  const status: GradeStatus = passes * 2 > graded.length ? "pass" : "fail";
  const representative = perRep.find((rows, i) => rows.length > 0 && verdicts[i] === status) ?? [];
  const unmet = representative.filter((c) => !c.met).map((c) => c.claim);
  const detail =
    status === "pass"
      ? `all ${claims.length} claim(s) met (${passes}/${graded.length} judge reps agree)`
      : `unmet: ${unmet.map((c) => JSON.stringify(c)).join(", ") || "n/a"} (${graded.length - passes}/${graded.length} judge reps)`;
  return {
    status,
    detail: disagreement ? `${detail}; judge reps disagree` : detail,
    judge: { reps, verdicts, disagreement, claims: representative },
  };
}

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ");
  return JSON.stringify(oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine);
}

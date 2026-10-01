// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  caseSetFingerprint,
  EVAL_OUTPUT_INLINE_LIMIT,
  EVAL_RESULTS_SCHEMA_VERSION,
  type EvalCaseResult,
  type EvalCaseSet,
  type EvalResultsFile,
  type EvalSplit,
  type GraderDeps,
  gradeOutput,
  type ResolvedEvalCase,
  summarize,
} from "@keelson/workflows";

import type { CaseExecutor } from "./execute.ts";

export interface RunEvalOptions {
  readonly caseSet: EvalCaseSet;
  readonly caseFile: string;
  readonly reps: number;
  readonly split: EvalSplit | "all";
  readonly mode: "http" | "in-process";
  readonly executor: CaseExecutor;
  readonly graderDeps: GraderDeps;
  // Directory receiving one full-output file per case rep.
  readonly outputsDir: string;
  readonly onProgress?: (line: string) => void;
  readonly onNodeEvent?: (line: string) => void;
  readonly now?: () => Date;
}

export function selectCases(
  cases: readonly ResolvedEvalCase[],
  split: EvalSplit | "all",
): ResolvedEvalCase[] {
  return split === "all" ? [...cases] : cases.filter((c) => c.split === split);
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= EVAL_OUTPUT_INLINE_LIMIT)
    return { text, truncated: false };
  let cut = text.slice(0, EVAL_OUTPUT_INLINE_LIMIT);
  while (Buffer.byteLength(cut, "utf8") > EVAL_OUTPUT_INLINE_LIMIT) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

export async function runEval(opts: RunEvalOptions): Promise<EvalResultsFile> {
  const cases = selectCases(opts.caseSet.cases, opts.split);
  const results: EvalCaseResult[] = [];
  mkdirSync(opts.outputsDir, { recursive: true });
  const createdAt = (opts.now ?? (() => new Date()))().toISOString();

  // Rep-major so an interrupted eval still holds every case once.
  for (let rep = 1; rep <= opts.reps; rep++) {
    for (const c of cases) {
      opts.onProgress?.(`▶ ${c.id} (${c.split}) rep ${rep}/${opts.reps}`);
      const execution = await opts.executor({
        inputs: c.inputs,
        ...(opts.onNodeEvent !== undefined ? { onEvent: opts.onNodeEvent } : {}),
      });
      const base = {
        caseId: c.id,
        split: c.split,
        rep,
        runId: execution.runId,
        durationMs: execution.durationMs,
        tokens: execution.tokens,
        costUsd: execution.costUsd,
        definitionHash: execution.definitionHash,
      };
      let graded: string | null = null;
      let error: string | null = execution.error;
      if (error === null) {
        if (c.node !== undefined) {
          graded = execution.nodeOutputs[c.node] ?? null;
          if (graded === null) error = `node '${c.node}' produced no output in this run`;
        } else {
          graded = execution.finalOutput;
          if (graded === null) error = "run produced no final output to grade";
        }
      }
      if (error !== null || graded === null) {
        results.push({
          ...base,
          status: "error",
          grader: { type: c.grader.type, detail: "not graded" },
          output: { text: "", truncated: false, path: null },
          error,
        });
        opts.onProgress?.(`  ⚠ error — ${error}`);
        continue;
      }
      const outputPath = join(opts.outputsDir, `${c.id}.rep${rep}.txt`);
      writeFileSync(outputPath, graded);
      const grade = await gradeOutput(
        {
          caseId: c.id,
          runId: execution.runId ?? "",
          output: graded,
          outputFile: outputPath,
          expect: c.expect,
          grader: c.grader,
        },
        opts.graderDeps,
      );
      const inline = truncate(graded);
      results.push({
        ...base,
        status: grade.status,
        grader: {
          type: c.grader.type,
          detail: grade.detail,
          ...(grade.judge !== undefined ? { judge: grade.judge } : {}),
        },
        output: { ...inline, path: outputPath },
        error: grade.status === "error" ? grade.detail : null,
      });
      const icon = grade.status === "pass" ? "✓" : grade.status === "fail" ? "✗" : "⚠";
      opts.onProgress?.(`  ${icon} ${grade.status} — ${grade.detail}`);
    }
  }

  return {
    schemaVersion: EVAL_RESULTS_SCHEMA_VERSION,
    name: opts.caseSet.name,
    workflow: opts.caseSet.workflow,
    project: opts.caseSet.project ?? null,
    caseFile: opts.caseFile,
    caseSetHash: caseSetFingerprint(opts.caseSet),
    createdAt,
    mode: opts.mode,
    reps: opts.reps,
    splitFilter: opts.split,
    cases: results,
    summary: summarize(results),
  };
}

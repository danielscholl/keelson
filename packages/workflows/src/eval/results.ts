// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { z } from "zod";
import {
  EVAL_GRADER_TYPES,
  EVAL_SPLITS,
  type EvalGraderType,
  type EvalSplit,
} from "./case-file.ts";
import type { GradeStatus, JudgeDetail } from "./graders.ts";
import {
  mean,
  PAIRED_ALPHA,
  PAIRED_MIN_CHANGED,
  type PairedTest,
  pairedPermutationTest,
  percentile,
  type WilsonInterval,
  wilsonInterval,
} from "./stats.ts";

export const EVAL_RESULTS_SCHEMA_VERSION = 1;
export const EVAL_OUTPUT_INLINE_LIMIT = 16 * 1024;

export const HEADROOM_PASS_RATE = 0.95;
export const NOISE_INTERVAL_WIDTH = 0.2;

export interface EvalCaseResult {
  readonly caseId: string;
  readonly split: EvalSplit;
  readonly rep: number;
  readonly runId: string | null;
  readonly status: GradeStatus;
  readonly grader: {
    readonly type: EvalGraderType;
    readonly detail: string;
    readonly judge?: JudgeDetail;
  };
  readonly output: {
    readonly text: string;
    readonly truncated: boolean;
    readonly path: string | null;
  };
  readonly durationMs: number | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly costUsd: number | null;
  readonly definitionHash: string | null;
  readonly error: string | null;
}

export interface SplitStats {
  readonly cases: number;
  readonly graded: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly passRate: number | null;
  readonly interval: WilsonInterval | null;
}

export interface EvalSummary {
  readonly overall: SplitStats;
  readonly splits: Readonly<Record<EvalSplit, SplitStats>>;
  readonly errors: number;
  readonly graderNoise: {
    readonly judged: number;
    readonly disagreements: number;
    readonly rate: number | null;
  };
  readonly duration: { readonly meanMs: number | null; readonly p95Ms: number | null };
  readonly cost: {
    readonly totalUsd: number | null;
    readonly perCaseUsd: Readonly<Record<string, number | null>>;
  };
  readonly definitionHashes: readonly string[];
  readonly warnings: readonly string[];
}

export interface EvalResultsFile {
  readonly schemaVersion: typeof EVAL_RESULTS_SCHEMA_VERSION;
  readonly name: string;
  readonly workflow: string;
  readonly project: string | null;
  readonly caseFile: string;
  // Fingerprint of the case ids, inputs, graders, and expectations that ran,
  // so compare can tell two runs of the same cases from two different sets.
  readonly caseSetHash: string;
  readonly createdAt: string;
  readonly mode: "http" | "in-process";
  readonly reps: number;
  readonly splitFilter: EvalSplit | "all";
  // What produced the numbers, so compare can say when two runs differ by
  // more than the workflow. Absent or null makes no claim: the version is
  // null over HTTP, where the server's build runs the workflow, not the CLI's.
  readonly provider?: string | null;
  readonly keelsonVersion?: string | null;
  readonly cases: readonly EvalCaseResult[];
  readonly summary: EvalSummary;
}

export function splitStats(results: readonly EvalCaseResult[]): SplitStats {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;
  const graded = passed + failed;
  return {
    cases: results.length,
    graded,
    passed,
    failed,
    errors,
    passRate: graded > 0 ? passed / graded : null,
    interval: wilsonInterval(passed, graded),
  };
}

export function summarize(results: readonly EvalCaseResult[]): EvalSummary {
  const overall = splitStats(results);
  const splits = {
    train: splitStats(results.filter((r) => r.split === "train")),
    test: splitStats(results.filter((r) => r.split === "test")),
  };
  const judged = results.filter((r) => r.grader.judge !== undefined && r.status !== "error");
  const disagreements = judged.filter((r) => r.grader.judge?.disagreement === true).length;
  const durations = results
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null && Number.isFinite(d));
  // One unpriced rep makes its case, and the total, unpriced: a partial sum
  // would read as a real (and too small) spend.
  // Null prototype: a case id like `constructor` must not read an inherited value.
  const perCaseUsd: Record<string, number | null> = Object.create(null);
  for (const r of results) {
    const prior = perCaseUsd[r.caseId];
    if (r.costUsd === null || prior === null) {
      perCaseUsd[r.caseId] = null;
      continue;
    }
    perCaseUsd[r.caseId] = (prior ?? 0) + r.costUsd;
  }
  const totalUsd =
    results.length > 0 && results.every((r) => r.costUsd !== null)
      ? results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      : null;
  const definitionHashes = [
    ...new Set(results.map((r) => r.definitionHash).filter((h): h is string => h !== null)),
  ].sort();

  const warnings: string[] = [];
  if (definitionHashes.length > 1) {
    warnings.push(
      `HASH: ${definitionHashes.length} workflow definition hashes observed in one eval; the workflow changed mid-run`,
    );
  }
  const test = splits.test;
  if (test.passRate !== null && test.passRate > HEADROOM_PASS_RATE) {
    warnings.push(
      `HEADROOM: test pass rate ${pct(test.passRate)} is above ${pct(HEADROOM_PASS_RATE)}; add harder cases or the eval cannot show improvement`,
    );
  }
  for (const split of EVAL_SPLITS) {
    const s = splits[split];
    if (s.interval !== null && s.interval.high - s.interval.low > NOISE_INTERVAL_WIDTH) {
      warnings.push(
        `NOISE: ${split} interval ${pct(s.interval.low)}–${pct(s.interval.high)} is wider than ${pct(NOISE_INTERVAL_WIDTH)}; run more reps or add cases`,
      );
    }
  }
  const distinctCases = new Set(results.map((r) => r.caseId)).size;
  if (distinctCases > 0 && distinctCases < PAIRED_MIN_CHANGED) {
    warnings.push(
      `POWER: ${distinctCases} case(s); compare needs at least ${PAIRED_MIN_CHANGED} cases to change before it can call a difference`,
    );
  }
  if (overall.errors > 0) {
    warnings.push(
      `ERRORS: ${overall.errors} case run(s) errored and are excluded from the pass rate`,
    );
  }
  return {
    overall,
    splits,
    errors: overall.errors,
    graderNoise: {
      judged: judged.length,
      disagreements,
      rate: judged.length > 0 ? disagreements / judged.length : null,
    },
    duration: { meanMs: mean(durations), p95Ms: percentile(durations, 95) },
    cost: { totalUsd, perCaseUsd },
    definitionHashes,
    warnings,
  };
}

export type SplitVerdict = "improved" | "regressed" | "within-noise" | "n/a";
export type CompareDecision = "keep" | "revert";

export interface SplitComparison {
  readonly split: EvalSplit | "overall";
  readonly before: SplitStats;
  readonly after: SplitStats;
  readonly delta: number | null;
  // Per-case paired test behind the verdict; null when no case was graded on
  // both sides.
  readonly paired: PairedTest | null;
  readonly verdict: SplitVerdict;
}

export interface EvalComparison {
  readonly before: { readonly name: string; readonly createdAt: string };
  readonly after: { readonly name: string; readonly createdAt: string };
  // False when the two files did not run the same cases under the same split
  // filter; the decision is then forced to revert and `reason` says why.
  readonly comparable: boolean;
  // False when both sides ran one identical workflow definition, so any
  // difference came from outside it; null when either side lacks a hash.
  readonly definitionChanged: boolean | null;
  readonly splits: readonly SplitComparison[];
  readonly decision: CompareDecision;
  readonly reason: string;
  readonly cost: {
    readonly beforeUsd: number | null;
    readonly afterUsd: number | null;
    readonly deltaUsd: number | null;
  };
  // What the change cost when the provider is unpriced: wall time per case run
  // and tokens summed over the eval (null when any run reported none).
  readonly duration: { readonly beforeMeanMs: number | null; readonly afterMeanMs: number | null };
  readonly tokens: { readonly before: TokenTotals | null; readonly after: TokenTotals | null };
  readonly warnings: readonly string[];
}

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
}

function tokenTotals(results: readonly EvalCaseResult[]): TokenTotals | null {
  if (results.length === 0) return null;
  let input = 0;
  let output = 0;
  for (const r of results) {
    if (r.tokens === null) return null;
    input += r.tokens.input;
    output += r.tokens.output;
  }
  return { input, output };
}

function caseRates(
  results: readonly EvalCaseResult[],
  split: EvalSplit | "overall",
): Map<string, number> {
  const tally = new Map<string, { passed: number; graded: number }>();
  for (const r of results) {
    if (r.status === "error" || (split !== "overall" && r.split !== split)) continue;
    const t = tally.get(r.caseId) ?? { passed: 0, graded: 0 };
    t.graded++;
    if (r.status === "pass") t.passed++;
    tally.set(r.caseId, t);
  }
  return new Map([...tally].map(([id, t]) => [id, t.passed / t.graded]));
}

// One pass-rate difference per case graded on both sides: reps of a case are
// not independent trials, so the case is the unit the test counts.
export function pairedDeltas(
  before: readonly EvalCaseResult[],
  after: readonly EvalCaseResult[],
  split: EvalSplit | "overall",
): number[] {
  const a = caseRates(before, split);
  const b = caseRates(after, split);
  const deltas: number[] = [];
  for (const [id, rate] of a) {
    const other = b.get(id);
    if (other !== undefined) deltas.push(other - rate);
  }
  return deltas;
}

export function compareSplit(
  split: EvalSplit | "overall",
  before: SplitStats,
  after: SplitStats,
  paired: PairedTest | null,
): SplitComparison {
  const delta =
    before.passRate !== null && after.passRate !== null ? after.passRate - before.passRate : null;
  let verdict: SplitVerdict;
  if (paired === null) verdict = "n/a";
  else if (paired.pValue >= PAIRED_ALPHA || paired.meanDelta === 0) verdict = "within-noise";
  else verdict = paired.meanDelta > 0 ? "improved" : "regressed";
  return { split, before, after, delta, paired, verdict };
}

function definitionChanged(a: EvalResultsFile, b: EvalResultsFile): boolean | null {
  const before = a.summary.definitionHashes;
  const after = b.summary.definitionHashes;
  if (before.length === 0 || after.length === 0) return null;
  return !(before.length === 1 && after.length === 1 && before[0] === after[0]);
}

export function compareResults(a: EvalResultsFile, b: EvalResultsFile): EvalComparison {
  const warnings: string[] = [];
  const incomparable: string[] = [];
  if (a.workflow !== b.workflow) {
    incomparable.push(`workflows differ: '${a.workflow}' vs '${b.workflow}'`);
  }
  if (a.project !== b.project) {
    incomparable.push(`projects differ: '${a.project ?? "none"}' vs '${b.project ?? "none"}'`);
  }
  if (a.caseSetHash !== b.caseSetHash) {
    incomparable.push(
      `case sets differ (${a.caseSetHash.slice(0, 12)} vs ${b.caseSetHash.slice(0, 12)}): the cases, inputs, graders, or expectations changed between runs`,
    );
  }
  if (a.splitFilter !== b.splitFilter) {
    incomparable.push(`split filters differ: '${a.splitFilter}' vs '${b.splitFilter}'`);
  }
  // The sign-flip test needs each case's two rates to be exchangeable, which
  // a rate over one rep and a rate over three are not.
  if (a.reps !== b.reps) {
    incomparable.push(`reps differ: ${a.reps} vs ${b.reps}`);
  }
  const splitOf = (split: EvalSplit | "overall") =>
    compareSplit(
      split,
      split === "overall" ? a.summary.overall : a.summary.splits[split],
      split === "overall" ? b.summary.overall : b.summary.splits[split],
      pairedPermutationTest(pairedDeltas(a.cases, b.cases, split)),
    );
  const overall = splitOf("overall");
  const train = splitOf("train");
  const test = splitOf("test");
  const splits: SplitComparison[] = [overall, train, test];
  const changed = definitionChanged(a, b);
  if (changed === false) {
    warnings.push(
      "both runs executed the same workflow definition: any difference came from outside it (provider, model, a command file, rib code) or is run-to-run noise",
    );
  }
  if (a.provider !== undefined && b.provider !== undefined && a.provider !== b.provider) {
    warnings.push(
      `provider overrides differ: '${a.provider ?? "none"}' vs '${b.provider ?? "none"}'`,
    );
  }
  if (
    typeof a.keelsonVersion === "string" &&
    typeof b.keelsonVersion === "string" &&
    a.keelsonVersion !== b.keelsonVersion
  ) {
    warnings.push(`keelson versions differ: '${a.keelsonVersion}' vs '${b.keelsonVersion}'`);
  }
  if (
    overall.verdict === "within-noise" &&
    overall.paired !== null &&
    overall.paired.changed < PAIRED_MIN_CHANGED
  ) {
    warnings.push(
      `only ${overall.paired.changed} case(s) changed; at least ${PAIRED_MIN_CHANGED} must change before a difference can clear p < ${PAIRED_ALPHA}, so add cases`,
    );
  }
  const errors = a.summary.errors + b.summary.errors;
  const hasTrain = train.verdict !== "n/a";
  let decision: CompareDecision;
  let reason: string;
  if (incomparable.length > 0) {
    decision = "revert";
    reason = `not comparable: ${incomparable.join("; ")}`;
  } else if (errors > 0) {
    // Errored runs sit outside the test, so a candidate that crashed on its
    // hardest cases could otherwise look better on the ones that survived.
    decision = "revert";
    reason = `${a.summary.errors} before / ${b.summary.errors} after case run(s) errored; fix the infrastructure and rerun before deciding`;
  } else if (test.verdict === "regressed" || train.verdict === "regressed") {
    decision = "revert";
    reason = `${test.verdict === "regressed" ? "test" : "train"} regressed`;
  } else if (overall.verdict !== "improved") {
    decision = "revert";
    reason = `overall ${overall.verdict}`;
  } else if (test.verdict === "n/a") {
    decision = "revert";
    reason = "no test case was graded on both sides, so nothing held out confirms the change";
  } else if (!hasTrain) {
    // Nothing to check overfitting against, so the summary says so.
    decision = "keep";
    reason = "test improved (no train split to check against)";
    warnings.push("no train split: the decision rests on test alone");
  } else if ((test.paired?.meanDelta ?? 0) <= 0) {
    // The pooled test carries the significance; the held-out split only has
    // to move the same way, which a train-only gain does not.
    decision = "revert";
    reason = "overall improved but the test split did not move with it (overfitting?)";
  } else if ((train.paired?.meanDelta ?? 0) <= 0) {
    decision = "revert";
    reason = "overall improved but the train split did not move with it";
  } else {
    decision = "keep";
    reason = "overall improved, and train and test both moved up";
  }
  const beforeUsd = a.summary.cost.totalUsd;
  const afterUsd = b.summary.cost.totalUsd;
  return {
    before: { name: a.name, createdAt: a.createdAt },
    after: { name: b.name, createdAt: b.createdAt },
    comparable: incomparable.length === 0,
    definitionChanged: changed,
    splits,
    decision,
    reason,
    cost: {
      beforeUsd,
      afterUsd,
      deltaUsd: beforeUsd !== null && afterUsd !== null ? afterUsd - beforeUsd : null,
    },
    duration: {
      beforeMeanMs: a.summary.duration.meanMs,
      afterMeanMs: b.summary.duration.meanMs,
    },
    tokens: { before: tokenTotals(a.cases), after: tokenTotals(b.cases) },
    warnings,
  };
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRate(stats: SplitStats): string {
  if (stats.passRate === null || stats.interval === null) return "n/a";
  return `${pct(stats.passRate)} [${pct(stats.interval.low)}, ${pct(stats.interval.high)}]`;
}

function fmtUsd(value: number | null): string {
  if (value === null) return "unpriced";
  // A positive cost too small for four decimals must not read as free.
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

function fmtMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

export function renderSummaryMarkdown(file: EvalResultsFile): string {
  const s = file.summary;
  const lines: string[] = [];
  lines.push(`# Eval: ${file.name}`);
  lines.push("");
  lines.push(`- Workflow: \`${file.workflow}\`${file.project ? ` (project ${file.project})` : ""}`);
  lines.push(
    `- Ran: ${file.createdAt} via ${file.mode}, ${file.reps} rep(s), split filter ${file.splitFilter}`,
  );
  lines.push(`- Case file: \`${file.caseFile}\``);
  lines.push("");
  lines.push("## Pass rate (95% Wilson interval)");
  lines.push("");
  lines.push("| Split | Cases | Passed | Failed | Errors | Pass rate |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  const rows: Array<[string, SplitStats]> = [
    ["overall", s.overall],
    ["train", s.splits.train],
    ["test", s.splits.test],
  ];
  for (const [label, stats] of rows) {
    lines.push(
      `| ${label} | ${stats.cases} | ${stats.passed} | ${stats.failed} | ${stats.errors} | ${fmtRate(stats)} |`,
    );
  }
  lines.push("");
  lines.push("## Reliability");
  lines.push("");
  lines.push(`- Errors (not graded): ${s.errors}`);
  lines.push(
    `- Grader noise: ${s.graderNoise.rate === null ? "n/a (no judge grader)" : `${pct(s.graderNoise.rate)} (${s.graderNoise.disagreements}/${s.graderNoise.judged} judged outputs with disagreeing reps)`}`,
  );
  lines.push(`- Duration: mean ${fmtMs(s.duration.meanMs)}, p95 ${fmtMs(s.duration.p95Ms)}`);
  lines.push(`- Cost: ${fmtUsd(s.cost.totalUsd)} total`);
  lines.push(
    `- Definition hash: ${s.definitionHashes.length === 0 ? "not reported" : s.definitionHashes.join(", ")}`,
  );
  lines.push("");
  if (s.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of s.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Split | Rep | Status | Detail | Duration | Cost | Run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of file.cases) {
    const detail = (c.status === "error" ? (c.error ?? c.grader.detail) : c.grader.detail)
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\s+/g, " ");
    lines.push(
      `| ${c.caseId} | ${c.split} | ${c.rep} | ${c.status} | ${detail} | ${fmtMs(c.durationMs)} | ${fmtUsd(c.costUsd)} | ${c.runId ? c.runId.slice(0, 8) : "n/a"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderComparisonText(cmp: EvalComparison): string {
  const lines: string[] = [];
  lines.push(`before: ${cmp.before.name} @ ${cmp.before.createdAt}`);
  lines.push(`after:  ${cmp.after.name} @ ${cmp.after.createdAt}`);
  lines.push("");
  for (const s of cmp.splits) {
    const delta =
      s.delta === null ? "n/a" : `${s.delta >= 0 ? "+" : ""}${(s.delta * 100).toFixed(1)} pts`;
    const paired =
      s.paired === null
        ? ""
        : `  (${s.paired.changed}/${s.paired.cases} cases changed, p=${s.paired.pValue.toFixed(3)})`;
    lines.push(
      `${s.split.padEnd(8)} ${fmtRate(s.before)} → ${fmtRate(s.after)}  ${delta}  ${s.verdict}${paired}`,
    );
  }
  lines.push("");
  const costDelta =
    cmp.cost.deltaUsd === null
      ? "unpriced"
      : `${cmp.cost.deltaUsd >= 0 ? "+" : "-"}${fmtUsd(Math.abs(cmp.cost.deltaUsd))} (${fmtUsd(cmp.cost.beforeUsd)} → ${fmtUsd(cmp.cost.afterUsd)})`;
  lines.push(`cost: ${costDelta}`);
  lines.push(
    `duration: mean ${fmtMs(cmp.duration.beforeMeanMs)} → ${fmtMs(cmp.duration.afterMeanMs)} per case run`,
  );
  const fmtTokens = (t: TokenTotals | null) =>
    t === null ? "n/a" : `${t.input} in / ${t.output} out`;
  lines.push(`tokens: ${fmtTokens(cmp.tokens.before)} → ${fmtTokens(cmp.tokens.after)}`);
  lines.push(`decision: ${cmp.decision} (${cmp.reason})`);
  for (const w of cmp.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

const gradeStatusSchema = z.enum(["pass", "fail", "error"]);
const wilsonSchema = z.object({ low: z.number(), high: z.number() }).strict();
const splitStatsSchema = z
  .object({
    cases: z.number().int().nonnegative(),
    graded: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    passRate: z.number().nullable(),
    interval: wilsonSchema.nullable(),
  })
  .strict();

// Validates a results file on the way back in, so compare works from a
// checked shape instead of trusting a hand-edited or truncated document.
export const evalResultsFileSchema: z.ZodType<EvalResultsFile> = z
  .object({
    schemaVersion: z.literal(EVAL_RESULTS_SCHEMA_VERSION),
    name: z.string().min(1),
    workflow: z.string().min(1),
    project: z.string().nullable(),
    caseFile: z.string(),
    caseSetHash: z.string().min(1),
    createdAt: z.string(),
    mode: z.enum(["http", "in-process"]),
    reps: z.number().int().positive(),
    splitFilter: z.enum(["train", "test", "all"]),
    provider: z.string().nullable().optional(),
    keelsonVersion: z.string().nullable().optional(),
    cases: z.array(
      z
        .object({
          caseId: z.string(),
          split: z.enum(EVAL_SPLITS),
          rep: z.number().int().positive(),
          runId: z.string().nullable(),
          status: gradeStatusSchema,
          grader: z
            .object({
              type: z.enum(EVAL_GRADER_TYPES),
              detail: z.string(),
              judge: z
                .object({
                  reps: z.number().int(),
                  verdicts: z.array(gradeStatusSchema),
                  disagreement: z.boolean(),
                  claims: z.array(
                    z
                      .object({ claim: z.string(), met: z.boolean(), evidence: z.string() })
                      .strict(),
                  ),
                })
                .strict()
                .optional(),
            })
            .strict(),
          output: z
            .object({ text: z.string(), truncated: z.boolean(), path: z.string().nullable() })
            .strict(),
          durationMs: z.number().nullable(),
          tokens: z.object({ input: z.number(), output: z.number() }).strict().nullable(),
          costUsd: z.number().nullable(),
          definitionHash: z.string().nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
    summary: z
      .object({
        overall: splitStatsSchema,
        splits: z.object({ train: splitStatsSchema, test: splitStatsSchema }).strict(),
        errors: z.number().int().nonnegative(),
        graderNoise: z
          .object({
            judged: z.number().int().nonnegative(),
            disagreements: z.number().int().nonnegative(),
            rate: z.number().nullable(),
          })
          .strict(),
        duration: z
          .object({ meanMs: z.number().nullable(), p95Ms: z.number().nullable() })
          .strict(),
        cost: z
          .object({
            totalUsd: z.number().nullable(),
            perCaseUsd: z.record(z.string(), z.number().nullable()),
          })
          .strict(),
        definitionHashes: z.array(z.string()),
        warnings: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

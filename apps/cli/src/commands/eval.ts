// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  compareResults,
  discoverWorkflows,
  EvalCaseFileError,
  type EvalCaseSet,
  type EvalResultsFile,
  type EvalSplit,
  evalResultsFileSchema,
  type JudgeFn,
  parseEvalCaseFile,
  renderComparisonText,
  renderSummaryMarkdown,
} from "@keelson/workflows";
import {
  type CaseExecutor,
  makeHttpExecutor,
  makeInProcessExecutor,
  resolveProjectId,
} from "../eval/execute.ts";
import { runEval, selectCases } from "../eval/runner.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { isServerDownError, workflowExists } from "../http/workflow-client.ts";
import { chatHeadless } from "../in-process/chat.ts";
import { bootstrapCliProviders, pickDefaultProvider } from "../in-process/providers.ts";
import { emit } from "../output.ts";
import { workflowDiscoveryRoots } from "../paths.ts";
import { gateSchemaSkew } from "../schema-gate.ts";
import { probeServer } from "../server-probe.ts";

export interface EvalRunOptions {
  json: boolean;
  reps?: number;
  split?: string;
  out?: string;
  watch?: boolean;
  provider?: string;
  baseUrl?: string;
  preflight?: boolean;
  // Test seam: bypasses the server probe and workflow lookup.
  executor?: CaseExecutor;
  judge?: JudgeFn;
}

export interface EvalCompareOptions {
  json: boolean;
}

export interface EvalInitOptions {
  json: boolean;
  out?: string;
}

export function evalsDir(home: string = resolveKeelsonHome()): string {
  return join(home, "evals");
}

function fail(message: string, code: string, json: boolean, exit: number): never {
  emit({ error: message, code }, { json });
  process.exit(exit);
}

function readCaseSet(file: string, json: boolean): { caseSet: EvalCaseSet; path: string } {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    fail(
      `cannot read case file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      "BAD_INPUTS",
      json,
      EXIT_BAD_ARGS,
    );
  }
  try {
    return { caseSet: parseEvalCaseFile(content, path), path };
  } catch (err) {
    if (err instanceof EvalCaseFileError) fail(err.message, "BAD_INPUTS", json, EXIT_BAD_ARGS);
    throw err;
  }
}

function parseSplit(raw: string | undefined, json: boolean): EvalSplit | "all" {
  if (raw === undefined) return "all";
  if (raw === "train" || raw === "test" || raw === "all") return raw;
  fail(`--split must be train, test, or all (got '${raw}')`, "BAD_INPUTS", json, EXIT_BAD_ARGS);
}

// Results land as <stamp>.json + <stamp>.md + <stamp>.outputs/ so one eval's
// files sort together; colons are dropped from the stamp for Windows paths.
function resultPaths(caseSet: EvalCaseSet, out: string | undefined, now: Date) {
  const stamp = now.toISOString().replace(/:/g, "-");
  const jsonPath =
    out !== undefined
      ? isAbsolute(out)
        ? out
        : resolve(process.cwd(), out)
      : join(evalsDir(), caseSet.name, `${stamp}.json`);
  const stem = jsonPath.endsWith(".json") ? jsonPath.slice(0, -".json".length) : jsonPath;
  return { jsonPath, mdPath: `${stem}.md`, outputsDir: `${stem}.outputs` };
}

function resolveWatch(opts: EvalRunOptions): boolean {
  if (opts.watch === false) return false;
  if (opts.watch === true) return true;
  return process.stdout.isTTY === true;
}

// Providers whose SDK honors `allowedTools: []`, so a judge turn over
// workflow-controlled text cannot be prompt-injected into touching the checkout.
export const JUDGE_PROVIDERS: ReadonlySet<string> = new Set(["stub", "claude", "copilot"]);

export function judgeProviderError(id: string): string | null {
  return JUDGE_PROVIDERS.has(id)
    ? null
    : `judge provider '${id}' cannot run without tools; use one of ${[...JUDGE_PROVIDERS].join(", ")}`;
}

function resolveJudgeDefaultProvider(): string {
  bootstrapCliProviders();
  return pickDefaultProvider();
}

function makeJudge(cwd: string): JudgeFn {
  return async ({ prompt, provider, model, timeoutMs }) => {
    const providerId = provider ?? resolveJudgeDefaultProvider();
    const rejection = judgeProviderError(providerId);
    if (rejection !== null) throw new Error(rejection);
    const result = await chatHeadless({
      message: prompt,
      cwd,
      provider: providerId,
      allowedTools: [],
      ...(model !== undefined ? { model } : {}),
      ...(timeoutMs !== undefined ? { abortSignal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    return result.text;
  };
}

async function resolveExecutor(
  caseSet: EvalCaseSet,
  opts: EvalRunOptions,
): Promise<{ executor: CaseExecutor; mode: "http" | "in-process" }> {
  if (opts.executor !== undefined) return { executor: opts.executor, mode: "in-process" };
  const info = opts.baseUrl ? null : await probeServer();
  const effectiveBase = opts.baseUrl ?? info?.baseUrl;
  if (effectiveBase) {
    await gateSchemaSkew(effectiveBase, info?.schemaVersion, opts.json);
    try {
      let projectId: string | undefined;
      if (caseSet.project !== undefined) {
        const id = await resolveProjectId(effectiveBase, caseSet.project);
        if (id === null) {
          fail(
            `no project named '${caseSet.project}'`,
            "PROJECT_NOT_FOUND",
            opts.json,
            EXIT_NOT_FOUND,
          );
        }
        projectId = id;
      }
      if (!(await workflowExists(effectiveBase, caseSet.workflow, projectId))) {
        fail(
          `no workflow named '${caseSet.workflow}'${caseSet.project !== undefined ? ` in project '${caseSet.project}'` : " in the server catalog"}`,
          "WORKFLOW_NOT_FOUND",
          opts.json,
          EXIT_NOT_FOUND,
        );
      }
      return {
        mode: "http",
        executor: makeHttpExecutor({
          workflow: caseSet.workflow,
          baseUrl: effectiveBase,
          ...(projectId !== undefined ? { projectId } : { workingDir: process.cwd() }),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.preflight !== undefined ? { preflight: opts.preflight } : {}),
        }),
      };
    } catch (err) {
      if (isServerDownError(err)) {
        fail(`server at ${effectiveBase} is not reachable`, "NO_SERVER", opts.json, EXIT_NO_SERVER);
      }
      throw err;
    }
  }
  if (caseSet.project !== undefined) {
    fail(
      `project '${caseSet.project}' requires the server (run \`keelson start\`)`,
      "NO_SERVER",
      opts.json,
      EXIT_NO_SERVER,
    );
  }
  const roots = workflowDiscoveryRoots();
  const found = discoverWorkflows(roots).workflows.some(
    (w) => w.workflow.name === caseSet.workflow,
  );
  if (!found) {
    fail(
      `no workflow named '${caseSet.workflow}' under ${roots.map((r) => r.dir).join(", ")}`,
      "WORKFLOW_NOT_FOUND",
      opts.json,
      EXIT_NOT_FOUND,
    );
  }
  return {
    mode: "in-process",
    executor: makeInProcessExecutor({
      workflow: caseSet.workflow,
      cwd: process.cwd(),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.preflight !== undefined ? { preflight: opts.preflight } : {}),
    }),
  };
}

function writeResults(results: EvalResultsFile, paths: ReturnType<typeof resultPaths>): void {
  mkdirSync(dirname(paths.jsonPath), { recursive: true });
  writeFileSync(paths.jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(paths.mdPath, renderSummaryMarkdown(results));
}

export async function runEvalRun(file: string, opts: EvalRunOptions): Promise<never> {
  const { caseSet, path } = readCaseSet(file, opts.json);
  const split = parseSplit(opts.split, opts.json);
  const reps = opts.reps ?? caseSet.reps;
  if (!Number.isInteger(reps) || reps < 1) {
    fail(
      `--reps must be a positive integer (got '${opts.reps}')`,
      "BAD_INPUTS",
      opts.json,
      EXIT_BAD_ARGS,
    );
  }
  if (selectCases(caseSet.cases, split).length === 0) {
    fail(`no cases in split '${split}'`, "BAD_INPUTS", opts.json, EXIT_BAD_ARGS);
  }
  const { executor, mode } = await resolveExecutor(caseSet, opts);
  const watch = resolveWatch(opts);
  const now = new Date();
  const paths = resultPaths(caseSet, opts.out, now);
  const human = !opts.json;
  if (human) {
    process.stdout.write(
      `◆ eval ${caseSet.name}: workflow=${caseSet.workflow} mode=${mode} reps=${reps} split=${split}\n`,
    );
  }
  const results = await runEval({
    caseSet,
    caseFile: path,
    reps,
    split,
    mode,
    executor,
    graderDeps: { cwd: process.cwd(), judge: opts.judge ?? makeJudge(process.cwd()) },
    outputsDir: paths.outputsDir,
    now: () => now,
    ...(human ? { onProgress: (line) => process.stdout.write(`${line}\n`) } : {}),
    ...(human && watch ? { onNodeEvent: (line) => process.stdout.write(`${line}\n`) } : {}),
  });
  writeResults(results, paths);
  if (opts.json) {
    emit(
      {
        data: {
          resultsPath: paths.jsonPath,
          summaryPath: paths.mdPath,
          mode,
          summary: results.summary,
          cases: results.cases.map((c) => ({
            caseId: c.caseId,
            split: c.split,
            rep: c.rep,
            runId: c.runId,
            status: c.status,
            detail: c.grader.detail,
            error: c.error,
          })),
        },
      },
      { json: true },
    );
  } else {
    process.stdout.write(`\n${renderSummaryMarkdown(results)}\n`);
    process.stdout.write(`results: ${paths.jsonPath}\nsummary: ${paths.mdPath}\n`);
  }
  process.exit(results.summary.errors > 0 ? EXIT_FAIL : EXIT_OK);
}

function readResults(file: string, json: boolean): EvalResultsFile {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(
      `cannot read results file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      "BAD_INPUTS",
      json,
      EXIT_BAD_ARGS,
    );
  }
  const checked = evalResultsFileSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue ? `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}` : "";
    fail(
      `${path} is not a keelson eval results file (${where})`,
      "BAD_INPUTS",
      json,
      EXIT_BAD_ARGS,
    );
  }
  return checked.data;
}

export async function runEvalCompare(
  a: string,
  b: string,
  opts: EvalCompareOptions,
): Promise<never> {
  const before = readResults(a, opts.json);
  const after = readResults(b, opts.json);
  const comparison = compareResults(before, after);
  if (!comparison.comparable) {
    fail(comparison.reason, "NOT_COMPARABLE", opts.json, EXIT_BAD_ARGS);
  }
  if (opts.json) {
    emit({ data: comparison }, { json: true });
  } else {
    process.stdout.write(`${renderComparisonText(comparison)}\n`);
  }
  process.exit(EXIT_OK);
}

export function scaffoldCaseFile(workflow: string): string {
  return `# Eval case set for the '${workflow}' workflow.
# Run:     keelson eval run <this file>
# Compare: keelson eval compare <before.json> <after.json>
name: ${JSON.stringify(workflow)}
workflow: ${JSON.stringify(workflow)}
# project: my-project        # as \`workflow run --project\`
reps: 1

# Hold cases back from the tuning loop so a change that only helps the
# cases you stared at shows up as a train/test gap.
split:
  train: [case-1, case-2]
  test: [case-3]

# Default grader; a case may override with its own \`grader:\` block.
grader:
  type: contains
# Other graders:
#   { type: exact }        expect.text      (final output equals, trimmed)
#   { type: regex }        expect.pattern   (+ optional expect.flags)
#   { type: json_schema }  expect.schema    (output_schema subset: type/required/properties/items)
#   { type: bash }         expect.script    (exit 0 pass, 1 fail, other error;
#                                            env EVAL_OUTPUT, EVAL_OUTPUT_FILE, EVAL_CASE_ID,
#                                            EVAL_RUN_ID, EVAL_EXPECT_<KEY>)
#   { type: judge, grader_reps: 2 }  expect.claims  (checkable claims, every one must be met)

cases:
  - id: case-1
    arguments: "replace with the free text the workflow receives as $ARGUMENTS"
    expect:
      strings: ["replace with a string the output must contain"]
  - id: case-2
    inputs:
      key: value               # arrives as KEELSON_INPUTS_key
    expect:
      strings: ["another required string"]
  - id: case-3
    arguments: "a harder case the workflow should still handle"
    expect:
      strings: ["a third required string"]
`;
}

export async function runEvalInit(workflow: string, opts: EvalInitOptions): Promise<never> {
  const name = workflow.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    fail(`invalid workflow name '${workflow}'`, "BAD_INPUTS", opts.json, EXIT_BAD_ARGS);
  }
  const target =
    opts.out !== undefined
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(process.cwd(), opts.out)
      : join(evalsDir(), `${name}.eval.yaml`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, scaffoldCaseFile(name), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      fail(`refusing to overwrite ${target}`, "FILE_EXISTS", opts.json, EXIT_FAIL);
    }
    throw err;
  }
  emit({ data: { path: target, file: basename(target) } }, { json: opts.json });
  process.exit(EXIT_OK);
}

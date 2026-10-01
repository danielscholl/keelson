// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignSplits,
  caseSetFingerprint,
  EvalCaseFileError,
  parseEvalCaseFile,
} from "./case-file.ts";
import {
  buildJudgePrompt,
  extractJson,
  type GradeInput,
  gradeOutput,
  parseJudgeResponse,
} from "./graders.ts";
import {
  compareResults,
  type EvalCaseResult,
  type EvalResultsFile,
  evalResultsFileSchema,
  renderComparisonText,
  renderSummaryMarkdown,
  summarize,
} from "./results.ts";
import { percentile, wilsonInterval } from "./stats.ts";

const BASE = `
name: demo
workflow: smoke-test
grader:
  type: contains
cases:
  - id: c1
    arguments: hello
    expect: { strings: ["ok"] }
  - id: c2
    expect: { strings: ["ok"] }
  - id: c3
    expect: { strings: ["ok"] }
  - id: c4
    expect: { strings: ["ok"] }
`;

describe("parseEvalCaseFile", () => {
  test("parses a valid file with defaults", () => {
    const set = parseEvalCaseFile(BASE, "demo.yaml");
    expect(set.name).toBe("demo");
    expect(set.reps).toBe(1);
    expect(set.cases).toHaveLength(4);
    expect(set.cases[0]?.inputs).toEqual({ ARGUMENTS: "hello" });
    expect(set.cases.every((c) => c.split === "test")).toBe(true);
    expect(set.cases[1]?.grader.type).toBe("contains");
  });

  test("rejects an unknown grader type", () => {
    const text = BASE.replace("type: contains", "type: vibes");
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(EvalCaseFileError);
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/grader\.type/);
  });

  test("rejects overlapping splits", () => {
    const text = `${BASE}split:\n  train: [c1, c2]\n  test: [c2, c3, c4]\n`;
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/both train and test/);
  });

  test("rejects a case missing from explicit splits", () => {
    const text = `${BASE}split:\n  train: [c1]\n  test: [c2, c3]\n`;
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/neither split/);
  });

  test("rejects an unknown id in a split", () => {
    const text = `${BASE}split:\n  train: [zz]\n  test: [c1, c2, c3, c4]\n`;
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/unknown case 'zz'/);
  });

  test("explicit splits assign each case", () => {
    const text = `${BASE}split:\n  train: [c1, c2]\n  test: [c3, c4]\n`;
    const set = parseEvalCaseFile(text, "demo.yaml");
    expect(set.cases.map((c) => c.split)).toEqual(["train", "train", "test", "test"]);
  });

  test("seeded split is deterministic and honors the fraction", () => {
    const a = assignSplits(["c1", "c2", "c3", "c4"], { seed: 42, train_fraction: 0.5 });
    const b = assignSplits(["c4", "c3", "c2", "c1"], { seed: 42, train_fraction: 0.5 });
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect([...a.values()].filter((s) => s === "train")).toHaveLength(2);
    const c = assignSplits(["c1", "c2", "c3", "c4"], { seed: 7, train_fraction: 0.5 });
    expect([...a.values()].filter((s) => s === "train")).toHaveLength(2);
    expect(c.size).toBe(4);
  });

  test("rejects expect that does not fit the grader", () => {
    const text = BASE.replace(
      'expect: { strings: ["ok"] }\n  - id: c2',
      "expect: { text: x }\n  - id: c2",
    );
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/case 'c1'.*strings/);
  });

  test("rejects duplicate case ids", () => {
    const text = BASE.replace("id: c4", "id: c3");
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/duplicate case id 'c3'/);
  });

  test("a case without any grader is rejected", () => {
    const text = BASE.replace("grader:\n  type: contains\n", "");
    expect(() => parseEvalCaseFile(text, "demo.yaml")).toThrow(/no grader/);
  });

  test("a case-level grader override wins and judge-only fields are gated", () => {
    const text = `${BASE.replace('expect: { strings: ["ok"] }\n  - id: c2', 'expect: { text: "ok" }\n    grader: { type: exact }\n  - id: c2')}`;
    const set = parseEvalCaseFile(text, "demo.yaml");
    expect(set.cases[0]?.grader.type).toBe("exact");
    const bad = BASE.replace("type: contains", "type: contains\n  grader_reps: 3");
    expect(() => parseEvalCaseFile(bad, "demo.yaml")).toThrow(/only valid on the judge/);
  });

  test("fingerprint ignores key order and comments but tracks expectations", () => {
    const a = caseSetFingerprint(parseEvalCaseFile(BASE, "a.yaml"));
    const reordered = BASE.replace(
      "name: demo\nworkflow: smoke-test",
      "workflow: smoke-test\nname: demo",
    );
    expect(caseSetFingerprint(parseEvalCaseFile(`# comment\n${reordered}`, "b.yaml"))).toBe(a);
    const changed = BASE.replace(
      'expect: { strings: ["ok"] }\n  - id: c2',
      'expect: { strings: ["no"] }\n  - id: c2',
    );
    expect(caseSetFingerprint(parseEvalCaseFile(changed, "c.yaml"))).not.toBe(a);
  });

  test("json_schema expect is validated against the output_schema subset", () => {
    const text = `
name: demo
workflow: w
grader: { type: json_schema }
cases:
  - id: c1
    expect:
      schema: { type: object, required: [status], properties: { status: { type: string } } }
`;
    expect(parseEvalCaseFile(text, "demo.yaml").cases[0]?.grader.type).toBe("json_schema");
    const bad = text.replace("type: object", "type: blob");
    expect(() => parseEvalCaseFile(bad, "demo.yaml")).toThrow(/schema/);
  });
});

function input(overrides: Partial<GradeInput>): GradeInput {
  return {
    caseId: "c1",
    runId: "run-1",
    output: "",
    outputFile: "",
    expect: {},
    grader: { type: "exact" },
    ...overrides,
  };
}

describe("graders", () => {
  const cwd = process.cwd();

  test("exact trims and compares", async () => {
    const pass = await gradeOutput(
      input({ output: "  ok\n", expect: { text: "ok" }, grader: { type: "exact" } }),
      { cwd },
    );
    expect(pass.status).toBe("pass");
    const fail = await gradeOutput(
      input({ output: "nope", expect: { text: "ok" }, grader: { type: "exact" } }),
      { cwd },
    );
    expect(fail.status).toBe("fail");
  });

  test("contains requires every string", async () => {
    const grader = { type: "contains" as const };
    const pass = await gradeOutput(
      input({ output: "alpha beta", expect: { strings: ["alpha", "beta"] }, grader }),
      { cwd },
    );
    expect(pass.status).toBe("pass");
    const fail = await gradeOutput(
      input({ output: "alpha", expect: { strings: ["alpha", "beta"] }, grader }),
      { cwd },
    );
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain('"beta"');
  });

  test("regex honors flags", async () => {
    const grader = { type: "regex" as const };
    const pass = await gradeOutput(
      input({ output: "Result: OK", expect: { pattern: "^result: ok$", flags: "i" }, grader }),
      { cwd },
    );
    expect(pass.status).toBe("pass");
    const fail = await gradeOutput(
      input({ output: "Result: OK", expect: { pattern: "^result: ok$" }, grader }),
      { cwd },
    );
    expect(fail.status).toBe("fail");
  });

  test("json_schema parses fenced JSON and validates", async () => {
    const grader = { type: "json_schema" as const };
    const expect_ = {
      schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
    };
    const pass = await gradeOutput(
      input({ output: 'Here you go:\n```json\n{"status":"ok"}\n```', expect: expect_, grader }),
      { cwd },
    );
    expect(pass.status).toBe("pass");
    const wrongShape = await gradeOutput(
      input({ output: '{"status": 3}', expect: expect_, grader }),
      { cwd },
    );
    expect(wrongShape.status).toBe("fail");
    expect(wrongShape.detail).toContain("expected string");
    const notJson = await gradeOutput(input({ output: "plain text", expect: expect_, grader }), {
      cwd,
    });
    expect(notJson.status).toBe("fail");
  });

  test("bash maps exit 0/1/other to pass/fail/error and exposes the env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-eval-bash-"));
    const outputFile = join(dir, "out.txt");
    writeFileSync(outputFile, "file body");
    const grader = { type: "bash" as const };
    const script =
      '[ "$EVAL_OUTPUT" = "hello" ] && [ "$EVAL_CASE_ID" = "c1" ] && [ "$EVAL_RUN_ID" = "run-1" ] && [ "$EVAL_EXPECT_LIMIT" = "3" ] && [ "$(cat "$EVAL_OUTPUT_FILE")" = "file body" ]';
    const pass = await gradeOutput(
      input({ output: "hello", outputFile, expect: { script, limit: 3 }, grader }),
      { cwd },
    );
    expect(pass.status).toBe("pass");
    const fail = await gradeOutput(
      input({ output: "bye", outputFile, expect: { script, limit: 3 }, grader }),
      { cwd },
    );
    expect(fail.status).toBe("fail");
    const error = await gradeOutput(
      input({ output: "x", outputFile, expect: { script: "echo boom >&2; exit 2" }, grader }),
      { cwd },
    );
    expect(error.status).toBe("error");
    expect(error.detail).toContain("exit 2");
    expect(error.detail).toContain("boom");
  });

  test("judge passes only when every claim is met and reports disagreement", async () => {
    const claims = ["mentions alpha", "mentions beta"];
    const grader = { type: "judge" as const };
    const allMet = JSON.stringify({
      claims: claims.map((claim) => ({ claim, met: true, evidence: "yes" })),
    });
    const oneUnmet = JSON.stringify({
      claims: [
        { claim: claims[0], met: true, evidence: "yes" },
        { claim: claims[1], met: false, evidence: "beta absent" },
      ],
    });
    const prompts: string[] = [];
    const steady = await gradeOutput(input({ output: "alpha beta", expect: { claims }, grader }), {
      cwd,
      judge: async ({ prompt }) => {
        prompts.push(prompt);
        return `Sure:\n${allMet}`;
      },
    });
    expect(steady.status).toBe("pass");
    expect(steady.judge?.reps).toBe(2);
    expect(steady.judge?.disagreement).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("1. mentions alpha");
    expect(prompts[0]).not.toContain("secret");

    let call = 0;
    const noisy = await gradeOutput(input({ output: "alpha", expect: { claims }, grader }), {
      cwd,
      judge: async () => (call++ === 0 ? allMet : oneUnmet),
    });
    expect(noisy.status).toBe("fail");
    expect(noisy.judge?.disagreement).toBe(true);
    expect(noisy.detail).toContain("disagree");

    const broken = await gradeOutput(input({ output: "alpha", expect: { claims }, grader }), {
      cwd,
      judge: async () => "I cannot grade this.",
    });
    expect(broken.status).toBe("error");

    let flaky = 0;
    const oneRepFailed = await gradeOutput(input({ output: "alpha", expect: { claims }, grader }), {
      cwd,
      judge: async () => {
        if (flaky++ === 0) return allMet;
        throw new Error("provider timeout");
      },
    });
    expect(oneRepFailed.status).toBe("error");
    expect(oneRepFailed.detail).toContain("1/2 rep(s)");

    const unwired = await gradeOutput(input({ output: "alpha", expect: { claims }, grader }), {
      cwd,
    });
    expect(unwired.status).toBe("error");
  });

  test("extractJson reads a fenced block without a regex", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson("```\n[1,2]\n```")).toEqual({ ok: true, value: [1, 2] });
    expect(extractJson(`${"```"}${" ".repeat(5000)}`).ok).toBe(false);
  });

  test("judge prompt carries only the claims, never other expect fields", () => {
    const prompt = buildJudgePrompt("out", ["c1"]);
    expect(prompt).toContain("c1");
    expect(prompt).toContain("OUTPUT:");
    const parsed = parseJudgeResponse('{"claims":[{"met":true}]}', ["c1"]);
    expect(parsed.ok).toBe(true);
    const short = parseJudgeResponse('{"claims":[]}', ["c1"]);
    expect(short.ok).toBe(false);
  });
});

describe("stats", () => {
  test("wilson interval matches known values", () => {
    const i = wilsonInterval(8, 10);
    expect(i).not.toBeNull();
    expect(i?.low).toBeCloseTo(0.4902, 3);
    expect(i?.high).toBeCloseTo(0.9433, 3);
    const zero = wilsonInterval(0, 10);
    expect(zero?.low).toBe(0);
    expect(zero?.high).toBeCloseTo(0.2775, 3);
    const full = wilsonInterval(10, 10);
    expect(full?.high).toBe(1);
    expect(full?.low).toBeCloseTo(0.7225, 3);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  test("p95 is nearest-rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 95)).toBeNull();
  });
});

function result(overrides: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    caseId: "c1",
    split: "test",
    rep: 1,
    runId: "run-00000001",
    status: "pass",
    grader: { type: "contains", detail: "ok" },
    output: { text: "ok", truncated: false, path: null },
    durationMs: 100,
    tokens: null,
    costUsd: null,
    definitionHash: null,
    error: null,
    ...overrides,
  };
}

function file(cases: EvalCaseResult[], overrides: Partial<EvalResultsFile> = {}): EvalResultsFile {
  return {
    schemaVersion: 1,
    name: "demo",
    workflow: "w",
    project: null,
    caseFile: "demo.yaml",
    caseSetHash: "deadbeef",
    createdAt: "2026-09-30T00:00:00.000Z",
    mode: "in-process",
    reps: 1,
    splitFilter: "all",
    cases,
    summary: summarize(cases),
    ...overrides,
  };
}

function batch(
  split: "train" | "test",
  passes: number,
  fails: number,
  errors = 0,
): EvalCaseResult[] {
  const out: EvalCaseResult[] = [];
  let i = 0;
  for (let k = 0; k < passes; k++)
    out.push(result({ caseId: `${split}${i++}`, split, status: "pass" }));
  for (let k = 0; k < fails; k++)
    out.push(result({ caseId: `${split}${i++}`, split, status: "fail" }));
  for (let k = 0; k < errors; k++)
    out.push(result({ caseId: `${split}${i++}`, split, status: "error", error: "timeout" }));
  return out;
}

describe("summarize", () => {
  test("errors are a third state and never count as graded", () => {
    const s = summarize([...batch("test", 2, 1, 1)]);
    expect(s.overall.graded).toBe(3);
    expect(s.overall.errors).toBe(1);
    expect(s.overall.passRate).toBeCloseTo(2 / 3, 5);
    expect(s.errors).toBe(1);
    expect(s.warnings.some((w) => w.startsWith("ERRORS"))).toBe(true);
  });

  test("warns on headroom, noise, and multiple definition hashes", () => {
    const headroom = summarize(batch("test", 40, 0));
    expect(headroom.warnings.some((w) => w.startsWith("HEADROOM"))).toBe(true);
    const noisy = summarize(batch("test", 2, 2));
    expect(noisy.warnings.some((w) => w.startsWith("NOISE"))).toBe(true);
    const hashes = summarize([
      result({ definitionHash: "aaa" }),
      result({ caseId: "c2", definitionHash: "bbb" }),
    ]);
    expect(hashes.definitionHashes).toEqual(["aaa", "bbb"]);
    expect(hashes.warnings.some((w) => w.startsWith("HASH"))).toBe(true);
  });

  test("cost stays null when unpriced and sums per case when priced", () => {
    const unpriced = summarize(batch("test", 1, 0));
    expect(unpriced.cost.totalUsd).toBeNull();
    expect(unpriced.cost.perCaseUsd.test0).toBeNull();
    const mixed = summarize([
      result({ caseId: "a", costUsd: 0.01 }),
      result({ caseId: "a", rep: 2, costUsd: 0.02 }),
      result({ caseId: "b", costUsd: null }),
      result({ caseId: "c", costUsd: null }),
      result({ caseId: "c", rep: 2, costUsd: 0.5 }),
    ]);
    expect(mixed.cost.totalUsd).toBeNull();
    expect(mixed.cost.perCaseUsd.a).toBeCloseTo(0.03, 6);
    expect(mixed.cost.perCaseUsd.b).toBeNull();
    expect(mixed.cost.perCaseUsd.c).toBeNull();
    const priced = summarize([
      result({ caseId: "a", costUsd: 0.01 }),
      result({ caseId: "b", costUsd: 0.02 }),
    ]);
    expect(priced.cost.totalUsd).toBeCloseTo(0.03, 6);
  });

  test("grader noise rate counts judge disagreements", () => {
    const judge = { reps: 2, verdicts: ["pass", "fail"] as const, disagreement: true, claims: [] };
    const s = summarize([
      result({ grader: { type: "judge", detail: "x", judge } }),
      result({
        caseId: "c2",
        grader: { type: "judge", detail: "x", judge: { ...judge, disagreement: false } },
      }),
    ]);
    expect(s.graderNoise.judged).toBe(2);
    expect(s.graderNoise.disagreements).toBe(1);
    expect(s.graderNoise.rate).toBe(0.5);
  });

  test("markdown escapes pipes and backslashes in details", () => {
    const md = renderSummaryMarkdown(
      file([result({ grader: { type: "contains", detail: String.raw`a|b\c` } })]),
    );
    expect(md).toContain(String.raw`a\|b\\c`);
  });

  test("markdown summary renders the headline table and warnings", () => {
    const md = renderSummaryMarkdown(file([...batch("train", 3, 1), ...batch("test", 2, 2, 1)]));
    expect(md).toContain("# Eval: demo");
    expect(md).toContain("| overall | 9 | 5 | 3 | 1 |");
    expect(md).toContain("| train | 4 | 3 | 1 | 0 | 75.0% [");
    expect(md).toContain("## Warnings");
    expect(md).toContain("- Cost: unpriced total");
    expect(md).toContain("| test4 | test | 1 | error | timeout |");
  });
});

describe("compareResults", () => {
  test("identical files are within-noise and revert", () => {
    const a = file([...batch("train", 5, 5), ...batch("test", 5, 5)]);
    const cmp = compareResults(a, a);
    expect(cmp.splits.map((s) => s.verdict)).toEqual([
      "within-noise",
      "within-noise",
      "within-noise",
    ]);
    expect(cmp.decision).toBe("revert");
    expect(renderComparisonText(cmp)).toContain("decision: revert");
  });

  test("keep only when train and test both improve past the intervals", () => {
    const before = file([...batch("train", 5, 25), ...batch("test", 5, 25)]);
    const after = file([...batch("train", 25, 5), ...batch("test", 25, 5)]);
    const cmp = compareResults(before, after);
    expect(cmp.splits.find((s) => s.split === "train")?.verdict).toBe("improved");
    expect(cmp.splits.find((s) => s.split === "test")?.verdict).toBe("improved");
    expect(cmp.decision).toBe("keep");
    expect(compareResults(after, before).decision).toBe("revert");
    expect(compareResults(after, before).splits[2]?.verdict).toBe("regressed");
  });

  test("train improved but test flat is revert (overfitting)", () => {
    const before = file([...batch("train", 5, 25), ...batch("test", 15, 15)]);
    const after = file([...batch("train", 25, 5), ...batch("test", 16, 14)]);
    const cmp = compareResults(before, after);
    expect(cmp.decision).toBe("revert");
    expect(cmp.reason).toContain("test within-noise");
  });

  test("without a train split the test split decides and a warning says so", () => {
    const before = file(batch("test", 5, 25));
    const after = file(batch("test", 25, 5));
    const cmp = compareResults(before, after);
    expect(cmp.decision).toBe("keep");
    expect(cmp.warnings).toContain("no train split: the decision rests on test alone");
  });

  test("errored runs on either side force revert", () => {
    const before = file([...batch("train", 5, 25), ...batch("test", 5, 25)]);
    const after = file([...batch("train", 25, 5), ...batch("test", 25, 5, 1)]);
    const cmp = compareResults(before, after);
    expect(cmp.comparable).toBe(true);
    expect(cmp.decision).toBe("revert");
    expect(cmp.reason).toContain("errored");
  });

  test("different case sets or split filters are not comparable", () => {
    const a = file(batch("test", 5, 5));
    const b = file(batch("test", 10, 0), { caseSetHash: "other" });
    const cmp = compareResults(a, b);
    expect(cmp.comparable).toBe(false);
    expect(cmp.decision).toBe("revert");
    expect(cmp.reason).toContain("case sets differ");
    const c = file(batch("test", 10, 0), { splitFilter: "test" });
    expect(compareResults(a, c).comparable).toBe(false);
    expect(evalResultsFileSchema.safeParse({ ...a, summary: null }).success).toBe(false);
    expect(evalResultsFileSchema.safeParse(a).success).toBe(true);
  });

  test("cost delta is null when either side is unpriced", () => {
    const a = file(batch("test", 5, 5));
    const b = file([result({ costUsd: 0.5 })]);
    expect(compareResults(a, b).cost.deltaUsd).toBeNull();
    expect(compareResults(b, b).cost.deltaUsd).toBe(0);
  });
});

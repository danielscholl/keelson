// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { clearRegistry } from "@keelson/providers";
import { parseEvalCaseFile } from "@keelson/workflows";

import { judgeProviderError } from "../src/commands/eval.ts";
import { type CaseExecution, fetchRunCostUsd, makeInProcessExecutor } from "../src/eval/execute.ts";
import { caseOutputBasename, runEval } from "../src/eval/runner.ts";
import { spawnEnv } from "./spawn-env.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

const CASE_FILE = `
name: smoke-bash
workflow: smoke-bash
grader:
  type: contains
split:
  train: [greets]
  test: [greets-again, wrong]
cases:
  - id: greets
    expect: { strings: ["hello from"] }
  - id: greets-again
    inputs: { TEST_NAME: cli }
    expect: { strings: ["hello from"] }
  - id: wrong
    expect: { strings: ["goodbye"] }
`;

function execution(overrides: Partial<CaseExecution>): CaseExecution {
  return {
    runId: "11111111-2222-3333-4444-555555555555",
    runStatus: "succeeded",
    error: null,
    finalOutput: "final text",
    nodeOutputs: { first: '{"status":"ok"}', last: "final text" },
    durationMs: 10,
    tokens: { input: 3, output: 2 },
    costUsd: null,
    definitionHash: "abc",
    ...overrides,
  };
}

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["KEELSON_PROVIDERS", "KEELSON_WORKFLOW_PROVIDER", "KEELSON_HOME"] as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keelson-eval-cli-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.KEELSON_PROVIDERS = "stub";
  delete process.env.KEELSON_WORKFLOW_PROVIDER;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearRegistry();
  rmSync(tmp, { recursive: true, force: true });
});

describe("runEval", () => {
  test("grades the final output, a named node, and keeps errors apart from fails", async () => {
    const caseSet = parseEvalCaseFile(
      `
name: fake
workflow: fake
grader: { type: contains }
cases:
  - id: final
    expect: { strings: ["final"] }
  - id: node
    node: first
    grader: { type: json_schema }
    expect: { schema: { type: object, required: [status] } }
  - id: missing-node
    node: nope
    expect: { strings: ["x"] }
  - id: fails
    expect: { strings: ["absent"] }
  - id: errors
    expect: { strings: ["final"] }
`,
      "fake.yaml",
    );
    const seen: string[] = [];
    const results = await runEval({
      caseSet,
      caseFile: "fake.yaml",
      reps: 2,
      split: "all",
      mode: "in-process",
      executor: async ({ inputs }) => {
        seen.push(JSON.stringify(inputs));
        return seen.length % 5 === 0
          ? execution({ runStatus: "failed", error: "run failed", finalOutput: null })
          : execution({});
      },
      graderDeps: { cwd: tmp },
      outputsDir: join(tmp, "outputs"),
      now: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    expect(results.cases).toHaveLength(10);
    const byId = (id: string) => results.cases.filter((c) => c.caseId === id).map((c) => c.status);
    expect(byId("final")).toEqual(["pass", "pass"]);
    expect(byId("node")).toEqual(["pass", "pass"]);
    expect(byId("missing-node")).toEqual(["error", "error"]);
    expect(byId("fails")).toEqual(["fail", "fail"]);
    expect(byId("errors")).toEqual(["error", "error"]);
    expect(results.summary.overall.graded).toBe(6);
    expect(results.summary.overall.passed).toBe(4);
    expect(results.summary.errors).toBe(4);
    expect(results.summary.definitionHashes).toEqual(["abc"]);
    expect(results.summary.cost.totalUsd).toBeNull();
    const final = results.cases.find((c) => c.caseId === "final" && c.rep === 2);
    expect(final?.output.path).toBe(join(tmp, "outputs", caseOutputBasename(0, "final", 2)));
    expect(readFileSync(final?.output.path ?? "", "utf8")).toBe("final text");
    expect(final?.tokens).toEqual({ input: 3, output: 2 });
    expect(results.createdAt).toBe("2026-09-30T12:00:00.000Z");
  });

  test("truncates inline output past 16 KiB but keeps the full file", async () => {
    const caseSet = parseEvalCaseFile(
      "name: big\nworkflow: big\ngrader: { type: regex }\ncases:\n  - id: c\n    expect: { pattern: 'x{20000}' }\n",
      "big.yaml",
    );
    const big = "x".repeat(20_000);
    const results = await runEval({
      caseSet,
      caseFile: "big.yaml",
      reps: 1,
      split: "all",
      mode: "in-process",
      executor: async () => execution({ finalOutput: big }),
      graderDeps: { cwd: tmp },
      outputsDir: join(tmp, "outputs"),
    });
    const c = results.cases[0];
    expect(c?.status).toBe("pass");
    expect(c?.output.truncated).toBe(true);
    expect(c?.output.text.length).toBe(16 * 1024);
    expect(readFileSync(c?.output.path ?? "", "utf8").length).toBe(20_000);
  });

  test("--split selects cases and the judge grader reaches the injected judge", async () => {
    const caseSet = parseEvalCaseFile(
      `
name: j
workflow: j
split: { train: [a], test: [b] }
grader: { type: judge, grader_reps: 3 }
cases:
  - id: a
    expect: { claims: ["says final"], secret: "never shown" }
  - id: b
    expect: { claims: ["says final"] }
`,
      "j.yaml",
    );
    const prompts: string[] = [];
    const results = await runEval({
      caseSet,
      caseFile: "j.yaml",
      reps: 1,
      split: "train",
      mode: "in-process",
      executor: async () => execution({}),
      graderDeps: {
        cwd: tmp,
        judge: async ({ prompt }) => {
          prompts.push(prompt);
          return '{"claims":[{"claim":"says final","met":true,"evidence":"final text"}]}';
        },
      },
      outputsDir: join(tmp, "outputs"),
    });
    expect(results.cases.map((c) => c.caseId)).toEqual(["a"]);
    expect(results.cases[0]?.status).toBe("pass");
    expect(prompts).toHaveLength(3);
    expect(prompts.join("\n")).not.toContain("never shown");
    expect(results.summary.graderNoise.judged).toBe(1);
    expect(results.summary.graderNoise.rate).toBe(0);
  });
});

describe("caseOutputBasename", () => {
  test("ids differing only by case get distinct, filesystem-safe names", () => {
    const a = caseOutputBasename(0, "Foo", 1);
    const b = caseOutputBasename(0, "foo", 1);
    expect(a).not.toBe(b);
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
    expect(a).toMatch(/^001-foo-[0-9a-f]{8}\.rep1\.txt$/);
    const con = caseOutputBasename(4, "CON", 2);
    expect(con).toMatch(/^005-con-[0-9a-f]{8}\.rep2\.txt$/);
    expect(caseOutputBasename(0, "日本語", 1)).toMatch(/^001-case-[0-9a-f]{8}\.rep1\.txt$/);
    expect(caseOutputBasename(0, "Foo", 1)).toBe(a);
  });
});

describe("judge provider rail", () => {
  test("only providers that honor an empty allowedTools list may judge", () => {
    expect(judgeProviderError("claude")).toBeNull();
    expect(judgeProviderError("copilot")).toBeNull();
    expect(judgeProviderError("stub")).toBeNull();
    expect(judgeProviderError("codex")).toContain("cannot run without tools");
    expect(judgeProviderError("pi")).toContain("cannot run without tools");
  });
});

describe("makeInProcessExecutor", () => {
  test("runs the stub-backed fixture workflow and reports the final output", async () => {
    const executor = makeInProcessExecutor({
      workflow: "smoke-bash",
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    const result = await executor({ inputs: { TEST_NAME: "cli" } });
    expect(result.error).toBeNull();
    expect(result.runStatus).toBe("succeeded");
    expect(result.finalOutput).toContain("hello from");
    expect(result.nodeOutputs.greet).toContain("hello from");
    expect(result.durationMs).not.toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.nodeOutputs.constructor).toBeUndefined();
  });

  test("reports one definition hash across runs and a new one after an edit", async () => {
    const dir = join(tmp, "workflows");
    mkdirSync(dir);
    const target = join(dir, "smoke-bash.yaml");
    copyFileSync(join(FIXTURES, "smoke-bash.yaml"), target);
    const executor = makeInProcessExecutor({
      workflow: "smoke-bash",
      cwd: process.cwd(),
      workflowsDir: dir,
    });
    const first = await executor({ inputs: {} });
    const second = await executor({ inputs: {} });
    expect(second.error).toBeNull();
    expect(second.definitionHash).toBe(first.definitionHash);
    writeFileSync(target, `${readFileSync(target, "utf8")}  - id: extra\n    bash: echo extra\n`);
    const third = await executor({ inputs: {} });
    expect(third.error).toBeNull();
    expect(third.definitionHash).not.toBe(first.definitionHash);
  });

  test("a missing workflow is an error execution, not a thrown failure", async () => {
    const executor = makeInProcessExecutor({
      workflow: "does-not-exist",
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    const result = await executor({ inputs: {} });
    expect(result.runStatus).toBeNull();
    expect(result.error).toContain("no workflow named");
  });
});

describe("fetchRunCostUsd", () => {
  const RUN_ID = "11111111-2222-3333-4444-555555555555";

  async function costFor(rowCount: number): Promise<number | null> {
    const row = {
      id: 1,
      ts: "2026-09-30T00:00:00.000Z",
      source: "workflow",
      provider: "stub",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.001,
      durationMs: null,
      status: "ok",
      conversationId: null,
      runId: RUN_ID,
      nodeId: "n",
      workflowName: "w",
      ribId: null,
      projectId: null,
    };
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(Array.from({ length: rowCount }, (_, i) => ({ ...row, id: i }))),
    });
    try {
      return await fetchRunCostUsd(`http://127.0.0.1:${server.port}`, RUN_ID);
    } finally {
      await server.stop(true);
    }
  }

  test("sums a complete page and refuses a full one as possibly truncated", async () => {
    expect(await costFor(3)).toBeCloseTo(0.003, 6);
    expect(await costFor(500)).toBeNull();
  });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[], home: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv({
      KEELSON_HOME: home,
      KEELSON_SERVER_URL: "http://127.0.0.1:1",
      KEELSON_PROVIDERS: "stub",
      KEELSON_USE_STUBS: "1",
    }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("keelson eval (CLI)", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmp, "home");
    mkdirSync(join(home, "workflows"), { recursive: true });
    copyFileSync(join(FIXTURES, "smoke-bash.yaml"), join(home, "workflows", "smoke-bash.yaml"));
    writeFileSync(join(home, "smoke-bash.eval.yaml"), CASE_FILE);
  });

  test("eval run writes results + summary, exits 0 with no errors, and compare is within-noise", async () => {
    const out = join(home, "first.json");
    const run = await runCli(["--json", "eval", "run", "smoke-bash.eval.yaml", "--out", out], home);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      data: {
        resultsPath: string;
        summaryPath: string;
        mode: string;
        summary: { overall: { passed: number; failed: number; errors: number } };
        cases: Array<{ caseId: string; status: string }>;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.mode).toBe("in-process");
    expect(envelope.data.resultsPath).toBe(out);
    expect(envelope.data.summary.overall).toMatchObject({ passed: 2, failed: 1, errors: 0 });
    expect(envelope.data.cases.map((c) => `${c.caseId}:${c.status}`)).toEqual([
      "greets:pass",
      "greets-again:pass",
      "wrong:fail",
    ]);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(join(home, "first.md"), "utf8")).toContain("# Eval: smoke-bash");
    expect(existsSync(join(home, "first.outputs", caseOutputBasename(0, "greets", 1)))).toBe(true);

    const cmp = await runCli(["--json", "eval", "compare", out, out], home);
    expect(cmp.exitCode).toBe(0);
    const verdicts = JSON.parse(cmp.stdout.trim()) as {
      data: { decision: string; splits: Array<{ split: string; verdict: string }> };
    };
    expect(verdicts.data.splits.map((s) => s.verdict)).toEqual([
      "within-noise",
      "within-noise",
      "within-noise",
    ]);
    expect(verdicts.data.decision).toBe("revert");

    const split = await runCli(
      ["--json", "eval", "run", "smoke-bash.eval.yaml", "--split", "train"],
      home,
    );
    expect(split.exitCode).toBe(0);
    const trainOnly = JSON.parse(split.stdout.trim()) as {
      data: { resultsPath: string; cases: Array<{ caseId: string }> };
    };
    expect(trainOnly.data.resultsPath.startsWith(join(home, "evals", "smoke-bash"))).toBe(true);
    expect(trainOnly.data.cases.map((c) => c.caseId)).toEqual(["greets"]);
  });

  test("bad args exit 2 and an unknown workflow exits 4", async () => {
    const badSplit = await runCli(
      ["--json", "eval", "run", "smoke-bash.eval.yaml", "--split", "dev"],
      home,
    );
    expect(badSplit.exitCode).toBe(2);
    expect(JSON.parse(badSplit.stdout.trim()).code).toBe("BAD_INPUTS");
    const missing = await runCli(["--json", "eval", "run", "nope.eval.yaml"], home);
    expect(missing.exitCode).toBe(2);
    writeFileSync(
      join(home, "bad.eval.yaml"),
      CASE_FILE.replace("workflow: smoke-bash", "workflow: ghost"),
    );
    const ghost = await runCli(["--json", "eval", "run", "bad.eval.yaml"], home);
    expect(ghost.exitCode).toBe(4);
    expect(JSON.parse(ghost.stdout.trim()).code).toBe("WORKFLOW_NOT_FOUND");
  });

  test("eval init scaffolds once and refuses to overwrite", async () => {
    const first = await runCli(["--json", "eval", "init", "smoke-bash"], home);
    expect(first.exitCode).toBe(0);
    const path = (JSON.parse(first.stdout.trim()) as { data: { path: string } }).data.path;
    expect(path).toBe(join(home, "evals", "smoke-bash.eval.yaml"));
    const scaffold = readFileSync(path, "utf8");
    expect(scaffold).toContain('workflow: "smoke-bash"');
    expect(() => parseEvalCaseFile(scaffold, path)).not.toThrow();
    const second = await runCli(["--json", "eval", "init", "smoke-bash"], home);
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stdout.trim()).code).toBe("FILE_EXISTS");
  });

  test("eval run help lists its options in JSON mode", async () => {
    const sub = await runCli(["--json", "eval", "help", "run"], home);
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout).toContain("--reps");
    expect(sub.stdout).toContain("--split");
  });
});

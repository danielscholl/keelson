// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

// Every case drives real git repositories, which run slowly on a loaded machine.
const gitTest = (name: string, fn: () => void | Promise<void>) => test(name, fn, 20_000);

// The bodies shell out to bash, git, jq, and bun; the forge-shim tests skip
// on Windows for the same reason.
const shimDescribe = process.platform === "win32" ? describe.skip : describe;

type Status = "pass" | "fail" | "error";

const document = parse(readFileSync(join(bundledWorkflowsDir(), "hillclimb.yaml"), "utf8")) as {
  nodes: Array<{ id: string; bash?: string }>;
};

function body(id: string): string {
  const script = document.nodes.find((node) => node.id === id)?.bash;
  if (!script) throw new Error(`Missing ${id} bash node in hillclimb`);
  return script;
}

const TARGET_SOURCE = `name: demo
description: demo
nodes:
  - id: say
    prompt: Say hello.
`;

const CASE_FILE = `name: demo
workflow: demo
split:
  train: [a, b]
  test: [c]
grader:
  type: contains
cases:
  - id: a
    arguments: one
    expect: { strings: [hello] }
  - id: b
    arguments: two
    expect: { strings: [hello] }
  - id: c
    arguments: three
    expect: { strings: [hello] }
`;

// Answers the three CLI calls the workflow makes with scripted files, and logs
// every call so a test can assert which ones happened.
const FAKE_KEELSON = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HC_FAKE_DIR/calls.log"
args=()
for a in "$@"; do [ "$a" = "--json" ] || args+=("$a"); done
case "\${args[0]}/\${args[1]}" in
  workflow/validate)
    if grep -q HC_BROKEN "\${args[3]}/\${args[4]}.yaml"; then
      printf '{"error":"demo: bad node","code":"BAD_INPUTS"}\\n'
      exit 2
    fi
    printf '{"data":{"results":[{"ok":true}],"failed":0,"total":1}}\\n' ;;
  eval/run)
    n=$(( $(cat "$HC_FAKE_DIR/runs" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$HC_FAKE_DIR/runs"
    dest="$HC_FAKE_DIR/results/run-$n.json"
    mkdir -p "$HC_FAKE_DIR/results/run-$n.outputs"
    cp "$HC_FAKE_DIR/next-eval.json" "$dest"
    printf '# run %s\\n' "$n" > "$HC_FAKE_DIR/results/run-$n.md"
    printf '{"data":{"resultsPath":"%s"}}\\n' "$dest"
    [ "$(jq .summary.errors "$dest")" = "0" ] || exit 1 ;;
  eval/compare)
    cat "$HC_FAKE_DIR/next-compare.json" ;;
  *)
    echo "unexpected call: $*" >&2
    exit 9 ;;
esac
`;

interface Fixture {
  root: string;
  repo: string;
  target: string;
  caseFile: string;
  fake: string;
  artifacts: string;
}

function git(fx: Fixture, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: fx.repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function makeFixture(): Fixture {
  // realpath: macOS hands out /var/... while the bodies canonicalize to /private/var/...
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hillclimb-")));
  const repo = join(root, "repo");
  const fake = join(root, "fake");
  const artifacts = join(root, "art");
  mkdirSync(join(repo, ".keelson", "workflows"), { recursive: true });
  mkdirSync(join(fake, "outputs"), { recursive: true });
  mkdirSync(artifacts);
  const target = join(repo, ".keelson", "workflows", "demo.yaml");
  const caseFile = join(repo, "demo.eval.yaml");
  writeFileSync(target, TARGET_SOURCE);
  writeFileSync(caseFile, CASE_FILE);
  writeFileSync(join(repo, "other.txt"), "untouched\n");
  writeFileSync(join(fake, "keelson"), FAKE_KEELSON, { mode: 0o755 });
  const fx = { root, repo, target, caseFile, fake, artifacts };
  git(fx, "init", "-q", "-b", "main");
  git(fx, "config", "user.email", "hillclimb@example.com");
  git(fx, "config", "user.name", "hillclimb");
  git(fx, "config", "commit.gpgsign", "false");
  git(fx, "add", "-A");
  git(fx, "commit", "-q", "-m", "init");
  return fx;
}

function results(fx: Fixture, statuses: Record<"a" | "b" | "c", Status>): string {
  const cases = (["a", "b", "c"] as const).map((id) => {
    const outputPath = join(fx.fake, "outputs", `${id}.txt`);
    writeFileSync(outputPath, `output of ${id}\n`);
    const status = statuses[id];
    return {
      caseId: id,
      split: id === "c" ? "test" : "train",
      rep: 1,
      runId: `run-${id}`,
      status,
      grader: { type: "contains", detail: status === "pass" ? "all strings present" : "missing" },
      output: { text: `output of ${id}`, truncated: false, path: outputPath },
      durationMs: 10,
      tokens: null,
      costUsd: null,
      definitionHash: null,
      error: status === "error" ? "boom" : null,
    };
  });
  const stats = (rows: typeof cases) => {
    const passed = rows.filter((r) => r.status === "pass").length;
    const failed = rows.filter((r) => r.status === "fail").length;
    const errors = rows.filter((r) => r.status === "error").length;
    const graded = passed + failed;
    return {
      cases: rows.length,
      graded,
      passed,
      failed,
      errors,
      passRate: graded > 0 ? passed / graded : null,
      interval: graded > 0 ? { low: 0.1, high: 0.9 } : null,
    };
  };
  const overall = stats(cases);
  return JSON.stringify({
    schemaVersion: 1,
    name: "demo",
    workflow: "demo",
    project: null,
    caseFile: fx.caseFile,
    caseSetHash: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "in-process",
    reps: 1,
    splitFilter: "all",
    cases,
    summary: {
      overall,
      splits: {
        train: stats(cases.filter((c) => c.split === "train")),
        test: stats(cases.filter((c) => c.split === "test")),
      },
      errors: overall.errors,
      graderNoise: { judged: 0, disagreements: 0, rate: null },
      duration: { meanMs: 10, p95Ms: 10 },
      cost: { totalUsd: null, perCaseUsd: {} },
      definitionHashes: [],
      warnings: [],
    },
  });
}

function compare(
  decision: "keep" | "revert",
  train: string,
  test: string,
  definitionChanged: boolean | null = true,
): string {
  return JSON.stringify({
    data: {
      decision,
      definitionChanged,
      reason:
        decision === "keep" ? "overall improved, and train and test both moved up" : `test ${test}`,
      splits: [
        { split: "overall", verdict: train },
        { split: "train", verdict: train },
        { split: "test", verdict: test },
      ],
      cost: { beforeUsd: null, afterUsd: null, deltaUsd: null },
    },
  });
}

function runNode(fx: Fixture, id: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", body(id)],
    cwd: fx.repo,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${fx.fake}:${process.env.PATH ?? ""}`,
      HC_FAKE_DIR: fx.fake,
      ARTIFACTS_DIR: fx.artifacts,
      KEELSON_ARTIFACTS_DIR: fx.artifacts,
      KEELSON_RUN_ID: "test-run",
      KEELSON_ARGUMENTS: fx.caseFile,
      KEELSON_INPUTS_rounds: "3",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json };
}

function setUp(fx: Fixture): void {
  const pre = runNode(fx, "preflight");
  expect(pre.stderr).toBe("");
  expect(pre.code).toBe(0);
  writeFileSync(join(fx.fake, "next-eval.json"), results(fx, { a: "pass", b: "fail", c: "fail" }));
  const base = runNode(fx, "baseline");
  expect(base.code).toBe(0);
}

function propose(fx: Fixture, edit: string): void {
  writeFileSync(fx.target, TARGET_SOURCE.replace("Say hello.", JSON.stringify(edit.trim())));
}

function round(
  fx: Fixture,
  opts: { state?: string; changed?: boolean; summary?: string } = {},
): Record<string, unknown> {
  const n = Number(readFileSync(join(fx.artifacts, "round"), "utf8").trim()) + 1;
  const state = opts.state ?? "completed";
  const output = JSON.stringify({
    changed: opts.changed ?? true,
    root_cause: "the prompt never states the greeting word",
    change_summary: opts.summary ?? "state the greeting word as a rule",
  });
  const result = runNode(fx, "round-1", {
    [`KEELSON_NODE_propose_${n}_STATE`]: state,
    [`KEELSON_NODE_propose_${n}_OUTPUT`]: output,
  });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  if (result.json === null) throw new Error(`round ${n} printed no JSON: ${result.stdout}`);
  return result.json;
}

function calls(fx: Fixture): string[] {
  const log = join(fx.fake, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

shimDescribe("hillclimb preflight and baseline", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  gitTest("resolves the project copy, branches, and snapshots the target", () => {
    const pre = runNode(fx, "preflight");
    expect(pre.code).toBe(0);
    expect(pre.json).toMatchObject({ workflow: "demo", target: fx.target, rounds: 3 });
    expect(String(pre.json?.branch)).toStartWith("keelson/hillclimb/demo-");
    expect(git(fx, "branch", "--show-current")).toBe(String(pre.json?.branch));
    expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toBe(TARGET_SOURCE);
    expect(calls(fx)).toEqual([
      `--json workflow validate --dir ${join(fx.repo, ".keelson", "workflows")} demo`,
    ]);
  });

  gitTest("refuses a dirty target, a bundled-only workflow, and too many rounds", () => {
    writeFileSync(fx.target, `${TARGET_SOURCE}# dirty\n`);
    expect(runNode(fx, "preflight").stderr).toContain("uncommitted changes");
    git(fx, "checkout", "--", fx.target);
    rmSync(fx.target);
    const missing = runNode(fx, "preflight", { KEELSON_HOME: join(fx.root, "empty-home") });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("bundled assets are read-only");
    writeFileSync(fx.target, TARGET_SOURCE);
    expect(runNode(fx, "preflight", { KEELSON_INPUTS_rounds: "4" }).stderr).toContain(
      "rounds must be 1, 2, or 3",
    );
  });

  gitTest("refuses a case set without cases in both splits", () => {
    for (const split of ["", "split:\n  test: [a, b, c]\n", "split:\n  train: [a, b, c]\n"]) {
      writeFileSync(fx.caseFile, CASE_FILE.replace(/split:\n {2}train.*\n {2}test.*\n/, split));
      const pre = runNode(fx, "preflight");
      expect(pre.code).not.toBe(0);
      expect(pre.stderr).toContain("both split.train and split.test");
    }
    expect(calls(fx)).toEqual([]);
  });

  gitTest("the baseline hands the proposer the train split only", () => {
    setUp(fx);
    const view = JSON.parse(readFileSync(join(fx.artifacts, "train-view", "results.json"), "utf8"));
    expect(view.rows.map((r: { caseId: string }) => r.caseId)).toEqual(["a", "b"]);
    const cases = JSON.parse(readFileSync(join(fx.artifacts, "train-view", "cases.json"), "utf8"));
    expect(cases.cases.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
    expect(existsSync(join(fx.artifacts, "train-view", "outputs", "c.txt"))).toBe(false);
    expect(existsSync(join(fx.artifacts, "train-view", "outputs", "b.txt"))).toBe(true);
    expect(existsSync(join(fx.artifacts, "kept.json"))).toBe(true);
  });

  gitTest("the baseline fails the run when a case errors, naming the count", () => {
    expect(runNode(fx, "preflight").code).toBe(0);
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "error", c: "pass" }),
    );
    const base = runNode(fx, "baseline");
    expect(base.code).toBe(1);
    expect(base.stderr).toContain("1 case run(s) errored");
  });

  gitTest("a baseline that mixes workflow definitions stops before proposing", () => {
    expect(runNode(fx, "preflight").code).toBe(0);
    const mixed = JSON.parse(results(fx, { a: "pass", b: "fail", c: "fail" }));
    mixed.summary.definitionHashes = ["aaa", "bbb"];
    writeFileSync(join(fx.fake, "next-eval.json"), JSON.stringify(mixed));
    const base = runNode(fx, "baseline");
    expect(base.code).toBe(1);
    expect(base.stderr).toContain("multiple workflow definitions");
    expect(existsSync(join(fx.artifacts, "kept.json"))).toBe(false);
  });

  gitTest(
    "allows existing prompt, loop prompt, and node description text while preserving structure",
    () => {
      const source = `name: demo
description: demo
future_workflow: { mode: frozen }
nodes:
  - id: say
    description: Greet the user.
    prompt: Say hello.
    model: balanced
    future_node: { mode: frozen }
  - id: repeat
    description: Repeat the greeting.
    loop:
      prompt: Say hello again.
      until: DONE
      max_iterations: 2
    depends_on: [say]
`;
      writeFileSync(fx.target, source);
      git(fx, "add", fx.target);
      git(fx, "commit", "-q", "-m", "rich target");
      setUp(fx);
      const candidate = source
        .replace("Greet the user.", "Use a concise greeting.")
        .replace("Say hello.", "Say hello in English.")
        .replace("Say hello again.", "Repeat hello in English.")
        .replace("name: demo\ndescription: demo", "description: demo\nname: demo");
      writeFileSync(fx.target, candidate);
      writeFileSync(
        join(fx.fake, "next-eval.json"),
        results(fx, { a: "pass", b: "pass", c: "pass" }),
      );
      writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
      expect(round(fx)).toMatchObject({ decision: "keep", committed: true });
      expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toBe(candidate);
      const reordered = parse(candidate);
      reordered.nodes.reverse();
      for (const changed of [
        candidate.replace("max_iterations: 2", "max_iterations: 3"),
        candidate.replace("until: DONE", "until: FINISHED"),
        candidate.replace("depends_on: [say]", "depends_on: []"),
        candidate.replace("future_node: { mode: frozen }", "future_node: { mode: changed }"),
        candidate.replace(
          "future_workflow: { mode: frozen }",
          "future_workflow: { mode: changed }",
        ),
        candidate.replace("    description: Repeat the greeting.\n", ""),
        stringify(reordered),
      ]) {
        writeFileSync(fx.target, changed);
        expect(round(fx)).toMatchObject({ decision: "scope-violation", continue: false });
        expect(readFileSync(fx.target, "utf8")).toBe(candidate);
      }
      expect(calls(fx).filter((c) => c.includes("eval run"))).toHaveLength(2);
    },
  );

  gitTest("keeps a valid prompt improvement outside git without requiring a commit", () => {
    fx.target = join(fx.root, "standalone", "demo.yaml");
    mkdirSync(join(fx.root, "standalone"));
    writeFileSync(fx.target, TARGET_SOURCE);
    const pre = runNode(fx, "preflight", { KEELSON_INPUTS_target: fx.target });
    expect(pre.code).toBe(0);
    expect(pre.json).toMatchObject({ target: fx.target, repo: "", branch: "" });
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "fail", c: "fail" }),
    );
    expect(runNode(fx, "baseline").code).toBe(0);
    propose(fx, "Always greet in English.");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    expect(round(fx)).toMatchObject({ decision: "keep", committed: false });
    expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toContain(
      "Always greet in English.",
    );
    const collected = runNode(fx, "collect");
    expect(collected.code).toBe(0);
    expect(String(collected.json?.recommendation)).toStartWith("Keep the edited");
  });
});

shimDescribe("hillclimb round decisions", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    setUp(fx);
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  gitTest("keep commits the change, advances the kept results, and continues", () => {
    propose(fx, "# round one\n");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    const out = round(fx);
    expect(out).toMatchObject({
      round: 1,
      decision: "keep",
      changed: true,
      train_verdict: "improved",
      test_verdict: "improved",
      flat_streak: 0,
      continue: true,
      committed: true,
    });
    expect(readFileSync(fx.target, "utf8")).toContain("# round one");
    expect(git(fx, "status", "--porcelain")).toBe("");
    expect(git(fx, "log", "-1", "--pretty=%s")).toBe(
      "feat(demo): state the greeting word as a rule",
    );
    expect(git(fx, "log", "-1", "--pretty=%b")).toContain(
      "Root cause: the prompt never states the greeting word",
    );
    const kept = JSON.parse(readFileSync(join(fx.artifacts, "kept.json"), "utf8"));
    expect(kept.summary.overall.passed).toBe(3);
    const view = JSON.parse(readFileSync(join(fx.artifacts, "train-view", "results.json"), "utf8"));
    expect(view.summary.passed).toBe(2);
    expect(readFileSync(join(fx.artifacts, "round-1-change.md"), "utf8")).toContain(
      '+    prompt: "# round one"',
    );
    expect(calls(fx).filter((c) => c.includes("eval compare"))).toHaveLength(1);
  });

  gitTest("revert restores the kept target and counts a flat round", () => {
    propose(fx, "# round one\n");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "fail" }),
    );
    writeFileSync(
      join(fx.fake, "next-compare.json"),
      compare("revert", "improved", "within-noise"),
    );
    const out = round(fx);
    expect(out).toMatchObject({
      decision: "revert",
      flat_streak: 1,
      continue: true,
      committed: false,
    });
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(git(fx, "log", "--oneline").split("\n")).toHaveLength(1);
    const kept = JSON.parse(readFileSync(join(fx.artifacts, "kept.json"), "utf8"));
    expect(kept.summary.overall.passed).toBe(1);
  });

  gitTest("two flat rounds in a row stop the loop", () => {
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "fail", c: "fail" }),
    );
    writeFileSync(
      join(fx.fake, "next-compare.json"),
      compare("revert", "within-noise", "within-noise"),
    );
    propose(fx, "# try one\n");
    expect(round(fx)).toMatchObject({ round: 1, flat_streak: 1, continue: true });
    propose(fx, "# try two\n");
    expect(round(fx)).toMatchObject({
      round: 2,
      decision: "revert",
      flat_streak: 2,
      continue: false,
    });
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
  });

  gitTest("a keep resets the streak and the last round never continues", () => {
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "fail", c: "fail" }),
    );
    writeFileSync(
      join(fx.fake, "next-compare.json"),
      compare("revert", "within-noise", "within-noise"),
    );
    propose(fx, "# try one\n");
    expect(round(fx)).toMatchObject({ flat_streak: 1 });
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    propose(fx, "# try two\n");
    expect(round(fx)).toMatchObject({ round: 2, decision: "keep", flat_streak: 0, continue: true });
    writeFileSync(
      join(fx.fake, "next-compare.json"),
      compare("revert", "within-noise", "within-noise"),
    );
    propose(fx, "# try two\n# try three\n");
    expect(round(fx)).toMatchObject({
      round: 3,
      decision: "revert",
      flat_streak: 1,
      continue: false,
    });
    expect(readFileSync(fx.target, "utf8")).toBe(
      TARGET_SOURCE.replace("Say hello.", JSON.stringify("# try two")),
    );
  });

  gitTest("a declined change stops the loop without an eval", () => {
    const before = calls(fx).length;
    const out = round(fx, { changed: false, summary: "no shared root cause left" });
    expect(out).toMatchObject({
      decision: "no-change",
      reason: "no shared root cause left",
      continue: false,
    });
    expect(calls(fx)).toHaveLength(before);
  });

  gitTest("an edit that fails validation is rejected, kept aside, and reverted", () => {
    propose(fx, "# HC_BROKEN\n");
    const out = round(fx);
    expect(out).toMatchObject({
      decision: "invalid",
      changed: true,
      flat_streak: 1,
      continue: true,
    });
    expect(String(out.reason)).toContain("demo: bad node");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(readFileSync(join(fx.artifacts, "round-1-rejected.yaml"), "utf8")).toContain(
      "HC_BROKEN",
    );
    expect(calls(fx).some((c) => c.includes("eval run") && calls(fx).indexOf(c) > 1)).toBe(false);
  });

  gitTest("an eval that ran the kept definition again is an error, not a flat round", () => {
    propose(fx, "# rule\n");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    writeFileSync(
      join(fx.fake, "next-compare.json"),
      compare("keep", "improved", "improved", false),
    );
    const out = round(fx);
    expect(out).toMatchObject({ decision: "error", continue: false, committed: false });
    expect(String(out.reason)).toContain("same workflow definition");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
  });

  gitTest("an errored eval reverts and stops", () => {
    propose(fx, "# round one\n");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "error", c: "pass" }),
    );
    const out = round(fx);
    expect(out).toMatchObject({ decision: "error", continue: false });
    expect(String(out.reason)).toContain("1 case run(s) errored");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
  });

  gitTest("a proposer that touched other files is a scope violation", () => {
    propose(fx, "# round one\n");
    writeFileSync(join(fx.repo, "other.txt"), "changed by the proposer\n");
    const out = round(fx);
    expect(out).toMatchObject({ decision: "scope-violation", changed: false, continue: false });
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(readFileSync(join(fx.repo, "other.txt"), "utf8")).toBe("changed by the proposer\n");
  });

  gitTest("an edit to a file that was already dirty or untracked is a scope violation", () => {
    for (const name of ["other.txt", "notes.txt"]) {
      const previousBranch = git(fx, "branch", "--show-current");
      git(fx, "checkout", "-q", "main");
      git(fx, "branch", "-D", previousBranch);
      rmSync(fx.artifacts, { recursive: true, force: true });
      mkdirSync(fx.artifacts);
      writeFileSync(join(fx.repo, name), "operator work in progress\n");
      const statusBefore = git(fx, "status", "--porcelain", "--", name);
      const stagedBefore = git(fx, "diff", "--cached", "--name-only");
      setUp(fx);
      propose(fx, "Always greet in English.");
      writeFileSync(join(fx.repo, name), "rewritten by the proposer\n");
      expect(git(fx, "status", "--porcelain", "--", name)).toBe(statusBefore);
      const evalsBefore = calls(fx).filter((c) => c.includes("eval run")).length;
      const out = round(fx);
      expect(out).toMatchObject({ decision: "scope-violation", changed: false, continue: false });
      expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
      expect(calls(fx).filter((c) => c.includes("eval run"))).toHaveLength(evalsBefore);
      expect(git(fx, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    }
  });

  gitTest("untouched dirty and untracked files do not trip the scope check", () => {
    const previousBranch = git(fx, "branch", "--show-current");
    git(fx, "checkout", "-q", "main");
    git(fx, "branch", "-D", previousBranch);
    writeFileSync(join(fx.repo, "other.txt"), "operator work in progress\n");
    writeFileSync(join(fx.repo, "notes.txt"), "operator notes\n");
    setUp(fx);
    propose(fx, "Always greet in English.");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "fail" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    expect(round(fx)).toMatchObject({ decision: "keep", committed: true, continue: true });
    propose(fx, "Always greet in English and stop.");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    expect(round(fx)).toMatchObject({ decision: "keep", committed: true });
    expect(git(fx, "status", "--porcelain")).toBe("M other.txt\n?? notes.txt");
  });

  gitTest("a similarly named file is not mistaken for the editable target", () => {
    propose(fx, "Always greet in English.");
    writeFileSync(`${fx.target}.backup`, "out of scope\n");
    const out = round(fx);
    expect(out).toMatchObject({ decision: "scope-violation", changed: false, continue: false });
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(readFileSync(`${fx.target}.backup`, "utf8")).toBe("out of scope\n");
    expect(calls(fx).filter((c) => c.includes("eval run"))).toHaveLength(1);
  });

  gitTest("valid YAML edits to protected fields are rejected before evaluation", () => {
    const mutations = [
      TARGET_SOURCE.replace("name: demo", "name: other"),
      TARGET_SOURCE.replace("description: demo", "description: changed"),
      TARGET_SOURCE.replace("id: say", "id: renamed"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    model: deep"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    provider: claude"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    allowed_tools: [Read]"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    when: \"'yes' == 'yes'\""),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    depends_on: []"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    output_schema: { type: string }"),
      TARGET_SOURCE.replace("Say hello.", "Say hello.\n    future_field: changed"),
      `${TARGET_SOURCE}  - id: extra\n    bash: echo hello\n`,
      TARGET_SOURCE.replace("    prompt: Say hello.\n", "    bash: echo hello\n"),
      TARGET_SOURCE.replace("    prompt: Say hello.\n", ""),
    ];
    const before = calls(fx).filter((c) => c.includes("eval run")).length;
    for (const source of mutations) {
      writeFileSync(fx.target, source);
      const out = round(fx);
      expect(out).toMatchObject({ decision: "scope-violation", continue: false, committed: false });
      expect(String(out.reason)).toContain("protected workflow fields");
      expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
      const n = Number(out.round);
      expect(readFileSync(join(fx.artifacts, `round-${n}-rejected.yaml`), "utf8")).toBe(source);
    }
    expect(calls(fx).filter((c) => c.includes("eval run"))).toHaveLength(before);
    expect(git(fx, "status", "--porcelain")).toBe("");
  });

  gitTest("comment-only edits stop without evaluation and restore the exact kept file", () => {
    writeFileSync(fx.target, `${TARGET_SOURCE}# formatting only\n`);
    const before = calls(fx).filter((c) => c.includes("eval run")).length;
    const out = round(fx);
    expect(out).toMatchObject({ decision: "no-change", changed: false, continue: false });
    expect(String(out.reason)).toContain("no prompt text changed");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(calls(fx).filter((c) => c.includes("eval run"))).toHaveLength(before);
  });

  gitTest("an eval that mixes definitions reverts and stops", () => {
    propose(fx, "Always greet in English.");
    const mixed = JSON.parse(results(fx, { a: "pass", b: "pass", c: "pass" }));
    mixed.summary.definitionHashes = ["aaa", "bbb"];
    writeFileSync(join(fx.fake, "next-eval.json"), JSON.stringify(mixed));
    const out = round(fx);
    expect(out).toMatchObject({ decision: "error", continue: false, committed: false });
    expect(String(out.reason)).toContain("multiple workflow definitions");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(calls(fx).some((c) => c.includes("eval compare"))).toBe(false);
  });

  gitTest("a failed commit stops without advancing the kept file, results, or staged state", () => {
    propose(fx, "Always greet in English.");
    writeFileSync(join(fx.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    const out = round(fx);
    expect(out).toMatchObject({ decision: "error", continue: false, committed: false });
    expect(String(out.reason)).toContain("git commit failed");
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
    expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toBe(TARGET_SOURCE);
    const kept = JSON.parse(readFileSync(join(fx.artifacts, "kept.json"), "utf8"));
    expect(kept.summary.overall.passed).toBe(1);
    const view = JSON.parse(readFileSync(join(fx.artifacts, "train-view", "results.json"), "utf8"));
    expect(view.summary.passed).toBe(1);
    expect(git(fx, "status", "--porcelain")).toBe("");
    expect(git(fx, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  gitTest("a hook that rewrites the target is rolled back without advancing kept state", () => {
    const hooks = {
      "pre-commit":
        '#!/bin/sh\nprintf "# formatted by a hook\\n" >> .keelson/workflows/demo.yaml\ngit add .keelson/workflows/demo.yaml\n',
      "post-commit": '#!/bin/sh\nprintf "# stamped by a hook\\n" >> .keelson/workflows/demo.yaml\n',
    };
    for (const [hook, script] of Object.entries(hooks)) {
      const hookPath = join(fx.repo, ".git", "hooks", hook);
      writeFileSync(hookPath, script, { mode: 0o755 });
      propose(fx, "Always greet in English.");
      writeFileSync(
        join(fx.fake, "next-eval.json"),
        results(fx, { a: "pass", b: "pass", c: "pass" }),
      );
      writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
      const out = round(fx);
      expect(out).toMatchObject({ decision: "error", continue: false, committed: false });
      expect(String(out.reason)).toContain("differs from the evaluated candidate");
      expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
      expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toBe(TARGET_SOURCE);
      const kept = JSON.parse(readFileSync(join(fx.artifacts, "kept.json"), "utf8"));
      expect(kept.summary.overall.passed).toBe(1);
      expect(git(fx, "status", "--porcelain")).toBe("");
      expect(git(fx, "log", "--oneline").split("\n")).toHaveLength(1);
      rmSync(hookPath);
    }
  });

  gitTest("a later failed commit restores the previously committed improvement", () => {
    propose(fx, "Always greet in English.");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "fail" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    expect(round(fx)).toMatchObject({ decision: "keep", committed: true });
    const previousTarget = readFileSync(fx.target, "utf8");
    const previousResults = readFileSync(join(fx.artifacts, "kept.json"), "utf8");
    const previousHead = git(fx, "rev-parse", "HEAD");
    writeFileSync(join(fx.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    propose(fx, "Always greet in English and stop.");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "pass" }),
    );
    expect(round(fx)).toMatchObject({ decision: "error", continue: false, committed: false });
    expect(readFileSync(fx.target, "utf8")).toBe(previousTarget);
    expect(readFileSync(join(fx.artifacts, "target.kept.yaml"), "utf8")).toBe(previousTarget);
    expect(readFileSync(join(fx.artifacts, "kept.json"), "utf8")).toBe(previousResults);
    expect(git(fx, "rev-parse", "HEAD")).toBe(previousHead);
    expect(git(fx, "status", "--porcelain")).toBe("");
  });

  gitTest(
    "a kept commit excludes and preserves unrelated staged changes present before preflight",
    () => {
      const previousBranch = git(fx, "branch", "--show-current");
      git(fx, "checkout", "-q", "main");
      git(fx, "branch", "-D", previousBranch);
      writeFileSync(join(fx.repo, "other.txt"), "operator change\n");
      git(fx, "add", "other.txt");
      setUp(fx);
      propose(fx, "Always greet in English.");
      writeFileSync(
        join(fx.fake, "next-eval.json"),
        results(fx, { a: "pass", b: "pass", c: "pass" }),
      );
      writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
      expect(round(fx)).toMatchObject({ decision: "keep", committed: true });
      expect(git(fx, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
        ".keelson/workflows/demo.yaml",
      );
      expect(git(fx, "diff", "--cached", "--name-only")).toBe("other.txt");
      expect(git(fx, "show", "HEAD:other.txt")).toBe("untouched");
      expect(readFileSync(join(fx.repo, "other.txt"), "utf8")).toBe("operator change\n");
    },
  );

  gitTest("a failed proposer counts as a flat round after restoring the target", () => {
    propose(fx, "# half-written\n");
    const out = round(fx, { state: "failed" });
    expect(out).toMatchObject({
      decision: "propose-failed",
      changed: false,
      flat_streak: 1,
      continue: true,
    });
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
  });

  gitTest("a skipped proposer settles without advancing the round counter", () => {
    const out = round(fx, { state: "skipped" });
    expect(out).toMatchObject({ decision: "skipped", continue: false });
    expect(readFileSync(join(fx.artifacts, "round"), "utf8").trim()).toBe("0");
  });
});

shimDescribe("hillclimb collect", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    setUp(fx);
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  const settled = {
    KEELSON_NODE_round_1_STATE: "completed",
    KEELSON_NODE_round_2_STATE: "completed",
    KEELSON_NODE_round_3_STATE: "completed",
  };

  gitTest("recommends the branch after a kept round and lists what still fails", () => {
    propose(fx, "# round one\n");
    writeFileSync(
      join(fx.fake, "next-eval.json"),
      results(fx, { a: "pass", b: "pass", c: "fail" }),
    );
    writeFileSync(join(fx.fake, "next-compare.json"), compare("keep", "improved", "improved"));
    round(fx);
    round(fx, { changed: false });
    const out = runNode(fx, "collect", settled);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.json).toMatchObject({ kept_rounds: 1, remaining_failures: 1 });
    expect(String(out.json?.recommendation)).toStartWith("Merge keelson/hillclimb/demo-");
    const ledger = String(out.json?.ledger);
    expect(ledger).toContain(
      "| train | 50% [10%, 90%] (1/2, 0 errors) | 100% [10%, 90%] (2/2, 0 errors) |",
    );
    expect(ledger).toContain("| 1 | keep | improved | improved |");
    expect(ledger).toContain("| 2 | no-change |");
    const keptAt = join(fx.fake, "results", "hillclimb-test-run");
    expect(out.json?.kept_at).toBe(keptAt);
    expect(ledger).toContain(keptAt);
    expect(readFileSync(join(keptAt, "ledger.md"), "utf8")).toBe(ledger);
    expect(readFileSync(join(keptAt, "round-1-change.md"), "utf8")).toContain("# round one");
    expect(existsSync(join(keptAt, "round-2-decision.json"))).toBe(true);
    expect(git(fx, "branch", "--show-current")).toStartWith("keelson/hillclimb/demo-");
    const view = JSON.parse(readFileSync(join(fx.artifacts, "final-view", "results.json"), "utf8"));
    expect(view.rows.map((r: { caseId: string }) => r.caseId)).toEqual(["a", "b", "c"]);
  });

  gitTest("returns to the original branch when nothing was kept", () => {
    round(fx, { changed: false });
    const out = runNode(fx, "collect", settled);
    expect(out.code).toBe(0);
    expect(out.json).toMatchObject({ kept_rounds: 0, branch: "" });
    expect(String(out.json?.recommendation)).toStartWith("Do not merge");
    expect(git(fx, "branch", "--show-current")).toBe("main");
    expect(git(fx, "branch", "--list", "keelson/hillclimb/*")).toBe("");
  });

  gitTest("notes a crashed round and restores the kept target", () => {
    propose(fx, "# half-written\n");
    const out = runNode(fx, "collect", {
      ...settled,
      KEELSON_NODE_round_1_STATE: "failed",
      KEELSON_NODE_round_1_ERROR: "exit code 1: jq: parse error",
    });
    expect(out.code).toBe(0);
    expect(out.json?.notes).toContain(
      "round-1 crashed: exit code 1: jq: parse error; its change was not kept",
    );
    expect(readFileSync(fx.target, "utf8")).toBe(TARGET_SOURCE);
  });

  gitTest("refuses a merge recommendation for a kept round without a recorded commit", () => {
    writeFileSync(
      join(fx.artifacts, "round-1-decision.json"),
      JSON.stringify({ round: 1, decision: "keep", committed: false }),
    );
    const out = runNode(fx, "collect", settled);
    expect(out.code).toBe(0);
    expect(String(out.json?.recommendation)).toStartWith("Do not merge");
    expect(String(out.json?.recommendation)).toContain("uncommitted");
  });
});

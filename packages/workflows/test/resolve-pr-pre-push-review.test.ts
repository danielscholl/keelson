// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { parseWorkflow } from "../src/loader.ts";
import type { DagNode, NodeOutput } from "../src/schema/index.ts";
import { checkTriggerRule } from "../src/triggers.ts";

const bashDescribe = process.platform === "win32" ? describe.skip : describe;

function loadResolvePr(): DagNode[] {
  const filePath = join(import.meta.dir, "../assets/workflows/resolve-pr.yaml");
  const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
  expect(result.error).toBeNull();
  return [...(result.workflow?.nodes ?? [])];
}

function node(nodes: DagNode[], id: string): DagNode {
  const found = nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing node ${id} in resolve-pr`);
  return found;
}

describe("resolve-pr pre-push review wiring", () => {
  test("reviews the round's fix delta between validation repair and the push gate", () => {
    const nodes = loadResolvePr();
    const order = nodes.map((candidate) => candidate.id);
    const chain = [
      "fix-validation",
      "capture-fix-diff",
      "review-fix",
      "apply-review-fix",
      "revalidate",
      "push",
    ];

    expect(chain.map((id) => order.indexOf(id))).toEqual(
      [...chain.map((id) => order.indexOf(id))].sort((a, b) => a - b),
    );
    expect(node(nodes, "capture-fix-diff").depends_on).toEqual(["fix-validation"]);
    expect(node(nodes, "review-fix").depends_on).toEqual(["capture-fix-diff"]);
    expect(node(nodes, "review-fix").when).toBe("$capture-fix-diff.output.has_fix == 'true'");
    expect(node(nodes, "apply-review-fix").depends_on).toEqual(["review-fix"]);
    expect(node(nodes, "push").depends_on).toEqual(["revalidate"]);
  });

  test("the reviewer is read-only, fail-closed, and not the fixer's model", () => {
    const nodes = loadResolvePr();
    const review = node(nodes, "review-fix");
    const fixer = node(nodes, "apply-review-fix");

    expect(review.allowed_tools).toEqual(["Read", "Glob", "Grep"]);
    expect(review.output_schema).toMatchObject({
      type: "object",
      required: ["findings"],
      properties: { findings: { type: "array" } },
    });
    expect(review.prompt).toContain('`{"findings":[]}`');
    expect(review.prompt).toContain("fix-diff.patch");
    expect(review.model_by_provider?.copilot).not.toBe(fixer.model_by_provider?.copilot);
    expect(node(nodes, "fix").model_by_provider?.copilot).toBe(fixer.model_by_provider?.copilot);
  });

  test("the review fixer commits but leaves the push to the gated node", () => {
    const prompt = node(loadResolvePr(), "apply-review-fix").prompt?.replace(/\s+/g, " ");

    expect(prompt).toContain("severity CRITICAL or HIGH and confidence >= 80");
    expect(prompt).toContain("Try to refute each remaining finding first");
    expect(prompt).toContain("Do NOT push");
    expect(prompt).not.toContain("git push");
  });

  test("the hard gate still runs when the review chain is skipped, never after a failure", () => {
    const revalidate = node(loadResolvePr(), "revalidate");
    const outputs = (fixValidation: NodeOutput["state"], applyReviewFix: NodeOutput["state"]) => {
      const map = new Map<string, NodeOutput>();
      map.set("fix-validation", { state: fixValidation, output: "" } as NodeOutput);
      map.set("apply-review-fix", { state: applyReviewFix, output: "" } as NodeOutput);
      return map;
    };

    expect(revalidate.depends_on).toEqual(["fix-validation", "apply-review-fix"]);
    expect(checkTriggerRule(revalidate, outputs("completed", "completed"))).toBe("run");
    expect(checkTriggerRule(revalidate, outputs("completed", "skipped"))).toBe("run");
    expect(checkTriggerRule(revalidate, outputs("completed", "failed"))).toBe("skip");
    expect(checkTriggerRule(revalidate, outputs("failed", "skipped"))).toBe("skip");
    expect(checkTriggerRule(revalidate, outputs("skipped", "skipped"))).toBe("skip");
  });

  test("fixers are told to check what else a fix touches", () => {
    const prompt = node(loadResolvePr(), "fix").prompt?.replace(/\s+/g, " ");

    expect(prompt).toContain("Before committing a fix, name what else it touches");
    expect(prompt).toContain("data written before this change");
  });
});

bashDescribe("resolve-pr capture-fix-diff", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const proc = Bun.spawnSync({
      cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  }

  function setup(): { repo: string; artifacts: string } {
    const repo = mkdtempSync(join(tmpdir(), "keelson-fixdiff-repo-"));
    const artifacts = mkdtempSync(join(tmpdir(), "keelson-fixdiff-art-"));
    tmps.push(repo, artifacts);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    return { repo, artifacts };
  }

  function run(repo: string, artifacts: string) {
    const script = node(loadResolvePr(), "capture-fix-diff").bash;
    if (!script) throw new Error("capture-fix-diff has no bash body");
    const proc = Bun.spawnSync({
      cmd: ["bash", "-c", script],
      cwd: repo,
      env: { ...(process.env as Record<string, string>), KEELSON_ARTIFACTS_DIR: artifacts },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
  }

  test("reports no fix when the round committed nothing", () => {
    const { repo, artifacts } = setup();
    writeFileSync(join(artifacts, ".round-base-sha"), `${git(repo, "rev-parse", "HEAD")}\n`);

    const result = run(repo, artifacts);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ has_fix: "false", lines: 0 });
  });

  test("scopes the patch to commits made since the round base", () => {
    const { repo, artifacts } = setup();
    writeFileSync(join(artifacts, ".round-base-sha"), `${git(repo, "rev-parse", "HEAD")}\n`);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "commit", "-q", "-am", "fix: thread");

    const result = run(repo, artifacts);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).has_fix).toBe("true");
    expect(readFileSync(join(artifacts, "fix-diff.patch"), "utf8")).toContain("+two");
  });

  test("fails instead of reporting a clean round when the base was never recorded", () => {
    const { repo, artifacts } = setup();

    const result = run(repo, artifacts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

bashDescribe("resolve-pr review base across converge attempts", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const proc = Bun.spawnSync({
      cmd: [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "safe.bareRepository=all",
        ...args,
      ],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  }

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmps.push(dir);
    return dir;
  }

  function setup() {
    const origin = scratch("keelson-base-origin-");
    const repo = scratch("keelson-base-repo-");
    const artifacts = scratch("keelson-base-art-");
    const bin = scratch("keelson-base-bin-");
    git(origin, "init", "-q", "--bare");
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", origin);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "pr head");
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/feature");
    const forge = `#!/usr/bin/env bash
case "$1 $2" in
  "pr threads") echo '[]' ;;
  "pr checkout") git fetch -q origin feature && git checkout -q --detach FETCH_HEAD ;;
  "pr view")
    case "$*" in
      *isCrossRepository*) echo false ;;
      *headRefName*) echo feature ;;
    esac ;;
esac
`;
    writeFileSync(join(bin, "forge"), forge);
    chmodSync(join(bin, "forge"), 0o755);
    const env = {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_NODE_extract_pr_OUTPUT: "42",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
    const run = (id: string, round: number) => {
      const script = node(loadResolvePr(), id).bash?.replaceAll("$converge.round", String(round));
      if (!script) throw new Error(`${id} has no bash body`);
      const proc = Bun.spawnSync({
        cmd: ["bash", "-c", script],
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) throw new Error(`${id}: ${proc.stderr.toString()}`);
      return proc.stdout.toString().trim();
    };
    const base = () => readFileSync(join(artifacts, ".round-base-sha"), "utf8").trim();
    return { repo, origin, run, base };
  }

  test("a fix left unpushed by a failed attempt is still reviewed on the next one", () => {
    const { repo, run, base } = setup();
    run("fetch-state", 1);
    const prHead = git(repo, "rev-parse", "HEAD");
    expect(base()).toBe(prHead);

    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "commit", "-q", "-am", "fix: thread");
    run("fetch-state", 2);

    expect(base()).toBe(prHead);
    expect(JSON.parse(run("capture-fix-diff", 2)).has_fix).toBe("true");
  });

  test("a successful push advances the base so the next round reviews only new commits", () => {
    const { repo, origin, run, base } = setup();
    run("fetch-state", 1);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "commit", "-q", "-am", "fix: thread");

    run("push", 1);

    const pushed = git(repo, "rev-parse", "HEAD");
    expect(git(origin, "--git-dir", origin, "rev-parse", "refs/heads/feature")).toBe(pushed);
    expect(base()).toBe(pushed);
    run("fetch-state", 2);
    expect(JSON.parse(run("capture-fix-diff", 2))).toEqual({ has_fix: "false", lines: 0 });
  });
});

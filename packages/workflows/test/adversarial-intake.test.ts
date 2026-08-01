// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function intakeBash(): string {
  const document = parse(
    readFileSync(join(bundledWorkflowsDir(), "adversarial-review.yaml"), "utf8"),
  ) as { nodes: Array<{ id: string; bash?: string }> };
  const script = document.nodes.find((node) => node.id === "intake")?.bash;
  if (!script) throw new Error("Missing intake bash node in adversarial-review");
  return script;
}

function runIntake(
  args: string,
  opts: { subject?: string; subjectRequired?: string; cwd?: string } = {},
) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-ar-intake-"));
  tmps.push(artifacts);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEELSON_ARGUMENTS: args,
    KEELSON_ARTIFACTS_DIR: artifacts,
  };
  if (opts.subject !== undefined) env.KEELSON_INPUTS_subject = opts.subject;
  if (opts.subjectRequired !== undefined) {
    env.KEELSON_INPUTS_subject_required = opts.subjectRequired;
  }
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", intakeBash()],
    cwd: opts.cwd ?? tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    artifacts,
  };
}

// lstat (never stat) so a dangling link still reports as present, which is
// exactly the case the containment check must catch.
function lstatSyncSafe(path: string): { isSymbolicLink: () => boolean } | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function gitRepoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), "keelson-ar-subject-"));
  tmps.push(repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "x.txt"), "hello subject\n");
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync({
      cmd: ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`git ${args[0]}: ${proc.stderr.toString()}`);
  };
  git("init", "--quiet");
  git("add", "src/x.txt");
  git("commit", "--quiet", "-m", "seed");
  return repo;
}

function gitOutput(repo: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args[0]}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

// Subjects that exist only on the remote under refs/pull/N/head — the form that
// forces intake down its fetch path. Returns a checkout with no local copy.
function remoteRepoWithPullRefs(contents: readonly string[]): string {
  const origin = mkdtempSync(join(tmpdir(), "keelson-ar-origin-"));
  tmps.push(origin);
  gitOutput(origin, "init", "--bare", "--quiet");

  contents.forEach((content, index) => {
    const seed = mkdtempSync(join(tmpdir(), "keelson-ar-seed-"));
    tmps.push(seed);
    mkdirSync(join(seed, "src"));
    writeFileSync(join(seed, "src", "x.txt"), content);
    gitOutput(seed, "init", "--quiet");
    gitOutput(seed, "add", "src/x.txt");
    gitOutput(seed, "commit", "--quiet", "-m", "seed");
    gitOutput(seed, "push", "--quiet", origin, `HEAD:refs/pull/${index + 1}/head`);
  });

  const clone = mkdtempSync(join(tmpdir(), "keelson-ar-clone-"));
  tmps.push(clone);
  gitOutput(clone, "init", "--quiet");
  gitOutput(clone, "remote", "add", "origin", origin);
  return clone;
}

async function runIntakeAsync(args: string, opts: { subject?: string; cwd?: string } = {}) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-ar-intake-"));
  tmps.push(artifacts);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEELSON_ARGUMENTS: args,
    KEELSON_ARTIFACTS_DIR: artifacts,
  };
  if (opts.subject !== undefined) env.KEELSON_INPUTS_subject = opts.subject;
  const proc = Bun.spawn({
    cmd: ["bash", "-c", intakeBash()],
    cwd: opts.cwd ?? tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited, artifacts };
}

shimDescribe("adversarial-review intake", () => {
  test("passes inline text through as the artifact", () => {
    const result = runIntake("Claim: the sky is green.");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claim: the sky is green.");
  });

  test("bundles a directory of evidence files under labeled separators, sorted", () => {
    const bundle = mkdtempSync(join(tmpdir(), "keelson-ar-bundle-"));
    tmps.push(bundle);
    writeFileSync(join(bundle, "b-logs.txt"), "ci was green\n");
    writeFileSync(join(bundle, "a-claim.md"), "the fix is complete\n");
    const result = runIntake(bundle);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("===== EVIDENCE FILE: a-claim.md =====");
    expect(result.stdout).toContain("the fix is complete");
    expect(result.stdout).toContain("===== EVIDENCE FILE: b-logs.txt =====");
    expect(result.stdout).toContain("ci was green");
    expect(result.stdout.indexOf("a-claim.md")).toBeLessThan(result.stdout.indexOf("b-logs.txt"));
  });

  test("rejects an empty evidence directory", () => {
    const bundle = mkdtempSync(join(tmpdir(), "keelson-ar-empty-"));
    tmps.push(bundle);
    const result = runIntake(bundle);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no readable files");
  });

  test("snapshots a resolvable subject ref into the artifacts dir", () => {
    const repo = gitRepoWithCommit();
    const result = runIntake("Claim: src/x.txt greets the subject.", {
      subject: "HEAD",
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    const snapshot = join(result.artifacts, "subject", "src", "x.txt");
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot, "utf8")).toBe("hello subject\n");
    expect(result.stderr).toContain("Subject snapshot: HEAD");
  });

  test("strips symlinks from the subject snapshot so the verifier cannot escape it", () => {
    const repo = gitRepoWithCommit();
    const proc = (...args: string[]) =>
      Bun.spawnSync({
        cmd: ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        stdout: "pipe",
        stderr: "pipe",
      });
    symlinkSync("/etc/passwd", join(repo, "leak"));
    proc("add", "leak");
    proc("commit", "--quiet", "-m", "add a link out of the tree");

    const result = runIntake("Claim: the tree is safe to read.", {
      subject: "HEAD",
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.artifacts, "subject", "src", "x.txt"))).toBe(true);
    expect(lstatSyncSafe(join(result.artifacts, "subject", "leak"))).toBeNull();
    expect(result.stderr).toContain("removed 1 symlink");
  });

  test("degrades gracefully when the subject ref does not resolve", () => {
    const repo = gitRepoWithCommit();
    const result = runIntake("Claim: still reviewable.", {
      subject: "no-such-ref",
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("did not resolve");
    expect(existsSync(join(result.artifacts, "subject"))).toBe(false);
    expect(result.stdout).toContain("Claim: still reviewable.");
  });

  test("fails when a required subject ref does not resolve", () => {
    const repo = gitRepoWithCommit();
    const result = runIntake("Claim: must use the pinned tree.", {
      subject: "no-such-ref",
      subjectRequired: "true",
      cwd: repo,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not resolve");
  });

  test("fails when a required subject cannot be snapshotted outside a git repository", () => {
    const result = runIntake("Claim: must use the pinned tree.", {
      subject: "HEAD",
      subjectRequired: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not inside a git repository");
  });

  test("fetches a remote-only subject through a run-scoped ref and leaves none behind", () => {
    const clone = remoteRepoWithPullRefs(["only-on-the-remote\n"]);
    const result = runIntake("Claim: the remote tree is the subject.", {
      subject: "refs/pull/1/head",
      cwd: clone,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.artifacts, "subject", "src", "x.txt"), "utf8")).toBe(
      "only-on-the-remote\n",
    );
    expect(gitOutput(clone, "for-each-ref", "--format=%(refname)", "refs/keelson/")).toBe("");
  });

  // The `locking: shared` case: two reviews fetching different subjects into one
  // checkout. Resolving through repo-wide FETCH_HEAD let either run archive the
  // other's commit.
  test("concurrent subjects in one checkout each snapshot their own commit", async () => {
    const clone = remoteRepoWithPullRefs(["first-subject\n", "second-subject\n"]);

    const [a, b] = await Promise.all([
      runIntakeAsync("Claim: A.", { subject: "refs/pull/1/head", cwd: clone }),
      runIntakeAsync("Claim: B.", { subject: "refs/pull/2/head", cwd: clone }),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(readFileSync(join(a.artifacts, "subject", "src", "x.txt"), "utf8")).toBe(
      "first-subject\n",
    );
    expect(readFileSync(join(b.artifacts, "subject", "src", "x.txt"), "utf8")).toBe(
      "second-subject\n",
    );
  });
});

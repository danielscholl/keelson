// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

interface WorkflowNode {
  id: string;
  bash?: string;
  script?: string;
  depends_on?: string[];
  different_vendor_from?: string;
  model_by?: {
    from: string;
    cases: Record<
      string,
      {
        model?: string;
        model_by_provider?: Record<string, string>;
        effort?: string;
      }
    >;
  };
}

interface WorkflowDocument {
  nodes: WorkflowNode[];
}

const workflowPath = join(bundledWorkflowsDir(), "investigate.yaml");
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function workflowText(): string {
  return readFileSync(workflowPath, "utf8");
}

function workflowDocument(): WorkflowDocument {
  return parse(workflowText()) as WorkflowDocument;
}

function nodeBody(id: string, field: "bash" | "script"): string {
  const body = workflowDocument().nodes.find((node) => node.id === id)?.[field];
  if (!body) throw new Error(`Missing ${field} body for ${id}`);
  return body;
}

function artifactsDir(runId: string): string {
  const root = mkdtempSync(join(tmpdir(), "keelson-investigate-"));
  tmps.push(root);
  const artifacts = join(root, runId);
  mkdirSync(artifacts);
  return artifacts;
}

function runIntake(
  question: string,
  inputs: {
    out?: string;
    context?: string;
    access?: string;
    tier?: string;
    verifier?: string;
    runId?: string;
  } = {},
) {
  const runId = inputs.runId ?? "run-default";
  const artifacts = artifactsDir("keelson-cli-run-random");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEELSON_ARGUMENTS: question,
    KEELSON_ARTIFACTS_DIR: artifacts,
    KEELSON_RUN_ID: runId,
  };
  for (const [key, value] of Object.entries({
    out: inputs.out,
    context: inputs.context,
    access: inputs.access,
    tier: inputs.tier,
    verifier: inputs.verifier,
  })) {
    const name = `KEELSON_INPUTS_${key}`;
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", nodeBody("intake", "bash")],
    cwd: tmpdir(),
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

function runFinalizer(
  evidence: string,
  provenance: {
    investigatorProvider?: string;
    investigatorModel?: string;
    verifierProvider?: string;
    verifierModel?: string;
    runId?: string;
  } = {},
) {
  const runId = provenance.runId ?? "12345678-pilot";
  const artifacts = artifactsDir("keelson-cli-run-random");
  const out = join(artifacts, "evidence.md");
  writeFileSync(out, evidence);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEELSON_INPUTS_out: out,
    KEELSON_ARTIFACTS_DIR: artifacts,
    KEELSON_RUN_ID: runId,
  };
  const values = {
    KEELSON_NODE_investigate_PROVIDER: provenance.investigatorProvider ?? "copilot",
    KEELSON_NODE_investigate_MODEL: provenance.investigatorModel ?? "gpt-6-astra",
    KEELSON_NODE_verify_PROVIDER: provenance.verifierProvider ?? "copilot",
    KEELSON_NODE_verify_MODEL: provenance.verifierModel ?? "claude-sonnet-5",
  };
  Object.assign(env, values);
  const run = () =>
    Bun.spawnSync({
      cmd: ["uv", "run", "python", "-c", nodeBody("finalize", "script")],
      cwd: tmpdir(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  return { out, run };
}

describe("investigate workflow shape", () => {
  test("has exactly five ordered nodes and declares cross-vendor verification", () => {
    const nodes = workflowDocument().nodes;
    expect(nodes.map(({ id }) => id)).toEqual([
      "intake",
      "investigate",
      "verify",
      "publish",
      "finalize",
    ]);
    expect(nodes.find(({ id }) => id === "verify")?.different_vendor_from).toBe("investigate");
  });

  test("maps each stable provider through its own model contract", () => {
    const nodes = workflowDocument().nodes;
    const investigate = nodes.find(({ id }) => id === "investigate")?.model_by;
    const verify = nodes.find(({ id }) => id === "verify")?.model_by;

    expect(investigate?.cases.deep).toEqual({
      model: "deep",
      model_by_provider: {
        copilot: "gpt-6-astra",
        claude: "claude-opus-4-8",
        codex: "gpt-5.6-sol",
      },
      effort: "high",
    });
    expect(investigate?.cases.std).toEqual({
      model: "balanced",
      model_by_provider: {
        copilot: "gpt-5.6-terra",
        claude: "claude-sonnet-5",
        codex: "gpt-5.6-terra",
      },
      effort: "high",
    });
    expect(verify?.cases.claude?.model_by_provider).toEqual({
      copilot: "claude-sonnet-5",
      claude: "claude-sonnet-5",
      codex: "gpt-5.6-terra",
    });
    expect(verify?.cases.grok?.model_by_provider).toEqual({
      copilot: "grok-4.6",
      claude: "claude-sonnet-5",
      codex: "gpt-5.6-terra",
    });
  });

  test("contains no project-specific terms", () => {
    expect(workflowText()).not.toMatch(/osdu|cimpl|omcp|charter|board/i);
  });
});

describe("investigate intake", () => {
  test("requires the actual question and output path", () => {
    const noQuestion = runIntake("   ", { out: "evidence.md" });
    expect(noQuestion.exitCode).not.toBe(0);
    expect(noQuestion.stderr).toContain("no question provided");

    const noOut = runIntake("What does this function return?");
    expect(noOut.exitCode).not.toBe(0);
    expect(noOut.stderr).toContain("required input `out`");
  });

  test("emits the normalized closed defaults and actual inputs", () => {
    const out = join(tmpdir(), "evidence.md");
    const result = runIntake("  What does this function return?  ", {
      out,
      runId: "run-alpha",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.question).toBe("What does this function return?");
    expect(parsed.out).toBe(out);
    expect(parsed.tier).toBe("deep");
    expect(["claude", "grok"]).toContain(parsed.verifier);
    expect(parsed.bundle).toContain("QUESTION\nWhat does this function return?");
  });

  test("rotates the default verifier deterministically from fixed run ids", () => {
    const first = JSON.parse(runIntake("Question?", { out: "a.md", runId: "run-alpha" }).stdout);
    const repeated = JSON.parse(runIntake("Question?", { out: "b.md", runId: "run-alpha" }).stdout);
    const second = JSON.parse(runIntake("Question?", { out: "c.md", runId: "run-beta" }).stdout);
    expect(first.verifier).toBe("claude");
    expect(repeated.verifier).toBe("claude");
    expect(second.verifier).toBe("grok");
  });

  test("rejects values outside the tier and verifier sets", () => {
    const badTier = runIntake("Question?", { out: "a.md", tier: "extreme" });
    expect(badTier.exitCode).not.toBe(0);
    expect(badTier.stderr).toContain("expected deep or std");

    const badVerifier = runIntake("Question?", { out: "a.md", verifier: "other" });
    expect(badVerifier.exitCode).not.toBe(0);
    expect(badVerifier.stderr).toContain("expected claude or grok");
  });

  test("bundles sorted context files and resolves access files", () => {
    const context = mkdtempSync(join(tmpdir(), "keelson-investigate-context-"));
    tmps.push(context);
    writeFileSync(join(context, "b.txt"), "second\n");
    writeFileSync(join(context, "a.txt"), "first\n");
    const access = join(context, "access.txt");
    writeFileSync(access, "Use the local read endpoint only.\n");

    const result = runIntake("Question?", {
      out: "evidence.md",
      context,
      access,
      verifier: "CLAUDE",
      tier: "STD",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tier).toBe("std");
    expect(parsed.verifier).toBe("claude");
    expect(parsed.access).toBe("Use the local read endpoint only.");
    expect(parsed.bundle.indexOf("a.txt")).toBeLessThan(parsed.bundle.indexOf("b.txt"));
    expect(parsed.bundle).toContain("first\n");
    expect(parsed.bundle).toContain("second\n");
  });

  test("passes literal access guidance and bundles a context file", () => {
    const context = join(artifactsDir("context-file"), "notes.md");
    writeFileSync(context, "source note\n");
    const result = runIntake("Question?", {
      out: "evidence.md",
      context,
      access: "Use only read operations.",
      verifier: "grok",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.access).toBe("Use only read operations.");
    expect(parsed.bundle).toContain("===== CONTEXT FILE: notes.md =====");
    expect(parsed.bundle).toContain("source note");
  });

  test("rejects oversized context instead of truncating it", () => {
    const context = join(artifactsDir("oversized"), "large.txt");
    writeFileSync(context, "x".repeat(1_000_001));
    const result = runIntake("Question?", { out: "evidence.md", context });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("limit is 1000000");
    expect(result.stdout).toBe("");
  });
});

describe("investigate finalizer", () => {
  const evidence = `# Evidence

| Citation | Verified | Claim | Verification note | Level |
| --- | --- | --- | --- | --- |
| src/a.ts:1 | CONFIRMED | Alpha | reproduced | source-verified |
| docs/a.md:2 | CONFIRMED in part | Beta | narrower than stated | documented |
| command output | REFUTED | Gamma | opposite result | runtime-tested |
| unavailable system | UNVERIFIABLE | Delta | no access | runtime-tested |
| src/e.ts:5 | NOT CHECKED | Epsilon | verifier omitted it | source-verified |

## Not checked

- External deployment state.
`;

  test("counts every verdict and attributes the effective fallback models", () => {
    const { out, run } = runFinalizer(evidence, {
      investigatorProvider: "claude",
      investigatorModel: "claude-opus-4-8",
      verifierProvider: "claude",
      verifierModel: "claude-sonnet-5",
      runId: "abcdef12-rest",
    });
    const result = run();
    expect(result.exitCode).toBe(0);
    const finalized = readFileSync(out, "utf8");
    expect(finalized).toContain(
      "Tally: confirmed=1; confirmed in part=1; refuted=1; unverifiable=1; not checked=1.",
    );
    expect(finalized).toMatch(
      /Run abcdef12, \d{4}-\d{2}-\d{2}: investigated by `claude-opus-4-8` via `claude`; rows added or changed in this run were verified by `claude-sonnet-5` via `claude`\./,
    );
    expect(finalized).not.toContain("gpt-6-astra");
  });

  test("rewrites its generated section idempotently", () => {
    const { out, run } = runFinalizer(evidence);
    expect(run().exitCode).toBe(0);
    const once = readFileSync(out, "utf8");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(once);
    expect(once.match(/## Verification summary/g)).toHaveLength(1);
  });

  test.each([
    [
      "| Claim | Level | Citation |\n| --- | --- | --- |\n| A | documented | src/a.ts:1 |\n",
      "no claim table",
    ],
    [
      "| Claim | Level | Citation | Verified |\n| --- | --- | --- | --- |\n| A | guessed | x | CONFIRMED |\n",
      "unsupported claim level",
    ],
    [
      "| Claim | Level | Citation | Verified |\n| --- | --- | --- | --- |\n| A | documented | x | MAYBE |\n",
      "unsupported verification verdict",
    ],
  ])("fails closed for malformed evidence", (contents, message) => {
    const { run } = runFinalizer(contents);
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(message);
  });

  test("fails closed when effective attribution is absent", () => {
    const { out } = runFinalizer(evidence);
    const artifacts = artifactsDir("missing-provenance");
    const proc = Bun.spawnSync({
      cmd: ["uv", "run", "python", "-c", nodeBody("finalize", "script")],
      cwd: tmpdir(),
      env: {
        ...(process.env as Record<string, string>),
        KEELSON_INPUTS_out: out,
        KEELSON_ARTIFACTS_DIR: artifacts,
        KEELSON_RUN_ID: "missing-provenance",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("KEELSON_NODE_investigate_PROVIDER");
  });
});

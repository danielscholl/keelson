// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

interface WorkflowNode {
  id: string;
  bash?: string;
  script?: string;
  prompt?: string;
  runtime?: string;
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

function runCellsProbe(line: string) {
  const script = nodeBody("finalize", "script");
  const end = script.indexOf("\nfunction separator");
  if (end < 0) throw new Error("Missing cells function boundary");
  return Bun.spawnSync({
    cmd: [
      "bun",
      "--no-env-file",
      "-e",
      `${script.slice(0, end)}\nconsole.log(JSON.stringify(cells(${JSON.stringify(line)})));`,
    ],
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
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
    fixtures?: string;
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
    fixtures: inputs.fixtures,
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
      cmd: ["bun", "--no-env-file", "-e", nodeBody("finalize", "script")],
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
    expect(nodes.find(({ id }) => id === "finalize")?.runtime).toBe("bun");
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

  test("keeps the evidence file as the only write when no fixtures directory is given", () => {
    const result = runIntake("What does this function return?", {
      out: join(tmpdir(), "evidence.md"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fixtures).toBe("");
    expect(parsed.fixtures_note).toBe("");
    expect(parsed.write_policy).toBe("That requested file is the only intentional write.");
  });

  test("creates the fixtures directory and names it as an intended write", () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-investigate-fixtures-"));
    tmps.push(root);
    const fixtures = join(root, "nested", "fixtures");
    const result = runIntake("What does the search API return?", {
      out: join(root, "evidence.md"),
      fixtures: `  ${fixtures}  `,
    });
    expect(result.exitCode).toBe(0);
    expect(statSync(fixtures).isDirectory()).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fixtures).toBe(fixtures);
    expect(parsed.write_policy).toContain(`under \`${fixtures}\``);
    expect(parsed.write_policy).toContain("Keep raw responses out of the evidence file");
    expect(parsed.write_policy).not.toContain("That requested file is the only intentional write");
    expect(parsed.fixtures_note).toContain(fixtures);
  });

  test("rejects a fixtures path that is a file", () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-investigate-fixtures-"));
    tmps.push(root);
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    const result = runIntake("What does the search API return?", {
      out: join(root, "evidence.md"),
      fixtures: file,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fixtures is not a directory");
  });

  test("rejects a fixtures path that names the evidence file, before creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-investigate-fixtures-"));
    tmps.push(root);
    const out = join(root, "evidence");
    const result = runIntake("What does the search API return?", {
      out,
      fixtures: `${root}/./evidence/`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fixtures and out name the same path");
    expect(existsSync(out)).toBe(false);
  });

  test("rejects a fixtures path that reaches the evidence file through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-investigate-fixtures-"));
    tmps.push(root);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"), "junction");
    const out = join(root, "real", "evidence");
    const result = runIntake("What does the search API return?", {
      out,
      fixtures: join(root, "link", "evidence"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fixtures and out name the same path");
    expect(existsSync(out)).toBe(false);
  });

  test("the prompts read the write policy and fixtures note from intake", () => {
    const nodes = workflowDocument().nodes;
    const investigate = nodes.find((node) => node.id === "investigate")?.prompt ?? "";
    const verify = nodes.find((node) => node.id === "verify")?.prompt ?? "";
    expect(investigate).toContain("$intake.output.write_policy");
    expect(investigate).not.toContain("only intentional write");
    expect(verify).toContain("$intake.output.fixtures_note");
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

  test("accepts large readable access files below the aggregate limit", () => {
    const access = join(artifactsDir("large-access"), "access.txt");
    const guidance = "a".repeat(200_000);
    writeFileSync(access, guidance);

    const result = runIntake("Question?", { out: "evidence.md", access });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.access).toBe(guidance);
    expect(parsed.bundle).toContain(guidance);
  });

  test("rejects access files that exceed the aggregate limit", () => {
    const access = join(artifactsDir("oversized-access"), "access.txt");
    writeFileSync(access, "x".repeat(600_000));
    const result = runIntake("Question?", { out: "evidence.md", access });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("limit is 1000000");
    expect(result.stdout).toBe("");
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

| Citation | Verified | Claim # | Claim | Verification note | Level |
| --- | --- | --- | --- | --- | --- |
| src/a.ts:1 | CONFIRMED | 1 | Alpha | reproduced | source-verified |
| docs/a.md:2 | CONFIRMED in part | 2 | Beta | narrower than stated | documented |
| command output | REFUTED | 3 | Gamma | opposite result | runtime-tested |
| unavailable system | UNVERIFIABLE | 4 | Delta | no access | runtime-tested |
| src/e.ts:5 | NOT CHECKED | 5 | Epsilon | verifier omitted it | source-verified |

## Not checked

- External deployment state.
`;

  function singleClaimEvidence(claim: string): string {
    return `# Evidence

| Claim # | Claim | Level | Citation | Verified |
| --- | --- | --- | --- | --- |
| 1 | ${claim} | source-verified | src/a.ts:1 | CONFIRMED |
`;
  }

  function fencedClaimTable(opening: string, closing: string): string {
    return `${opening}
| Citation | Verified | Claim # | Claim | Verification note | Level |
| --- | --- | --- | --- | --- | --- |
| example | CONFIRMED | 1 | Example | sample only | documented |
${closing}`;
  }

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

  test.each([
    ["an unescaped pipe inside a code span", "`A|B|C`"],
    ["an escaped literal pipe", "A\\|B"],
    ["a double-backtick span containing a pipe and a single backtick", "``A|B`C``"],
  ])("accepts %s", (_name, claim) => {
    const { out, run } = runFinalizer(singleClaimEvidence(claim));
    expect(run().exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(
      "Tally: confirmed=1; confirmed in part=0; refuted=0; unverifiable=0; not checked=0.",
    );
  });

  test("accepts and unescapes an escaped pipe inside a code span", () => {
    const claim = "`A\\|B`";
    const probe = runCellsProbe(`| 1 | ${claim} | source-verified | src/a.ts:1 | CONFIRMED |`);
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim()).toBe(
      '["1","`A|B`","source-verified","src/a.ts:1","CONFIRMED"]',
    );

    const { out, run } = runFinalizer(singleClaimEvidence(claim));
    expect(run().exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(
      "Tally: confirmed=1; confirmed in part=0; refuted=0; unverifiable=0; not checked=0.",
    );
  });

  test("treats an escaped backtick as literal, not a code-span opener", () => {
    const probe = runCellsProbe("| 1 | \\`foo|bar\\` | source-verified | src/a.ts:1 | CONFIRMED |");
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim()).toBe(
      '["1","\\\\`foo","bar\\\\`","source-verified","src/a.ts:1","CONFIRMED"]',
    );
  });

  test("identifies a claim whose row has too many cells", () => {
    const malformed = `| Claim # | Claim | Level | Citation | Verified |
| --- | --- | --- | --- | --- |
| 7 | Alpha | documented | src/a.ts:1 | CONFIRMED | extra |
`;
    const { run } = runFinalizer(malformed);
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Claim 7");
    expect(result.stderr.toString()).toContain("cells; expected");
    expect(result.stderr.toString()).toContain(
      "| 7 | Alpha | documented | src/a.ts:1 | CONFIRMED | extra |",
    );
  });

  test.each([
    ["backtick", "```markdown", "```"],
    ["tilde", "~~~~markdown", "~~~~"],
  ])("ignores claim tables inside %s fences", (_name, opening, closing) => {
    const { out, run } = runFinalizer(`${fencedClaimTable(opening, closing)}\n\n${evidence}`);
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(
      "Tally: confirmed=1; confirmed in part=1; refuted=1; unverifiable=1; not checked=1.",
    );
  });

  test("rejects evidence containing only a fenced claim table", () => {
    const { run } = runFinalizer(fencedClaimTable("```markdown", "```"));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no claim table");
  });

  test("rewrites its generated section idempotently", () => {
    const { out, run } = runFinalizer(evidence);
    expect(run().exitCode).toBe(0);
    const once = readFileSync(out, "utf8");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(once);
    expect(once.match(/## Verification summary/g)).toHaveLength(1);
    expect(once.match(/keelson:generated:investigate-verification-summary:start/g)).toHaveLength(1);
    expect(once.match(/keelson:generated:investigate-verification-summary:end/g)).toHaveLength(1);
  });

  test("preserves matching headings in prose, quotes, and fenced examples", () => {
    const collisionEvidence = evidence.replace(
      "## Not checked",
      `## Verification summary

This is source evidence, not generated output.

> ## Verification summary
>
> This heading is quoted evidence.

\`\`\`md
## Verification summary
This heading is part of a fenced example.
\`\`\`

## Not checked`,
    );
    const { out, run } = runFinalizer(collisionEvidence);
    expect(run().exitCode).toBe(0);
    const finalized = readFileSync(out, "utf8");
    expect(finalized).toContain("This is source evidence, not generated output.");
    expect(finalized).toContain("> This heading is quoted evidence.");
    expect(finalized).toContain("This heading is part of a fenced example.");
    expect(finalized).toContain("- External deployment state.");
    expect(finalized.match(/## Verification summary/g)).toHaveLength(4);
  });

  test("preserves trailing material when replacing its generated block", () => {
    const { out, run } = runFinalizer(evidence);
    expect(run().exitCode).toBe(0);
    writeFileSync(out, `${readFileSync(out, "utf8")}\n## Follow-up evidence\n\nStill relevant.\n`);

    expect(run().exitCode).toBe(0);
    const replaced = readFileSync(out, "utf8");
    expect(replaced).toContain("## Follow-up evidence\n\nStill relevant.");
    expect(replaced.indexOf("Still relevant.")).toBeLessThan(
      replaced.indexOf("<!-- keelson:generated:investigate-verification-summary:start -->"),
    );
    expect(
      replaced.match(/keelson:generated:investigate-verification-summary:start/g),
    ).toHaveLength(1);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(replaced);
  });

  test.each([
    [
      "| Claim # | Claim | Level | Citation |\n| --- | --- | --- | --- |\n| 1 | A | documented | src/a.ts:1 |\n",
      "no claim table",
    ],
    [
      "| Claim # | Claim | Level | Citation | Verified |\n| --- | --- | --- | --- | --- |\n| 1 | A | guessed | x | CONFIRMED |\n",
      "unsupported claim level",
    ],
    [
      "| Claim # | Claim | Level | Citation | Verified |\n| --- | --- | --- | --- | --- |\n| 1 | A | documented | x | MAYBE |\n",
      "unsupported verification verdict",
    ],
    [
      "| Claim # | Claim | Level | Citation | Verified |\n| --- | --- |\n| 1 | A | documented | x | CONFIRMED |\n",
      "claim table is missing its Markdown separator row",
    ],
    [
      "| Claim # | Claim | Level | Citation | Verified |\n| --- | --- | --- | --- | --- |\n| 1 | A | documented | | CONFIRMED |\n",
      "claim table contains an empty Citation cell",
    ],
    [
      "| Claim # | Claim | Level | Citation | Verified |\n| --- | --- | --- | --- | --- |\n| one | A | documented | x | CONFIRMED |\n",
      "invalid Claim # cell",
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
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KEELSON_INPUTS_out: out,
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_RUN_ID: "missing-provenance",
    };
    delete env.KEELSON_NODE_investigate_PROVIDER;
    delete env.KEELSON_NODE_investigate_MODEL;
    delete env.KEELSON_NODE_verify_PROVIDER;
    delete env.KEELSON_NODE_verify_MODEL;
    const proc = Bun.spawnSync({
      cmd: ["bun", "--no-env-file", "-e", nodeBody("finalize", "script")],
      cwd: tmpdir(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("KEELSON_NODE_investigate_PROVIDER");
  });
});

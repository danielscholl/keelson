// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_VALUE_MAX_CHARS } from "../src/handlers/subprocess.ts";
import { parseWorkflow } from "../src/loader.ts";
import { applyModelCase, selectModelCase } from "../src/model-by.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "../src/schema/index.ts";
import { bundledWorkflowsDir } from "../src/seed.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

const SEATS = [
  {
    id: "reviewer-logic",
    defaultModel: "claude-opus-5",
    alternateModel: "claude-opus-4.7",
  },
  {
    id: "reviewer-evidence",
    defaultModel: "gpt-5.6-sol",
    alternateModel: "gpt-6-astra",
  },
  { id: "reviewer-risk", defaultModel: "grok-4.6", alternateModel: "grok-4.5" },
  { id: "verify", defaultModel: "gpt-5.6-terra", alternateModel: "gpt-5.5" },
  {
    id: "synthesize",
    defaultModel: "claude-opus-4.8",
    alternateModel: "claude-opus-4.7",
  },
] as const;

afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function workflow(): WorkflowDefinition {
  const filename = join(bundledWorkflowsDir(), "adversarial-review.yaml");
  const result = parseWorkflow(readFileSync(filename, "utf8"), filename);
  if (result.workflow === null) {
    throw new Error(result.error?.error ?? "Unable to parse adversarial-review");
  }
  return result.workflow;
}

function bashNode(definition: WorkflowDefinition, id: string): string {
  const node = definition.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || typeof node.bash !== "string") {
    throw new Error(`Missing ${id} bash node`);
  }
  return node.bash;
}

function promptSeat(definition: WorkflowDefinition, id: string): DagNode {
  const node = definition.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || typeof node.prompt !== "string" || node.model_by === undefined) {
    throw new Error(`Missing ${id} prompt seat`);
  }
  return node;
}

function normalizedAuthor(definition: WorkflowDefinition, author?: string): string {
  const env = { ...(process.env as Record<string, string>) };
  delete env.KEELSON_INPUTS_author;
  if (author !== undefined) env.KEELSON_INPUTS_author = author;
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", bashNode(definition, "author-seat")],
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function effectiveModel(seat: DagNode, authorSelector: string): string {
  if (seat.model_by === undefined) throw new Error(`Seat ${seat.id} has no model_by map`);
  const outputs = new Map<string, NodeOutput>([
    ["author-seat", { state: "completed", output: authorSelector }],
  ]);
  const selection = selectModelCase(seat.model_by, {}, outputs);
  if (!selection.ok) throw new Error(selection.error);
  const resolved = applyModelCase(seat, selection.selected);
  const model = resolved.model_by_provider?.copilot;
  if (model === undefined) throw new Error(`Seat ${seat.id} has no Copilot model`);
  return model;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-adversarial-author-"));
  tmps.push(dir);
  return dir;
}

function runSave(definition: WorkflowDefinition, overrides: Readonly<Record<string, string>> = {}) {
  const env = { ...(process.env as Record<string, string>) };
  delete env.KEELSON_INPUTS_out;
  for (const key of Object.keys(env)) {
    if (key.startsWith("KEELSON_NODE_")) delete env[key];
  }
  Object.assign(env, {
    KEELSON_NODE_reviewer_logic_STATE: "completed",
    KEELSON_NODE_reviewer_evidence_STATE: "completed",
    KEELSON_NODE_reviewer_risk_STATE: "completed",
    KEELSON_NODE_verify_STATE: "completed",
    KEELSON_NODE_synthesize_STATE: "completed",
  });
  Object.assign(env, overrides);
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", bashNode(definition, "save")],
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

shimDescribe("adversarial-review author seating", () => {
  test.each([undefined, "   "])(
    "normalizes omitted author %p and preserves every seat",
    (author) => {
      const definition = workflow();
      const selector = normalizedAuthor(definition, author);

      expect(selector).toBe("seated");
      for (const expected of SEATS) {
        const seat = promptSeat(definition, expected.id);
        expect(seat.model_by_provider?.copilot).toBe(expected.defaultModel);
        expect(effectiveModel(seat, selector)).toBe(expected.defaultModel);
      }
    },
  );

  test("a non-matching author preserves every seat", () => {
    const definition = workflow();
    const selector = normalizedAuthor(definition, "unseated-model");

    expect(selector).toBe("unseated-model");
    for (const expected of SEATS) {
      expect(effectiveModel(promptSeat(definition, expected.id), selector)).toBe(
        expected.defaultModel,
      );
    }
  });

  test.each([...SEATS])(
    "excludes $defaultModel from all seats by moving $id to $alternateModel",
    (authoredSeat) => {
      const definition = workflow();
      const selector = normalizedAuthor(definition, ` ${authoredSeat.defaultModel} `);
      const effective = SEATS.map((expected) => ({
        id: expected.id,
        model: effectiveModel(promptSeat(definition, expected.id), selector),
      }));

      expect(selector).toBe(authoredSeat.defaultModel);
      expect(effective.every(({ model }) => model !== authoredSeat.defaultModel)).toBe(true);
      expect(
        effective.filter(
          ({ id, model }) => model !== SEATS.find((expected) => expected.id === id)?.defaultModel,
        ),
      ).toEqual([{ id: authoredSeat.id, model: authoredSeat.alternateModel }]);
    },
  );
});

shimDescribe("adversarial-review output persistence", () => {
  test("writes exactly five files and reads the complete spill above the environment cap", () => {
    const definition = workflow();
    const root = tempDir();
    const out = join(root, "review output");
    const spill = join(root, "verification.txt");
    const verdictSpill = join(root, "verdict.json");
    const verification = `start\n${"v".repeat(ENV_VALUE_MAX_CHARS + 500)}\nend`;
    const report = "# Verdict\n\nShip it.";
    writeFileSync(spill, verification);
    writeFileSync(
      verdictSpill,
      JSON.stringify({
        verdict: "CONFIRMED",
        headline: "Ship it",
        must_fix: [],
        open_questions: [],
        report,
      }),
    );

    const result = runSave(definition, {
      KEELSON_INPUTS_out: out,
      KEELSON_NODE_author_seat_OUTPUT: "claude-opus-5\n",
      KEELSON_NODE_reviewer_logic_OUTPUT: "logic",
      KEELSON_NODE_reviewer_evidence_OUTPUT: "evidence",
      KEELSON_NODE_reviewer_risk_OUTPUT: "risk",
      KEELSON_NODE_verify_OUTPUT: "[keelson: output truncated]",
      KEELSON_NODE_verify_OUTPUT_FILE: spill,
      KEELSON_NODE_verify_OUTPUT_TRUNCATED: "1",
      KEELSON_NODE_synthesize_OUTPUT: "[keelson: output truncated]",
      KEELSON_NODE_synthesize_OUTPUT_FILE: verdictSpill,
      KEELSON_NODE_synthesize_OUTPUT_TRUNCATED: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(readdirSync(out).sort()).toEqual([
      "review-evidence.md",
      "review-logic.md",
      "review-risk.md",
      "verdict.md",
      "verification.md",
    ]);
    expect(readFileSync(join(out, "verification.md"), "utf8")).toBe(verification);
    expect(readFileSync(join(out, "verdict.md"), "utf8")).toBe(`${report}\n`);
    expect(result.stdout).toContain("reseated reviewer-logic: claude-opus-5 -> claude-opus-4.7");
  });

  test("removes a prior artifact when its current lane produced no output", () => {
    const definition = workflow();
    const out = tempDir();
    for (const filename of [
      "review-logic.md",
      "review-evidence.md",
      "review-risk.md",
      "verification.md",
      "verdict.md",
    ]) {
      writeFileSync(join(out, filename), `stale ${filename}`);
    }

    const result = runSave(definition, {
      KEELSON_INPUTS_out: out,
      KEELSON_NODE_author_seat_OUTPUT: "seated\n",
      KEELSON_NODE_reviewer_logic_OUTPUT: "current logic",
      KEELSON_NODE_reviewer_evidence_OUTPUT: "current evidence",
      KEELSON_NODE_verify_OUTPUT: "current verification",
      KEELSON_NODE_synthesize_OUTPUT: JSON.stringify({
        verdict: "CONFIRMED",
        headline: "Current verdict",
        must_fix: [],
        open_questions: [],
        report: "current verdict",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "review-risk.md"))).toBe(false);
    expect(readFileSync(join(out, "review-logic.md"), "utf8")).toBe("current logic\n");
    expect(result.stdout).toContain("left review-risk.md absent: current lane produced no output");
  });

  test("leaves a failed lane absent and propagates its failure after saving successful lanes", () => {
    const definition = workflow();
    const root = tempDir();
    const out = join(root, "review output");
    const spill = join(root, "partial-risk.txt");
    writeFileSync(spill, "partial failed response");

    const result = runSave(definition, {
      KEELSON_INPUTS_out: out,
      KEELSON_NODE_reviewer_logic_OUTPUT: "logic",
      KEELSON_NODE_reviewer_evidence_OUTPUT: "evidence",
      KEELSON_NODE_reviewer_risk_OUTPUT: "partial failed response",
      KEELSON_NODE_reviewer_risk_OUTPUT_FILE: spill,
      KEELSON_NODE_reviewer_risk_STATE: "failed",
      KEELSON_NODE_verify_OUTPUT: "verification",
      KEELSON_NODE_synthesize_STATE: "skipped",
    });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(out, "review-risk.md"))).toBe(false);
    expect(readFileSync(join(out, "review-logic.md"), "utf8")).toBe("logic\n");
    expect(result.stdout).toContain("left review-risk.md absent: current lane state is failed");
    expect(result.stderr).toContain("upstream lane failure(s): reviewer-risk");
  });

  test.each([...SEATS])("truthfully reports the $id reseat", (seat) => {
    const result = runSave(workflow(), {
      KEELSON_NODE_author_seat_OUTPUT: `${seat.defaultModel}\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `reseated ${seat.id}: ${seat.defaultModel} -> ${seat.alternateModel}`,
    );
    expect(result.stdout).toContain("no out directory set; nothing written");
  });

  test("propagates an upstream failure when no out directory is configured", () => {
    const result = runSave(workflow(), {
      KEELSON_NODE_verify_STATE: "failed",
      KEELSON_NODE_verify_OUTPUT: "partial verification",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("no out directory set; nothing written");
    expect(result.stderr).toContain("upstream lane failure(s): verify");
  });

  test("writes nothing when out and author are omitted", () => {
    const cwd = tempDir();
    const env = { ...(process.env as Record<string, string>) };
    delete env.KEELSON_INPUTS_out;
    for (const key of Object.keys(env)) {
      if (key.startsWith("KEELSON_NODE_")) delete env[key];
    }
    const proc = Bun.spawnSync({
      cmd: ["bash", "-c", bashNode(workflow(), "save")],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
    expect(proc.stdout.toString()).toContain("no author model set; seating unchanged");
  });
});

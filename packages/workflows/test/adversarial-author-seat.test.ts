// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelCase, selectModelCase } from "../src/model-by.ts";
import { bundledWorkflowsDir } from "../src/seed.ts";
import { parseWorkflow } from "../src/loader.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "../src/schema/index.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;

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

shimDescribe("adversarial-review author seating", () => {
  test.each([undefined, "   "])("normalizes omitted author %p and preserves every seat", (author) => {
    const definition = workflow();
    const selector = normalizedAuthor(definition, author);

    expect(selector).toBe("seated");
    for (const expected of SEATS) {
      const seat = promptSeat(definition, expected.id);
      expect(seat.model_by_provider?.copilot).toBe(expected.defaultModel);
      expect(effectiveModel(seat, selector)).toBe(expected.defaultModel);
    }
  });

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
          ({ id, model }) =>
            model !== SEATS.find((expected) => expected.id === id)?.defaultModel,
        ),
      ).toEqual([{ id: authoredSeat.id, model: authoredSeat.alternateModel }]);
    },
  );
});

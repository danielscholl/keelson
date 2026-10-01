// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import {
  canonicalWorkflowJson,
  shortDefinitionHash,
  workflowDefinitionHash,
} from "./definition-hash.ts";
import { parseWorkflow } from "./loader.ts";

const YAML = `name: hello
description: says hi
nodes:
  - id: greet
    bash: echo hi
  - id: ask
    prompt: "Say hello  twice"
    depends_on: [greet]
`;

function parsed(content: string) {
  const result = parseWorkflow(content, "hello.yaml");
  if (result.workflow === null) throw new Error(result.error.error);
  return result.workflow;
}

describe("workflowDefinitionHash", () => {
  test("is a full sha256 hex digest and stable across calls", () => {
    const hash = workflowDefinitionHash(parsed(YAML));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowDefinitionHash(parsed(YAML))).toBe(hash);
    expect(shortDefinitionHash(hash)).toBe(hash.slice(0, 16));
  });

  test("ignores key order and dropped undefined fields", () => {
    const a = { name: "x", description: "d", nodes: [{ id: "n", bash: "true", deps: undefined }] };
    const b = { nodes: [{ bash: "true", id: "n" }], description: "d", name: "x" };
    expect(workflowDefinitionHash(a)).toBe(workflowDefinitionHash(b));
    expect(canonicalWorkflowJson(a)).toBe(canonicalWorkflowJson(b));
  });

  test("a whitespace-only change inside a prompt changes the hash", () => {
    const edited = YAML.replace("Say hello  twice", "Say hello twice");
    expect(workflowDefinitionHash(parsed(edited))).not.toBe(workflowDefinitionHash(parsed(YAML)));
  });

  test("YAML comments and indentation that parse the same hash the same", () => {
    const commented = `# a comment\n${YAML.replace("    bash: echo hi", "    bash:   echo hi")}`;
    expect(workflowDefinitionHash(parsed(commented))).toBe(workflowDefinitionHash(parsed(YAML)));
  });

  test("node order is part of the definition", () => {
    const a = { name: "x", description: "d", nodes: [{ id: "a" }, { id: "b" }] };
    const b = { name: "x", description: "d", nodes: [{ id: "b" }, { id: "a" }] };
    expect(workflowDefinitionHash(a)).not.toBe(workflowDefinitionHash(b));
  });
});

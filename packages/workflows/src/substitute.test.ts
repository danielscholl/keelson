// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { NodeOutput } from "./schema/index.ts";
import { shellQuote, substituteNodeOutputRefs, substituteWorkflowVariables } from "./substitute.ts";

function completed(output: string): NodeOutput {
  return { state: "completed", output };
}

describe("substituteWorkflowVariables", () => {
  test("replaces positional arguments", () => {
    expect(substituteWorkflowVariables("Task: $1, Priority: $2", ["Fix bug", "High"])).toBe(
      "Task: Fix bug, Priority: High",
    );
  });

  test("replaces $ARGUMENTS with all arguments", () => {
    expect(substituteWorkflowVariables("Plan: $ARGUMENTS", ["Add", "dark", "mode"])).toBe(
      "Plan: Add dark mode",
    );
  });

  test("leaves unused positional refs untouched", () => {
    expect(substituteWorkflowVariables("$1, $2, $3", ["first"])).toBe("first, $2, $3");
  });

  test("handles escaped dollar signs", () => {
    expect(substituteWorkflowVariables("Price: \\$50, Arg: $1", ["value"])).toBe(
      "Price: $50, Arg: value",
    );
  });

  test("returns unchanged text with no variables", () => {
    expect(substituteWorkflowVariables("No variables here", [])).toBe("No variables here");
  });

  test("replaces multiple occurrences of the same variable", () => {
    expect(substituteWorkflowVariables("$1 is $1", ["important"])).toBe("important is important");
  });

  test("empty arguments array leaves $1 untouched", () => {
    expect(substituteWorkflowVariables("Command: $1", [])).toBe("Command: $1");
  });

  test("combines positional and $ARGUMENTS in same text", () => {
    expect(substituteWorkflowVariables("First: $1, All: $ARGUMENTS", ["one", "two", "three"])).toBe(
      "First: one, All: one two three",
    );
  });

  test("argument values that contain $1 flow through literally", () => {
    // args.forEach iterates once per arg, so the $1 introduced by the value
    // is not re-scanned. Matches Archon's behavior.
    expect(substituteWorkflowVariables("Query: $1", ["SELECT * FROM users WHERE id=$1"])).toBe(
      "Query: SELECT * FROM users WHERE id=$1",
    );
  });

  test("handles arguments with quotes", () => {
    expect(substituteWorkflowVariables("Message: $1", ['"Hello World"'])).toBe(
      'Message: "Hello World"',
    );
  });
});

describe("substituteNodeOutputRefs", () => {
  test("replaces $nodeId.output with full output", () => {
    const outputs = new Map([["fetch", completed("hello world")]]);
    expect(substituteNodeOutputRefs("Got: $fetch.output", outputs)).toBe("Got: hello world");
  });

  test("replaces $nodeId.output.field with JSON dot access", () => {
    const json = JSON.stringify({ type: "BUG", num: 7, ok: true });
    const outputs = new Map([["classify", completed(json)]]);
    expect(substituteNodeOutputRefs("Type=$classify.output.type", outputs)).toBe("Type=BUG");
    expect(substituteNodeOutputRefs("N=$classify.output.num", outputs)).toBe("N=7");
    expect(substituteNodeOutputRefs("Ok=$classify.output.ok", outputs)).toBe("Ok=true");
  });

  test("unknown node id resolves to empty string", () => {
    expect(substituteNodeOutputRefs("Hello $missing.output!", new Map())).toBe("Hello !");
  });

  test("missing JSON field resolves to empty string", () => {
    const outputs = new Map([["n", completed(JSON.stringify({ a: 1 }))]]);
    expect(substituteNodeOutputRefs("Got=$n.output.b", outputs)).toBe("Got=");
  });

  test("non-JSON output with dot notation resolves to empty string", () => {
    const outputs = new Map([["n", completed("plain text")]]);
    expect(substituteNodeOutputRefs("Got=$n.output.field", outputs)).toBe("Got=");
  });

  test("object/null fields resolve to empty string", () => {
    const json = JSON.stringify({ a: { nested: 1 }, b: null });
    const outputs = new Map([["n", completed(json)]]);
    expect(substituteNodeOutputRefs("$n.output.a-$n.output.b", outputs)).toBe("-");
  });

  test("escapedForBash=true wraps strings in single quotes", () => {
    const outputs = new Map([["n", completed("hello world")]]);
    expect(substituteNodeOutputRefs("echo $n.output", outputs, true)).toBe("echo 'hello world'");
  });

  test("escapedForBash=true escapes embedded single quotes", () => {
    const outputs = new Map([["n", completed("it's fine")]]);
    expect(substituteNodeOutputRefs("echo $n.output", outputs, true)).toBe("echo 'it'\\''s fine'");
  });

  test("escapedForBash=true emits unquoted numbers and booleans", () => {
    const outputs = new Map([["n", completed(JSON.stringify({ count: 5, ok: true }))]]);
    expect(substituteNodeOutputRefs("c=$n.output.count o=$n.output.ok", outputs, true)).toBe(
      "c=5 o=true",
    );
  });

  test("escapedForBash=true unknown node emits empty quoted string", () => {
    expect(substituteNodeOutputRefs("echo $missing.output", new Map(), true)).toBe("echo ''");
  });

  test("multiple substitutions in one prompt", () => {
    const outputs = new Map([
      ["a", completed("alpha")],
      ["b", completed("beta")],
    ]);
    expect(substituteNodeOutputRefs("$a.output + $b.output = mix", outputs)).toBe(
      "alpha + beta = mix",
    );
  });
});

describe("shellQuote", () => {
  test("wraps simple values in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  test("escapes embedded single quotes via close-escape-reopen", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("preserves shell metacharacters as literals (they're inside single quotes)", () => {
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("a; b && c")).toBe("'a; b && c'");
  });

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

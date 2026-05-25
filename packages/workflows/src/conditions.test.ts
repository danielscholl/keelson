// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { evaluateCondition } from "./conditions.ts";
import type { NodeOutput } from "./schema/index.ts";

function makeOutput(
  output: string,
  state: "completed" | "failed" | "skipped" = "completed",
): NodeOutput {
  if (state === "failed") return { state, output, error: "error" };
  return { state, output };
}

describe("evaluateCondition — equality operators", () => {
  test("== returns true when output matches", () => {
    const outputs = new Map([["classify", makeOutput("BUG")]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(true);
  });

  test("== returns false when output does not match", () => {
    const outputs = new Map([["classify", makeOutput("FEATURE")]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });

  test("!= returns true when output differs", () => {
    const outputs = new Map([["classify", makeOutput("FEATURE")]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(true);
  });

  test("!= returns false when output equals the value", () => {
    const outputs = new Map([["classify", makeOutput("BUG")]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(false);
  });

  test("supports spaces around operator", () => {
    const outputs = new Map([["n", makeOutput("FOO")]]);
    expect(evaluateCondition("$n.output=='FOO'", outputs).result).toBe(true);
    expect(evaluateCondition("$n.output == 'FOO'", outputs).result).toBe(true);
  });

  test("empty expected value matches empty output", () => {
    const outputs = new Map([["n", makeOutput("")]]);
    expect(evaluateCondition("$n.output == ''", outputs).result).toBe(true);
  });
});

describe("evaluateCondition — dot-notation JSON access", () => {
  test("accesses JSON field for output_format nodes", () => {
    const json = JSON.stringify({ type: "BUG", confidence: 0.9 });
    const outputs = new Map([["classify", makeOutput(json)]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.type == 'FEATURE'", outputs).result).toBe(false);
  });

  test("returns false on invalid JSON (fail-soft)", () => {
    const outputs = new Map([["classify", makeOutput("not-json")]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(false);
  });

  test("!= operator with dot notation", () => {
    const json = JSON.stringify({ type: "FEATURE" });
    const outputs = new Map([["classify", makeOutput(json)]]);
    expect(evaluateCondition("$classify.output.type != 'BUG'", outputs).result).toBe(true);
  });

  test("coerces number field to string", () => {
    const outputs = new Map([["n", makeOutput(JSON.stringify({ confidence: 0.9 }))]]);
    expect(evaluateCondition("$n.output.confidence == '0.9'", outputs).result).toBe(true);
  });

  test("coerces boolean field to string", () => {
    const outputs = new Map([["n", makeOutput(JSON.stringify({ valid: true }))]]);
    expect(evaluateCondition("$n.output.valid == 'true'", outputs).result).toBe(true);
  });

  test("works with clean structured output (output_format pattern)", () => {
    const json = JSON.stringify({ run_code_review: "true", run_tests: "false" });
    const outputs = new Map([["classify", makeOutput(json)]]);
    expect(evaluateCondition("$classify.output.run_code_review == 'true'", outputs).result).toBe(
      true,
    );
    expect(evaluateCondition("$classify.output.run_tests == 'true'", outputs).result).toBe(false);
    expect(evaluateCondition("$classify.output.run_tests == 'false'", outputs).result).toBe(true);
  });
});

describe("evaluateCondition — missing / failed nodes", () => {
  test("unknown node treats output as empty string", () => {
    const outputs = new Map<string, NodeOutput>();
    expect(evaluateCondition("$missing.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$missing.output == 'BUG'", outputs).result).toBe(false);
  });

  test("failed node: output is empty, conditions evaluate accordingly", () => {
    const outputs = new Map([["classify", makeOutput("", "failed")]]);
    expect(evaluateCondition("$classify.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });
});

describe("evaluateCondition — parse failures (fail-closed)", () => {
  test("invalid expression: result false, parsed false", () => {
    const res = evaluateCondition("not a valid condition", new Map());
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  test("valid expression returns parsed: true", () => {
    const outputs = new Map([["n", makeOutput("FOO")]]);
    expect(evaluateCondition("$n.output == 'FOO'", outputs).parsed).toBe(true);
  });
});

describe("evaluateCondition — numeric operators", () => {
  test("> returns true when actual is numerically greater", () => {
    expect(evaluateCondition("$n.output > '5'", new Map([["n", makeOutput("10")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output > '5'", new Map([["n", makeOutput("5")]])).result).toBe(
      false,
    );
    expect(evaluateCondition("$n.output > '5'", new Map([["n", makeOutput("3")]])).result).toBe(
      false,
    );
  });

  test(">= returns true when actual is greater than or equal", () => {
    expect(evaluateCondition("$n.output >= '5'", new Map([["n", makeOutput("5")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output >= '5'", new Map([["n", makeOutput("6")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output >= '5'", new Map([["n", makeOutput("4")]])).result).toBe(
      false,
    );
  });

  test("< returns true when actual is numerically less", () => {
    expect(evaluateCondition("$n.output < '5'", new Map([["n", makeOutput("3")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output < '5'", new Map([["n", makeOutput("5")]])).result).toBe(
      false,
    );
  });

  test("<= returns true when actual is less than or equal", () => {
    expect(evaluateCondition("$n.output <= '5'", new Map([["n", makeOutput("5")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output <= '5'", new Map([["n", makeOutput("4")]])).result).toBe(
      true,
    );
    expect(evaluateCondition("$n.output <= '5'", new Map([["n", makeOutput("6")]])).result).toBe(
      false,
    );
  });

  test("works with floating-point values", () => {
    expect(
      evaluateCondition("$n.output >= '0.9'", new Map([["n", makeOutput("0.95")]])).result,
    ).toBe(true);
    expect(
      evaluateCondition("$n.output >= '0.9'", new Map([["n", makeOutput("0.85")]])).result,
    ).toBe(false);
  });

  test("works with dot-notation JSON fields", () => {
    const outputs = new Map([["n", makeOutput(JSON.stringify({ score: 0.95 }))]]);
    expect(evaluateCondition("$n.output.score >= '0.9'", outputs).result).toBe(true);
  });

  test("fail-closed when actual is not numeric", () => {
    const res = evaluateCondition("$n.output > '5'", new Map([["n", makeOutput("hello")]]));
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  test("fail-closed when expected is not numeric", () => {
    const res = evaluateCondition("$n.output > 'abc'", new Map([["n", makeOutput("10")]]));
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });
});

describe("evaluateCondition — compound expressions", () => {
  test("&&: true when both conditions are true", () => {
    const outputs = new Map([
      ["a", makeOutput("X")],
      ["b", makeOutput("Y")],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(true);
  });

  test("&&: false when first is false", () => {
    const outputs = new Map([
      ["a", makeOutput("Z")],
      ["b", makeOutput("Y")],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(false);
  });

  test("&&: false when second is false", () => {
    const outputs = new Map([
      ["a", makeOutput("X")],
      ["b", makeOutput("Z")],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(false);
  });

  test("||: true when first is true", () => {
    const outputs = new Map([
      ["a", makeOutput("X")],
      ["b", makeOutput("Z")],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(true);
  });

  test("||: true when second is true", () => {
    const outputs = new Map([
      ["a", makeOutput("Z")],
      ["b", makeOutput("Y")],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(true);
  });

  test("||: false when both are false", () => {
    const outputs = new Map([
      ["a", makeOutput("Z")],
      ["b", makeOutput("W")],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(false);
  });

  test("&& binds tighter than ||: (A && B) || C", () => {
    const yesOutputs = new Map([
      ["a", makeOutput("Z")],
      ["b", makeOutput("Y")],
      ["c", makeOutput("V")],
    ]);
    expect(
      evaluateCondition("$a.output == 'X' && $b.output == 'Y' || $c.output == 'V'", yesOutputs)
        .result,
    ).toBe(true);
    const noOutputs = new Map([
      ["a", makeOutput("X")],
      ["b", makeOutput("Z")],
      ["c", makeOutput("W")],
    ]);
    expect(
      evaluateCondition("$a.output == 'X' && $b.output == 'Y' || $c.output == 'V'", noOutputs)
        .result,
    ).toBe(false);
  });

  test("compound with numeric operator", () => {
    const outputs = new Map([
      ["score", makeOutput("90")],
      ["flag", makeOutput("true")],
    ]);
    expect(
      evaluateCondition("$score.output > '80' && $flag.output == 'true'", outputs).result,
    ).toBe(true);
    expect(
      evaluateCondition("$score.output > '80' && $flag.output == 'false'", outputs).result,
    ).toBe(false);
  });

  test("compound: fail-closed when any atom is invalid", () => {
    const outputs = new Map([
      ["a", makeOutput("X")],
      ["b", makeOutput("Y")],
    ]);
    const res = evaluateCondition("$a.output == 'X' && not-valid", outputs);
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  test("|| short-circuits on true first clause — invalid second clause not evaluated", () => {
    const outputs = new Map([["a", makeOutput("X")]]);
    const res = evaluateCondition("$a.output == 'X' || not-valid", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true);
  });
});

describe("evaluateCondition — quote handling", () => {
  test("value containing && is not split on the operator", () => {
    const outputs = new Map([["n", makeOutput("A&&B")]]);
    const res = evaluateCondition("$n.output == 'A&&B'", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true);
  });

  test("value containing || is not split on the operator", () => {
    const outputs = new Map([["n", makeOutput("A||B")]]);
    const res = evaluateCondition("$n.output == 'A||B'", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true);
  });
});

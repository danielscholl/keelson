import { describe, expect, test } from "bun:test";
import {
  filterSlashCommands,
  isCommittedToCommand,
  matchSlashCommand,
  parseWorkflowCommand,
  SLASH_COMMANDS,
} from "../src/lib/slashCommands.ts";

describe("matchSlashCommand", () => {
  test("returns the registered command for bare name", () => {
    const cmd = matchSlashCommand("/project");
    expect(cmd?.name).toBe("project");
  });

  test("matches the workflow command", () => {
    expect(matchSlashCommand("/workflow")?.name).toBe("workflow");
    expect(matchSlashCommand("/workflow run smoke-test")?.name).toBe("workflow");
  });

  test("returns the registered command for name + args", () => {
    const cmd = matchSlashCommand("/project use _default");
    expect(cmd?.name).toBe("project");
  });

  test("returns null for input without leading slash", () => {
    expect(matchSlashCommand("project")).toBeNull();
  });

  test("returns null for unknown command", () => {
    expect(matchSlashCommand("/unknown")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(matchSlashCommand("")).toBeNull();
    expect(matchSlashCommand("/")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  test("empty input returns all registered commands", () => {
    expect(filterSlashCommands("")).toEqual([...SLASH_COMMANDS]);
    expect(filterSlashCommands("/")).toEqual([...SLASH_COMMANDS]);
  });

  test("substring match is case-insensitive", () => {
    expect(filterSlashCommands("/pro").map((c) => c.name)).toEqual(["project"]);
    expect(filterSlashCommands("/PRO").map((c) => c.name)).toEqual(["project"]);
    expect(filterSlashCommands("/work").map((c) => c.name)).toEqual(["workflow"]);
  });

  test("no match returns empty array", () => {
    expect(filterSlashCommands("/xyz")).toEqual([]);
  });

  test("only the head token is used for filtering", () => {
    expect(filterSlashCommands("/project use _default").map((c) => c.name)).toEqual(["project"]);
  });
});

describe("isCommittedToCommand", () => {
  test("true once a registered command is followed by whitespace", () => {
    expect(isCommittedToCommand("/project ")).toBe(true);
    expect(isCommittedToCommand("/project use foo")).toBe(true);
    expect(isCommittedToCommand("/workflow run smoke-test")).toBe(true);
  });

  test("false while still typing the command name", () => {
    expect(isCommittedToCommand("/project")).toBe(false);
    expect(isCommittedToCommand("/pro")).toBe(false);
    expect(isCommittedToCommand("/")).toBe(false);
  });

  test("false for unknown commands", () => {
    expect(isCommittedToCommand("/xyz ")).toBe(false);
  });

  test("false for plain text", () => {
    expect(isCommittedToCommand("project ")).toBe(false);
    expect(isCommittedToCommand("")).toBe(false);
  });
});

describe("parseWorkflowCommand", () => {
  test("empty or 'list' resolves to the list action", () => {
    expect(parseWorkflowCommand("")).toEqual({ kind: "list" });
    expect(parseWorkflowCommand("   ")).toEqual({ kind: "list" });
    expect(parseWorkflowCommand("list")).toEqual({ kind: "list" });
  });

  test("run with a bare name carries empty args", () => {
    expect(parseWorkflowCommand("run smoke-test")).toEqual({
      kind: "run",
      name: "smoke-test",
      args: "",
    });
  });

  test("run preserves free-form arguments verbatim, including '#' and spaces", () => {
    // Regression: arguments past the name must reach $ARGUMENTS intact rather
    // than being split into key=value tokens and silently dropped.
    expect(parseWorkflowCommand("run fix-issue fix #123")).toEqual({
      kind: "run",
      name: "fix-issue",
      args: "fix #123",
    });
    expect(parseWorkflowCommand("run memory had a great idea about caching")).toEqual({
      kind: "run",
      name: "memory",
      args: "had a great idea about caching",
    });
  });

  test("run keeps interior whitespace in arguments", () => {
    expect(parseWorkflowCommand("run fix-issue  a   b ")).toEqual({
      kind: "run",
      name: "fix-issue",
      args: "a   b",
    });
  });

  test("run without a name, or an unknown sub-action, is a usage error", () => {
    expect(parseWorkflowCommand("run")).toEqual({ kind: "usage" });
    expect(parseWorkflowCommand("run   ")).toEqual({ kind: "usage" });
    expect(parseWorkflowCommand("bogus")).toEqual({ kind: "usage" });
  });
});

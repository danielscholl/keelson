import { describe, expect, test } from "bun:test";
import type { CommandRef } from "@keelson/shared";
import {
  filterSlashCommands,
  filterWorkflowNames,
  isCommittedToCommand,
  matchRibArgContext,
  matchSlashCommand,
  parseWorkflowCommand,
  ribCommandToSlash,
  SLASH_COMMANDS,
  workflowRunNamePartial,
} from "../src/lib/slashCommands.ts";

// A completing rib command (chamber's /mind) and a free-arg one (/genesis),
// mirroring what GET /api/commands contributes.
const MIND: CommandRef = {
  ribId: "chamber",
  name: "mind",
  description: "Open a mind as a seeded chat",
  argument: { hint: "<slug>", completes: true },
};
const GENESIS: CommandRef = {
  ribId: "chamber",
  name: "genesis",
  description: "Forge a new mind",
  argument: { hint: "<brief>" },
};
const MERGED = [...SLASH_COMMANDS, ribCommandToSlash(MIND), ribCommandToSlash(GENESIS)];

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

describe("workflowRunNamePartial", () => {
  test("returns the partial once typing the name (incl. empty right after 'run ')", () => {
    expect(workflowRunNamePartial("/workflow run ")).toBe("");
    expect(workflowRunNamePartial("/workflow run smo")).toBe("smo");
    expect(workflowRunNamePartial("/workflow run smoke-test")).toBe("smoke-test");
  });

  test("returns null before 'run ' or once the name token is complete", () => {
    // No trailing space after run → not yet typing the name.
    expect(workflowRunNamePartial("/workflow run")).toBeNull();
    // Trailing space after the name → past the name, into $ARGUMENTS.
    expect(workflowRunNamePartial("/workflow run smoke-test ")).toBeNull();
    expect(workflowRunNamePartial("/workflow ")).toBeNull();
    expect(workflowRunNamePartial("/project use foo")).toBeNull();
  });
});

describe("filterWorkflowNames", () => {
  const items = [
    { name: "smoke-test" },
    { name: "fix-issue" },
    { name: "pr-review" },
    { name: "plan-act-evaluate" },
  ];

  test("empty partial returns all (capped)", () => {
    expect(filterWorkflowNames(items, "").map((i) => i.name)).toEqual([
      "smoke-test",
      "fix-issue",
      "pr-review",
      "plan-act-evaluate",
    ]);
  });

  test("matches on normalized alphanumerics (ignores hyphens, case)", () => {
    expect(filterWorkflowNames(items, "smo").map((i) => i.name)).toEqual(["smoke-test"]);
    expect(filterWorkflowNames(items, "SMOKET").map((i) => i.name)).toEqual(["smoke-test"]);
    expect(filterWorkflowNames(items, "review").map((i) => i.name)).toEqual(["pr-review"]);
  });

  test("respects the limit", () => {
    expect(filterWorkflowNames(items, "", 2)).toHaveLength(2);
  });

  test("no match returns empty", () => {
    expect(filterWorkflowNames(items, "deploy")).toEqual([]);
  });

  test("excludes names with whitespace the slash command can't represent", () => {
    const withSpace = [{ name: "smoke-test" }, { name: "my flow" }];
    expect(filterWorkflowNames(withSpace, "").map((i) => i.name)).toEqual(["smoke-test"]);
  });
});

describe("ribCommandToSlash", () => {
  test("maps a descriptor into a rib-family slash command", () => {
    expect(ribCommandToSlash(MIND)).toEqual({
      name: "mind",
      family: "rib",
      description: "Open a mind as a seeded chat",
      usage: "<slug>",
      ribId: "chamber",
      argument: { hint: "<slug>", completes: true },
    });
  });

  test("a bare command (no argument) gets a placeholder usage and no argument", () => {
    const cmd = ribCommandToSlash({ ribId: "demo", name: "ping", description: "Ping" });
    expect(cmd.usage).toBe("(no args)");
    expect(cmd.argument).toBeUndefined();
  });
});

describe("slash command resolution against a merged command list", () => {
  test("matchSlashCommand resolves rib and base commands", () => {
    expect(matchSlashCommand("/mind smoke", MERGED)?.family).toBe("rib");
    expect(matchSlashCommand("/genesis a brief", MERGED)?.name).toBe("genesis");
    expect(matchSlashCommand("/workflow", MERGED)?.name).toBe("workflow");
  });

  test("filterSlashCommands includes rib commands", () => {
    expect(filterSlashCommands("/m", MERGED).map((c) => c.name)).toEqual(["mind"]);
  });

  test("isCommittedToCommand recognizes committed rib commands", () => {
    expect(isCommittedToCommand("/mind ", MERGED)).toBe(true);
    expect(isCommittedToCommand("/genesis a brief", MERGED)).toBe(true);
    // Default base list doesn't know rib commands.
    expect(isCommittedToCommand("/mind ")).toBe(false);
  });
});

describe("matchRibArgContext", () => {
  test("returns the command + partial for a completing rib arg", () => {
    expect(matchRibArgContext("/mind ", MERGED)).toEqual({
      command: ribCommandToSlash(MIND),
      partial: "",
    });
    expect(matchRibArgContext("/mind smo", MERGED)?.partial).toBe("smo");
  });

  test("null once the arg token is complete (trailing space)", () => {
    expect(matchRibArgContext("/mind smoke ", MERGED)).toBeNull();
  });

  test("null for a rib command whose argument doesn't complete", () => {
    expect(matchRibArgContext("/genesis bri", MERGED)).toBeNull();
  });

  test("null for base commands and unknown names", () => {
    expect(matchRibArgContext("/workflow run x", MERGED)).toBeNull();
    expect(matchRibArgContext("/nope x", MERGED)).toBeNull();
  });
});

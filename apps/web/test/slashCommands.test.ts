import { describe, expect, test } from "bun:test";
import {
  filterSlashCommands,
  isCommittedToCommand,
  matchSlashCommand,
  SLASH_COMMANDS,
} from "../src/lib/slashCommands.ts";

describe("matchSlashCommand", () => {
  test("returns the registered command for bare name", () => {
    const cmd = matchSlashCommand("/project");
    expect(cmd?.name).toBe("project");
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

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/commands/connect.ts";
import { runConnect, runDisconnect } from "../src/commands/connect.ts";
import {
  applyJsonMcp,
  applyTomlMcp,
  DEFAULT_MCP_URL,
  removeJsonMcp,
  removeTomlMcp,
  SKILL_CONTENT,
} from "../src/connect/targets.ts";

describe("connect target transforms", () => {
  test("applyJsonMcp adds keelson and preserves a sibling server", () => {
    const seed = '{"mcpServers":{"other":{"type":"http","url":"u"}}}';
    const { text, alreadyPresent } = applyJsonMcp(seed, "http://x/api/mcp");
    const obj = JSON.parse(text);
    expect(obj.mcpServers.other).toBeDefined();
    expect(obj.mcpServers.keelson).toEqual({ type: "http", url: "http://x/api/mcp" });
    expect(alreadyPresent).toBe(false);
  });

  test("applyJsonMcp on null creates a fresh config; re-apply reports alreadyPresent", () => {
    const fresh = applyJsonMcp(null, "u").text;
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { keelson: { type: "http", url: "u" } } });
    expect(applyJsonMcp(fresh, "u2").alreadyPresent).toBe(true);
  });

  test("applyJsonMcp throws on a non-object config rather than clobbering it", () => {
    expect(() => applyJsonMcp("[]", "u")).toThrow();
  });

  test("removeJsonMcp deletes keelson, keeps siblings, and flags non-empty", () => {
    const seeded = applyJsonMcp('{"mcpServers":{"other":{"type":"http","url":"u"}}}', "u").text;
    const { text, hadEntry, empty } = removeJsonMcp(seeded);
    const obj = JSON.parse(text);
    expect(hadEntry).toBe(true);
    expect(obj.mcpServers.keelson).toBeUndefined();
    expect(obj.mcpServers.other).toBeDefined();
    expect(empty).toBe(false);
  });

  test("removeJsonMcp on a keelson-only config reports empty (deletion candidate)", () => {
    expect(removeJsonMcp(applyJsonMcp(null, "u").text).empty).toBe(true);
  });

  test("applyTomlMcp appends the table, preserving prior content and comments", () => {
    const prior = '# my codex config\nmodel = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const { text, alreadyPresent } = applyTomlMcp(prior);
    expect(alreadyPresent).toBe(false);
    expect(text).toContain("# my codex config");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain("[mcp_servers.keelson]");
    expect(text).toContain('command = "keelson"');
  });

  test("applyTomlMcp is idempotent when keelson is already present", () => {
    const once = applyTomlMcp(null).text;
    const twice = applyTomlMcp(once);
    expect(twice.alreadyPresent).toBe(true);
    expect(twice.text).toBe(once);
  });

  test("removeTomlMcp removes only the keelson table", () => {
    const seeded = applyTomlMcp('model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n').text;
    const { text, hadEntry, empty } = removeTomlMcp(seeded);
    expect(hadEntry).toBe(true);
    expect(empty).toBe(false);
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("[mcp_servers.keelson]");
    expect(text).toContain('model = "gpt"');
  });

  test("removeTomlMcp on a keelson-only file reports empty", () => {
    expect(removeTomlMcp(applyTomlMcp(null).text).empty).toBe(true);
  });

  test("the skill is rib-agnostic: teaches discovery, names no capability", () => {
    expect(SKILL_CONTENT).toContain("keelson_docs");
    expect(SKILL_CONTENT).toContain("workflow_run");
    expect(SKILL_CONTENT.toLowerCase()).not.toContain("osdu");
  });
});

describe("connect / disconnect (filesystem)", () => {
  let base: string;
  let repo: string;
  let osHome: string;
  let home: string;
  let commands: Array<{ command: string; args: string[] }>;

  const fakeRun = (command: string, args: string[]): CommandResult => {
    commands.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "keelson-connect-"));
    repo = join(base, "repo");
    osHome = join(base, "os");
    home = join(base, "home");
    commands = [];
    for (const d of [repo, osHome, home]) mkdirSync(d, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const connectOpts = (extra: Record<string, unknown> = {}) => ({
    json: true,
    cwd: repo,
    home,
    osHome,
    runCommand: fakeRun,
    ...extra,
  });
  const disconnectOpts = (extra: Record<string, unknown> = {}) => ({
    json: true,
    cwd: repo,
    home,
    runCommand: fakeRun,
    ...extra,
  });

  // Global-scope skill roots: copilot + codex share `.agents/skills`, claude has
  // its own `.claude/skills`, all under the OS home (not the repo).
  const agentsSkill = () => join(osHome, ".agents", "skills", "keelson", "SKILL.md");
  const claudeSkill = () => join(osHome, ".claude", "skills", "keelson", "SKILL.md");

  test("connect all (global) wires each target to its real root and drops the right skills", () => {
    runConnect(["all"], connectOpts());
    // Claude MCP goes through its own CLI at user scope, not a file.
    const add = commands.find((c) => c.command === "claude" && c.args[1] === "add");
    expect(add?.args).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "keelson",
      DEFAULT_MCP_URL,
    ]);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
    // Copilot + codex: user-level dedicated config files.
    expect(
      JSON.parse(readFileSync(join(osHome, ".copilot", "mcp-config.json"), "utf8")).mcpServers
        .keelson,
    ).toBeDefined();
    expect(readFileSync(join(osHome, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.keelson]",
    );
    // Skills land in each agent's real global root — never the repo.
    expect(existsSync(agentsSkill())).toBe(true);
    expect(existsSync(claudeSkill())).toBe(true);
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(join(home, "connections.json"))).toBe(true);
  });

  test("--local writes repo-scoped files: claude .mcp.json (no CLI), skill in .claude/skills", () => {
    runConnect(["claude"], connectOpts({ local: true }));
    expect(
      JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.keelson,
    ).toBeDefined();
    expect(commands.some((c) => c.command === "claude")).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "keelson", "SKILL.md"))).toBe(true);
    expect(existsSync(claudeSkill())).toBe(false);
  });

  test("copilot + codex share one reference-counted global skill; claude keeps its own", () => {
    runConnect(["all"], connectOpts());
    runDisconnect(["copilot"], disconnectOpts());
    expect(existsSync(agentsSkill())).toBe(true); // codex still wants it
    runDisconnect(["codex"], disconnectOpts());
    expect(existsSync(agentsSkill())).toBe(false);
    expect(existsSync(claudeSkill())).toBe(true); // claude's is independent
    runDisconnect(["claude"], disconnectOpts());
    expect(existsSync(claudeSkill())).toBe(false);
  });

  test("disconnect all removes what connect created, reverses claude via CLI, clears the receipt", () => {
    runConnect(["all"], connectOpts());
    commands = [];
    runDisconnect(["all"], disconnectOpts());
    expect(commands).toContainEqual({
      command: "claude",
      args: ["mcp", "remove", "--scope", "user", "keelson"],
    });
    expect(existsSync(join(osHome, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(osHome, ".copilot", "mcp-config.json"))).toBe(false);
    expect(existsSync(join(osHome, ".agents"))).toBe(false);
    expect(existsSync(join(osHome, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  test("undo preserves a pre-existing sibling and never deletes a file connect didn't create", () => {
    const copilotCfg = join(osHome, ".copilot", "mcp-config.json");
    mkdirSync(join(osHome, ".copilot"), { recursive: true });
    writeFileSync(
      copilotCfg,
      JSON.stringify({ mcpServers: { other: { type: "http", url: "u" } } }),
    );
    runConnect(["copilot"], connectOpts());
    runDisconnect(["copilot"], disconnectOpts());
    const obj = JSON.parse(readFileSync(copilotCfg, "utf8"));
    expect(obj.mcpServers.other).toBeDefined();
    expect(obj.mcpServers.keelson).toBeUndefined();
    expect(existsSync(copilotCfg)).toBe(true);
  });

  test("--no-skill wires the MCP connection only", () => {
    runConnect(["copilot"], connectOpts({ skill: false }));
    expect(existsSync(join(osHome, ".copilot", "mcp-config.json"))).toBe(true);
    expect(existsSync(join(osHome, ".agents"))).toBe(false);
  });

  test("connect is idempotent — a second run leaves a single keelson entry", () => {
    runConnect(["copilot"], connectOpts());
    runConnect(["copilot"], connectOpts());
    const servers = JSON.parse(
      readFileSync(join(osHome, ".copilot", "mcp-config.json"), "utf8"),
    ).mcpServers;
    expect(Object.keys(servers)).toEqual(["keelson"]);
  });

  test("connect creates the keelson home if it does not exist yet", () => {
    const freshHome = join(base, "does-not-exist", "nested");
    runConnect(["copilot"], connectOpts({ home: freshHome }));
    expect(existsSync(join(freshHome, "connections.json"))).toBe(true);
  });

  test("a corrupt receipt degrades to an empty ledger; disconnect does not throw", () => {
    // Malformed skill (requestedBy is not an array): a naive cast would crash
    // reverseSkillsFor on `.filter` during disconnect.
    writeFileSync(
      join(home, "connections.json"),
      JSON.stringify({
        version: 2,
        targets: {
          claude: {
            target: "claude",
            mcp: {
              kind: "file",
              file: join(repo, ".mcp.json"),
              format: "json",
              createdFile: false,
            },
            connectedAt: "x",
          },
        },
        skills: {
          "/x/SKILL.md": {
            file: "/x/SKILL.md",
            createdFile: true,
            createdDirs: "oops",
            requestedBy: "nope",
          },
        },
      }),
    );
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { keelson: { type: "http", url: "u" }, other: {} } }),
    );
    expect(() => runDisconnect(["claude"], disconnectOpts())).not.toThrow();
    // The valid target was still honored: keelson removed, sibling kept.
    const servers = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers;
    expect(servers.keelson).toBeUndefined();
    expect(servers.other).toBeDefined();
  });

  test("a v1 receipt migrates so an old connect can still be undone", () => {
    // v1 shape: file-only targets + a single shared skill.
    const legacySkill = join(osHome, ".agents", "skills", "keelson", "SKILL.md");
    mkdirSync(join(osHome, ".agents", "skills", "keelson"), { recursive: true });
    writeFileSync(legacySkill, SKILL_CONTENT);
    const codexCfg = join(osHome, ".codex", "config.toml");
    mkdirSync(join(osHome, ".codex"), { recursive: true });
    writeFileSync(codexCfg, applyTomlMcp(null).text);
    writeFileSync(
      join(home, "connections.json"),
      JSON.stringify({
        version: 1,
        targets: {
          codex: {
            target: "codex",
            file: codexCfg,
            format: "toml",
            createdFile: true,
            connectedAt: "x",
          },
        },
        skill: { file: legacySkill, createdFile: true, createdDirs: [], requestedBy: ["codex"] },
      }),
    );
    runDisconnect(["codex"], disconnectOpts());
    expect(existsSync(codexCfg)).toBe(false);
    expect(existsSync(legacySkill)).toBe(false);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  test("disconnect removes only the skill dirs connect created, keeping a pre-existing ancestor", () => {
    // The operator already owns `.agents`; connect must create (and later remove)
    // only `skills`/`keelson` beneath it, never the ancestor it didn't make.
    mkdirSync(join(osHome, ".agents"), { recursive: true });
    runConnect(["copilot"], connectOpts());
    runDisconnect(["copilot"], disconnectOpts());
    expect(existsSync(join(osHome, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(osHome, ".agents"))).toBe(true);
  });
});

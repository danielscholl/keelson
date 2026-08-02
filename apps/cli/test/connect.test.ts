// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/commands/connect.ts";
import { disconnectAll, runConnect, runDisconnect } from "../src/commands/connect.ts";
import { loadConnections, readConnections } from "../src/connect/receipt.ts";
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

  // A rewriting caller must refuse this rather than save a filtered copy over it:
  // the malformed skill's own record would be the thing deleted, while the file
  // it names stays on disk. The read-only degrade is what still tolerates one.
  test("a receipt with malformed entries is refused, and neither it nor the agent config is touched", () => {
    const receipt = join(home, "connections.json");
    // Malformed skill (requestedBy is not an array): a naive cast would crash
    // reverseSkillsFor on `.filter`.
    const body = JSON.stringify({
      version: 2,
      targets: {
        claude: {
          target: "claude",
          mcp: { kind: "file", file: join(repo, ".mcp.json"), format: "json", createdFile: false },
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
    });
    writeFileSync(receipt, body);
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { keelson: { type: "http", url: "u" }, other: {} } }),
    );

    expect(readConnections(home).ok).toBe(false);
    expect(disconnectAll(home, fakeRun).receiptUnreadable).toBeDefined();
    expect(readFileSync(receipt, "utf8")).toBe(body);
    // The valid target was NOT reversed — acting on half a ledger is what this
    // refuses to do.
    expect(
      JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.keelson,
    ).toBeDefined();

    // loadConnections keeps its never-throws degrade for read-only callers.
    const degraded = loadConnections(home);
    expect(degraded.targets).toEqual({});
    expect(degraded.skills).toEqual({});
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

  test("disconnectAll reverses every recorded target without naming one", () => {
    runConnect(["all"], connectOpts());
    commands = [];
    const outcome = disconnectAll(home, fakeRun);
    expect(outcome.removed.sort()).toEqual(["claude", "codex", "copilot"]);
    expect(outcome.failed).toEqual([]);
    expect(commands).toContainEqual({
      command: "claude",
      args: ["mcp", "remove", "--scope", "user", "keelson"],
    });
    expect(existsSync(join(osHome, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(osHome, ".agents"))).toBe(false);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  // Dropping the record on a refused removal would leave the agent pointing at
  // keelson with no ledger left to undo it from.
  test("an agent CLI that refuses the removal is reported, and its record survives", () => {
    runConnect(["claude"], connectOpts());
    const outcome = disconnectAll(home, () => ({ code: 1, stdout: "", stderr: "no such command" }));
    expect(outcome.removed).toEqual([]);
    expect(outcome.failed).toEqual(["claude"]);
    // The record is what a retry needs, so it stays.
    expect(loadConnections(home).targets.claude).toBeDefined();
    // The skill is already gone: idempotent cleanup runs before the agent's
    // non-idempotent `mcp remove`, so a retry reaches that removal instead of
    // being turned away by a "not found" from a step that already succeeded.
    expect(existsSync(claudeSkill())).toBe(false);
  });

  test("a refused CLI removal is still reversible on a later attempt", () => {
    runConnect(["claude"], connectOpts());
    expect(disconnectAll(home, () => ({ code: 1, stdout: "", stderr: "gone" })).failed).toEqual([
      "claude",
    ]);

    // With the agent's CLI working again the retry completes, rather than being
    // turned away by an earlier step it cannot re-run.
    const retry = disconnectAll(home, fakeRun);
    expect(retry.removed).toEqual(["claude"]);
    expect(retry.failed).toEqual([]);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  // loadConnections keys targets by whatever the file says, so an unknown id
  // would otherwise steer reversal at the paths recorded beside it.
  test("a receipt naming an unknown target is ignored, not reversed", () => {
    const stray = join(base, "not-ours.json");
    writeFileSync(stray, JSON.stringify({ mcpServers: { keelson: {} } }));
    writeFileSync(
      join(home, "connections.json"),
      JSON.stringify({
        version: 2,
        targets: {
          rogue: {
            target: "rogue",
            mcp: { kind: "file", file: stray, format: "json", createdFile: true },
            connectedAt: "",
          },
        },
        skills: {},
      }),
    );
    const outcome = disconnectAll(home, fakeRun);
    // Pins WHICH path this takes: the record is well-formed enough to be read
    // (isTargetRecord validates the value, not the key), so it is ignored by the
    // TARGET_IDS loop rather than refused as an unreadable receipt.
    expect(outcome.receiptUnreadable).toBeUndefined();
    expect(outcome.removed).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(existsSync(stray)).toBe(true);
    // Ignored, not discarded: the entry survives the rewrite.
    expect(loadConnections(home).targets).toHaveProperty("rogue");
  });

  test("a known target beside an unknown one is still reversed, and the unknown one kept", () => {
    runConnect(["copilot"], connectOpts());
    const data = loadConnections(home);
    const stray = join(base, "not-ours.json");
    writeFileSync(stray, JSON.stringify({ mcpServers: { keelson: {} } }));
    (data.targets as Record<string, unknown>).rogue = {
      target: "rogue",
      mcp: { kind: "file", file: stray, format: "json", createdFile: true },
      connectedAt: "",
    };
    writeFileSync(join(home, "connections.json"), JSON.stringify(data));

    const outcome = disconnectAll(home, fakeRun);
    expect(outcome.receiptUnreadable).toBeUndefined();
    expect(outcome.removed).toEqual(["copilot"]);
    expect(existsSync(stray)).toBe(true);
    expect(loadConnections(home).targets).toHaveProperty("rogue");
  });

  // An empty-ledger degrade here would rewrite the receipt away (saveConnections
  // deletes an empty one) and report a clean sweep while every agent stays wired.
  test("an unparseable receipt reverses nothing and is left on disk", () => {
    runConnect(["copilot"], connectOpts());
    const receipt = join(home, "connections.json");
    writeFileSync(receipt, "{ not json");

    const outcome = disconnectAll(home, fakeRun);
    expect(outcome.receiptUnreadable).toBeDefined();
    expect(outcome.removed).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(readFileSync(receipt, "utf8")).toBe("{ not json");
    // Nothing was touched on the strength of a ledger we could not read.
    expect(existsSync(join(osHome, ".copilot", "mcp-config.json"))).toBe(true);
    expect(existsSync(agentsSkill())).toBe(true);
  });

  // Every shape the structural guards would otherwise read as "empty ledger".
  // saveConnections deletes an empty ledger's receipt, so each of these would
  // destroy the only record of the wiring while leaving the wiring in place.
  const REFUSED_RECEIPTS: Array<[string, unknown]> = [
    ["unsupported version", { version: 99, targets: {} }],
    ["targets is not an object", { version: 2, targets: "bad", skills: {} }],
    ["skills is not an object", { version: 2, targets: {}, skills: "bad" }],
    ["a malformed target entry", { version: 2, targets: { claude: { nope: true } }, skills: {} }],
    [
      "a malformed skill entry",
      { version: 2, targets: {}, skills: { "/x": { file: "/x", createdFile: "no" } } },
    ],
    [
      "a target whose key and `target` disagree",
      {
        version: 2,
        targets: {
          claude: {
            target: "copilot",
            mcp: { kind: "file", file: "/x", format: "json", createdFile: false },
            connectedAt: "",
          },
        },
        skills: {},
      },
    ],
    ["a missing skills container", { version: 2, targets: {} }],
    ["a missing targets container", { version: 2, skills: {} }],
    ["v1 targets is not an object", { version: 1, targets: 42 }],
    ["a malformed v1 skill record", { version: 1, targets: {}, skill: { file: 7 } }],
  ];

  for (const [label, body] of REFUSED_RECEIPTS) {
    test(`a receipt with ${label} is refused and left on disk`, () => {
      const receipt = join(home, "connections.json");
      const text = JSON.stringify(body);
      writeFileSync(receipt, text);

      expect(readConnections(home).ok).toBe(false);
      expect(disconnectAll(home, fakeRun).receiptUnreadable).toBeDefined();
      expect(readFileSync(receipt, "utf8")).toBe(text);
    });
  }

  // The counterpart: a genuinely empty ledger IS safe to clear, so the guards
  // above must not make the normal "last agent disconnected" path fail.
  test("a legitimately empty receipt still reads as empty", () => {
    writeFileSync(
      join(home, "connections.json"),
      JSON.stringify({ version: 2, targets: {}, skills: {} }),
    );
    const read = readConnections(home);
    expect(read.ok).toBe(true);
    expect(disconnectAll(home, fakeRun).receiptUnreadable).toBeUndefined();
  });

  // Skill cleanup runs after the MCP reversal, so an unlink that fails there must
  // fail the target too rather than escaping the guard.
  test("a skill file that cannot be unlinked fails its target and stays retryable", () => {
    runConnect(["copilot"], connectOpts());
    // rmSync's `force` only suppresses ENOENT; a non-empty dir in the file's
    // place throws without `recursive`.
    rmSync(agentsSkill(), { force: true });
    mkdirSync(agentsSkill(), { recursive: true });
    writeFileSync(join(agentsSkill(), "held.txt"), "x");

    const outcome = disconnectAll(home, fakeRun);
    expect(outcome.failed).toEqual(["copilot"]);
    expect(outcome.removed).toEqual([]);
    const after = loadConnections(home);
    expect(after.targets.copilot).toBeDefined();
    // The claim survives, so a retry still reaches the skill.
    expect(after.skills[agentsSkill()]?.requestedBy).toEqual(["copilot"]);
  });

  // One agent's hand-broken config must not abort the others, nor an uninstall
  // that has already revoked credentials.
  test("an unreadable agent config fails just that target and leaves it retryable", () => {
    runConnect(["copilot", "codex"], connectOpts());
    writeFileSync(join(osHome, ".copilot", "mcp-config.json"), "{ not json");

    const outcome = disconnectAll(home, fakeRun);
    expect(outcome.failed).toEqual(["copilot"]);
    expect(outcome.removed).toEqual(["codex"]);
    // The broken target is still recorded, so a retry is possible...
    expect(loadConnections(home).targets.copilot).toBeDefined();
    // ...and the healthy one really was reversed.
    expect(existsSync(join(osHome, ".codex", "config.toml"))).toBe(false);
  });
});

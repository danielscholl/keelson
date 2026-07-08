// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConnect, runDisconnect } from "../src/commands/connect.ts";
import {
  applyJsonMcp,
  applyTomlMcp,
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

  test("the shared skill is rib-agnostic: teaches discovery, names no capability", () => {
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

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "keelson-connect-"));
    repo = join(base, "repo");
    osHome = join(base, "os");
    home = join(base, "home");
    for (const d of [repo, osHome, home]) mkdirSync(d, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const connectOpts = () => ({ json: true, cwd: repo, home, osHome });
  const disconnectOpts = () => ({ json: true, cwd: repo, home });

  test("connect all writes each target's config, the shared skill, and a receipt", () => {
    runConnect(["all"], connectOpts());
    expect(
      JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.keelson,
    ).toBeDefined();
    expect(existsSync(join(osHome, ".copilot", "mcp-config.json"))).toBe(true);
    expect(readFileSync(join(osHome, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.keelson]",
    );
    expect(existsSync(join(repo, ".agents", "skills", "keelson", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "connections.json"))).toBe(true);
  });

  test("undo preserves a pre-existing sibling and never deletes a file connect didn't create", () => {
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "http", url: "u" } } }),
    );
    runConnect(["claude"], connectOpts());
    runDisconnect(["claude"], disconnectOpts());
    const obj = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    expect(obj.mcpServers.other).toBeDefined();
    expect(obj.mcpServers.keelson).toBeUndefined();
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
  });

  test("disconnect all removes only what connect created and clears the receipt", () => {
    runConnect(["all"], connectOpts());
    runDisconnect(["all"], disconnectOpts());
    expect(existsSync(join(osHome, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(osHome, ".copilot", "mcp-config.json"))).toBe(false);
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  test("the shared skill survives until the last target that wants it disconnects", () => {
    runConnect(["all"], connectOpts());
    const skill = join(repo, ".agents", "skills", "keelson", "SKILL.md");
    runDisconnect(["claude"], disconnectOpts());
    expect(existsSync(skill)).toBe(true);
    runDisconnect(["copilot"], disconnectOpts());
    expect(existsSync(skill)).toBe(true);
    runDisconnect(["codex"], disconnectOpts());
    expect(existsSync(skill)).toBe(false);
  });

  test("--no-skill wires the MCP connection only", () => {
    runConnect(["claude"], { ...connectOpts(), skill: false });
    expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
    expect(existsSync(join(repo, ".agents"))).toBe(false);
  });

  test("connect is idempotent — a second run leaves a single keelson entry", () => {
    runConnect(["claude"], connectOpts());
    runConnect(["claude"], connectOpts());
    const servers = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["keelson"]);
  });

  test("connect creates the keelson home if it does not exist yet", () => {
    const freshHome = join(base, "does-not-exist", "nested");
    runConnect(["claude"], { json: true, cwd: repo, home: freshHome, osHome });
    expect(existsSync(join(freshHome, "connections.json"))).toBe(true);
  });

  test("a corrupt receipt degrades to an empty ledger; disconnect does not throw", () => {
    // Malformed skill (requestedBy is not an array): a naive cast would crash
    // reverseSkillFor on `.filter` during disconnect.
    writeFileSync(
      join(home, "connections.json"),
      JSON.stringify({
        version: 1,
        targets: {
          claude: {
            target: "claude",
            file: join(repo, ".mcp.json"),
            format: "json",
            createdFile: false,
            connectedAt: "x",
          },
        },
        skill: { file: "/x/SKILL.md", createdFile: true, createdDirs: "oops", requestedBy: "nope" },
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
});

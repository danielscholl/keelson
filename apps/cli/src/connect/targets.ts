// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The external coding agents `keelson connect` can wire to the local MCP
// endpoint, and the pure content transforms that add/remove keelson's entry in
// each one's config. Every transform is surgical — it touches only keelson's own
// `keelson` server entry (and the shared skill), never a sibling server or the
// rest of the user's file — so the reverse (`keelson disconnect`) can undo
// exactly what connect wrote and nothing else.

import { join } from "node:path";

export const TARGET_IDS = ["claude", "copilot", "codex"] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export function isTargetId(value: string): value is TargetId {
  return (TARGET_IDS as readonly string[]).includes(value);
}

// Default local endpoint; overridable per-invocation for a non-default port.
export const DEFAULT_MCP_URL = "http://127.0.0.1:7878/api/mcp";

export type TargetFormat = "json" | "toml";

// `global` writes to the operator's machine (OS home): the connection follows
// them into every repo. `local` writes committable, repo-scoped files. Default
// is global — connect is machine setup, not a per-repo artifact.
export type Scope = "global" | "local";

// A target whose MCP config is a dedicated file we edit surgically.
export interface TargetMcpFile {
  kind: "file";
  file: string;
  format: TargetFormat;
}
// A target we wire through the agent's own CLI. Claude's user scope lives inside
// `~/.claude.json` — its whole state file (OAuth, session, caches) — which we
// must not hand-edit, so we drive `claude mcp add/remove` instead.
export interface TargetMcpCli {
  kind: "cli";
  command: string;
  addArgs: string[];
  removeArgs: string[];
}
export type TargetMcp = TargetMcpFile | TargetMcpCli;

export interface TargetSpec {
  id: TargetId;
  label: string;
  // How this agent reaches keelson. HTTP targets point at the endpoint directly;
  // Codex runs the `keelson mcp` stdio bridge, which self-resolves the server URL
  // and token on each launch (restart-proof).
  transport: "http" | "stdio-bridge";
  // Path segments, under the scope root, of the skills dir this agent discovers.
  // The keelson skill lands at `<root>/<...segments>/keelson/SKILL.md`. Copilot
  // and codex both read `.agents/skills`, so they share one file; Claude reads
  // only `.claude/skills`.
  skillSegments: readonly string[];
  resolveMcp(scope: Scope, cwd: string, osHome: string, url: string): TargetMcp;
}

const AGENTS_SKILLS = [".agents", "skills"] as const;
const CLAUDE_SKILLS = [".claude", "skills"] as const;

export const TARGETS: Record<TargetId, TargetSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    transport: "http",
    skillSegments: CLAUDE_SKILLS,
    resolveMcp: (scope, cwd, _osHome, url) =>
      scope === "local"
        ? { kind: "file", file: join(cwd, ".mcp.json"), format: "json" }
        : {
            kind: "cli",
            command: "claude",
            addArgs: ["mcp", "add", "--scope", "user", "--transport", "http", "keelson", url],
            removeArgs: ["mcp", "remove", "--scope", "user", "keelson"],
          },
  },
  copilot: {
    id: "copilot",
    label: "Copilot CLI",
    transport: "http",
    skillSegments: AGENTS_SKILLS,
    // Copilot has no project-scoped MCP config (github/copilot-cli#2528), so MCP
    // is always the user-level file regardless of scope; `--local` relocates only
    // the skill.
    resolveMcp: (_scope, _cwd, osHome) => ({
      kind: "file",
      file: join(osHome, ".copilot", "mcp-config.json"),
      format: "json",
    }),
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    transport: "stdio-bridge",
    skillSegments: AGENTS_SKILLS,
    resolveMcp: (_scope, _cwd, osHome) => ({
      kind: "file",
      file: join(osHome, ".codex", "config.toml"),
      format: "toml",
    }),
  },
};

export const SKILL_FILENAME = "SKILL.md";

// The `keelson/` skill dir for a target+scope. Its parent (the agent's skills
// root) is what varies; the leaf is always `keelson/SKILL.md`.
export function skillDir(spec: TargetSpec, scope: Scope, cwd: string, osHome: string): string {
  return join(scope === "global" ? osHome : cwd, ...spec.skillSegments, "keelson");
}

export function skillFilePath(spec: TargetSpec, scope: Scope, cwd: string, osHome: string): string {
  return join(skillDir(spec, scope, cwd, osHome), SKILL_FILENAME);
}

// The ancestor skill-dir cleanup must never climb past: the scope root the
// segments hang off. Removal stops here so we never delete the operator's home
// or repo, only the `.agents`/`.claude` tree we created beneath it.
export function skillStopAt(scope: Scope, cwd: string, osHome: string): string {
  return scope === "global" ? osHome : cwd;
}

export const SKILL_CONTENT = `---
name: keelson
description: Orchestrate durable, repeatable work through Keelson (a local agent workbench reached over MCP) instead of doing everything inline. Use when the user asks to run or automate a repeatable task, when a job is long-running or worth reviewing, or when you need to know how Keelson behaves or what it can do.
license: Apache-2.0
---

You are connected to Keelson, a local agent workbench, over MCP. Treat it as your durable substrate: prefer routing repeatable, long-running, or review-worthy work through it rather than doing everything turn by turn.

- **Read \`keelson_docs\` before guessing** how Keelson behaves or what it offers. With no arguments it lists documentation sources (including any installed rib); the \`keelson-agent\` source is the orchestration playbook — start there. These docs are the contract; the user usually cannot see Keelson's source.
- **Run automations** with \`workflow_list\` to discover them and \`workflow_run\` to start one. If a run pauses for approval, relay its plan to the user and continue with \`workflow_respond\`; inspect progress with \`workflow_status\`. Never invent a workflow name — only names from \`workflow_list\` are real.
- **Capabilities are discovered, not fixed.** Installed ribs add their own tools and docs to this connection automatically. If something seems missing, re-check the tool list and \`keelson_docs\` rather than assuming.

Your available tools are whatever this connection advertises; do not assume one you cannot see.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- JSON targets (Claude, Copilot) -----------------------------------------

// Set mcpServers.keelson in a JSON config, preserving every other key. `null`
// existing text means the file does not exist yet.
export function applyJsonMcp(
  existingText: string | null,
  url: string,
): { text: string; alreadyPresent: boolean } {
  let root: Record<string, unknown> = {};
  if (existingText && existingText.trim().length > 0) {
    const parsed = JSON.parse(existingText);
    if (!isRecord(parsed)) throw new Error("existing config is not a JSON object");
    root = parsed;
  }
  const servers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  const alreadyPresent = "keelson" in servers;
  servers.keelson = { type: "http", url };
  root.mcpServers = servers;
  return { text: `${JSON.stringify(root, null, 2)}\n`, alreadyPresent };
}

// Remove mcpServers.keelson, leaving all other servers and top-level keys
// intact. `empty` reports whether nothing keelson-unrelated remains, so the
// caller can delete a file it created rather than leave an empty husk.
export function removeJsonMcp(existingText: string): {
  text: string;
  hadEntry: boolean;
  empty: boolean;
} {
  const parsed = JSON.parse(existingText);
  if (!isRecord(parsed)) return { text: existingText, hadEntry: false, empty: false };
  const servers = isRecord(parsed.mcpServers) ? { ...parsed.mcpServers } : undefined;
  const hadEntry = servers ? "keelson" in servers : false;
  if (servers) {
    delete servers.keelson;
    if (Object.keys(servers).length === 0) delete parsed.mcpServers;
    else parsed.mcpServers = servers;
  }
  const empty = Object.keys(parsed).length === 0;
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, hadEntry, empty };
}

// --- TOML target (Codex) ----------------------------------------------------

const CODEX_BLOCK = '[mcp_servers.keelson]\ncommand = "keelson"\nargs = ["mcp"]\n';

// Append the [mcp_servers.keelson] table to a Codex config as text — never a
// parse→serialize round-trip, which would strip the user's comments and reflow
// their file. Detection uses Bun.TOML.parse, falling back to a header scan.
export function applyTomlMcp(existingText: string | null): {
  text: string;
  alreadyPresent: boolean;
} {
  const base = existingText ?? "";
  let alreadyPresent = false;
  try {
    const parsed = Bun.TOML.parse(base) as Record<string, unknown>;
    const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
    alreadyPresent = servers ? "keelson" in servers : false;
  } catch {
    alreadyPresent = /^\s*\[mcp_servers\.keelson\]/m.test(base);
  }
  if (alreadyPresent) return { text: base, alreadyPresent: true };
  const sep =
    base.length === 0 ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${base}${sep}${CODEX_BLOCK}`, alreadyPresent: false };
}

// Remove the [mcp_servers.keelson] table (and any of its subtables) by text
// scan — from its header line to the next table header or EOF. Leaves every
// other table untouched.
export function removeTomlMcp(existingText: string): {
  text: string;
  hadEntry: boolean;
  empty: boolean;
} {
  const out: string[] = [];
  let removing = false;
  let hadEntry = false;
  for (const line of existingText.split("\n")) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      const table = header[1]?.trim() ?? "";
      const isOurs = table === "mcp_servers.keelson" || table.startsWith("mcp_servers.keelson.");
      if (isOurs) {
        removing = true;
        hadEntry = true;
        continue;
      }
      removing = false;
    }
    if (!removing) out.push(line);
  }
  let text = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  const empty = text.trim().length === 0;
  if (!empty && !text.endsWith("\n")) text += "\n";
  return { text: empty ? "" : text, hadEntry, empty };
}

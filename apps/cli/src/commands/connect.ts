// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// `keelson connect` / `keelson disconnect`: wire (or unwire) an external coding
// agent to the local MCP endpoint and drop a shared, portable agent skill. Every
// write is recorded in the connect receipt so a disconnect reverses exactly what
// connect wrote — never a sibling MCP server or a file the operator owned.

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type ConnectionsData, loadConnections, saveConnections } from "../connect/receipt.ts";
import {
  applyJsonMcp,
  applyTomlMcp,
  DEFAULT_MCP_URL,
  isTargetId,
  removeJsonMcp,
  removeTomlMcp,
  resolveSkillPath,
  SKILL_CONTENT,
  TARGET_IDS,
  TARGETS,
  type TargetId,
} from "../connect/targets.ts";
import { EXIT_BAD_ARGS } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";

export interface ConnectOptions {
  json: boolean;
  url?: string;
  // Skip the shared SKILL.md drop (MCP wiring only). Default: drop it.
  skill?: boolean;
  // Injected in tests; default to the real cwd/homes. `home` is the keelson home
  // (where the receipt lives); `osHome` is the OS home (where an agent's own
  // config dir lives, e.g. ~/.codex) — deliberately distinct.
  cwd?: string;
  home?: string;
  osHome?: string;
}

export interface DisconnectOptions {
  json: boolean;
  cwd?: string;
  home?: string;
}

// Resolve the operator's target list, expanding "all" and rejecting an unknown
// name with a stable bad-args exit rather than silently connecting nothing.
export function resolveTargets(raw: readonly string[], json: boolean): TargetId[] {
  const requested = raw.length === 0 ? [] : raw.flatMap((t) => t.split(",")).map((t) => t.trim());
  if (requested.length === 0) {
    emit(
      {
        error: `name at least one agent to connect: ${TARGET_IDS.join(", ")} (or 'all')`,
        code: "BAD_INPUTS",
      },
      { json },
    );
    process.exit(EXIT_BAD_ARGS);
  }
  if (requested.includes("all")) return [...TARGET_IDS];
  const out: TargetId[] = [];
  for (const t of requested) {
    if (!isTargetId(t)) {
      emit(
        {
          error: `unknown agent '${t}'; expected ${TARGET_IDS.join(", ")} (or 'all')`,
          code: "BAD_INPUTS",
        },
        { json },
      );
      process.exit(EXIT_BAD_ARGS);
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// mkdir the file's parent (the agent's own config dir, e.g. ~/.codex) and write.
// The parent is the agent's, not ours, so it is never tracked for removal.
function writeConfigFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// The chain of dirs that did not exist under a skill path, deepest-first, so a
// last disconnect removes exactly what connect introduced (and only if empty).
function createMissingDirs(dir: string): string[] {
  const created: string[] = [];
  let d = dir;
  while (!existsSync(d)) {
    created.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  mkdirSync(dir, { recursive: true });
  return created;
}

function removeDirIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY / ENOENT — leave a dir that still holds the operator's files.
  }
}

export function runConnect(rawTargets: readonly string[], opts: ConnectOptions): void {
  const targets = resolveTargets(rawTargets, opts.json);
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? resolveKeelsonHome();
  const osHome = opts.osHome ?? homedir();
  const url = opts.url ?? DEFAULT_MCP_URL;
  const dropSkill = opts.skill !== false;
  const now = new Date().toISOString();
  const data = loadConnections(home);

  const connected: Array<Record<string, unknown>> = [];
  for (const id of targets) {
    const spec = TARGETS[id];
    const file = spec.resolvePath(cwd, osHome);
    const existed = existsSync(file);
    const existing = existed ? readFileSync(file, "utf8") : null;
    let result: string;
    if (spec.format === "json") {
      const { text, alreadyPresent } = applyJsonMcp(existing, url);
      writeConfigFile(file, text);
      result = alreadyPresent ? "updated" : "added";
    } else {
      const { text, alreadyPresent } = applyTomlMcp(existing);
      writeConfigFile(file, text);
      result = alreadyPresent ? "already-present" : "added";
    }
    const prior = data.targets[id];
    data.targets[id] = {
      target: id,
      file,
      format: spec.format,
      // Keep the original createdFile across idempotent re-connects.
      createdFile: prior?.createdFile ?? !existed,
      connectedAt: now,
    };
    connected.push({ target: id, label: spec.label, transport: spec.transport, file, result });
  }

  let skillPath: string | undefined;
  if (dropSkill) {
    skillPath = resolveSkillPath(cwd);
    const skillDir = dirname(skillPath);
    const fileExisted = existsSync(skillPath);
    const prior = data.skill;
    const createdDirs =
      prior?.createdDirs ?? (existsSync(skillDir) ? [] : createMissingDirs(skillDir));
    if (existsSync(skillDir) === false) mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, SKILL_CONTENT);
    const requestedBy = new Set<TargetId>(prior?.requestedBy ?? []);
    for (const id of targets) requestedBy.add(id);
    data.skill = {
      file: skillPath,
      createdFile: prior?.createdFile ?? !fileExisted,
      createdDirs,
      requestedBy: [...requestedBy],
    };
  }

  saveConnections(home, data);
  emit(
    {
      data: {
        connected,
        ...(skillPath ? { skill: skillPath } : {}),
        url,
        hint: "restart the agent (or open a new session) so it picks up the connection",
      },
    },
    { json: opts.json },
  );
}

export function runDisconnect(rawTargets: readonly string[], opts: DisconnectOptions): void {
  const targets = resolveTargets(rawTargets, opts.json);
  const home = opts.home ?? resolveKeelsonHome();
  const data = loadConnections(home);

  const results: Array<Record<string, unknown>> = [];
  for (const id of targets) {
    const rec = data.targets[id];
    if (!rec) {
      results.push({ target: id, result: "not-connected" });
      continue;
    }
    reverseTargetConfig(rec.file, rec.format, rec.createdFile);
    delete data.targets[id];
    reverseSkillFor(data, id);
    results.push({ target: id, result: "disconnected", file: rec.file });
  }

  saveConnections(home, data);
  emit({ data: { disconnected: results } }, { json: opts.json });
}

function reverseTargetConfig(file: string, format: "json" | "toml", createdFile: boolean): void {
  if (!existsSync(file)) return;
  const existing = readFileSync(file, "utf8");
  const { text, empty } = format === "json" ? removeJsonMcp(existing) : removeTomlMcp(existing);
  if (empty && createdFile) rmSync(file, { force: true });
  else writeFileSync(file, text);
}

// Drop a target's claim on the shared skill; remove the skill (and dirs connect
// created for it) only once no connected target still wants it.
function reverseSkillFor(data: ConnectionsData, id: TargetId): void {
  const skill = data.skill;
  if (!skill) return;
  skill.requestedBy = skill.requestedBy.filter((t) => t !== id);
  if (skill.requestedBy.length > 0) return;
  if (skill.createdFile && existsSync(skill.file)) rmSync(skill.file, { force: true });
  for (const dir of skill.createdDirs) removeDirIfEmpty(dir);
  data.skill = undefined;
}

export function runConnectStatus(opts: { json: boolean; home?: string }): void {
  const home = opts.home ?? resolveKeelsonHome();
  const data = loadConnections(home);
  const connections = Object.values(data.targets)
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({ target: r.target, file: r.file, connectedAt: r.connectedAt }));
  emit(
    {
      data: {
        connections,
        ...(data.skill ? { skill: data.skill.file } : {}),
        ...(connections.length === 0
          ? { note: "no agents connected; run `keelson connect <agent>`" }
          : {}),
      },
    },
    { json: opts.json },
  );
}

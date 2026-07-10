// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// `keelson connect` / `keelson disconnect`: wire (or unwire) an external coding
// agent to the local MCP endpoint and drop a portable agent skill. Writes are
// machine-global by default (the connection follows the operator into every
// repo); `--local` writes committable, repo-scoped files instead. Every write is
// recorded in the connect receipt so a disconnect reverses exactly what connect
// did — never a sibling MCP server or a file the operator owned.

import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
  type Scope,
  SKILL_CONTENT,
  skillFilePath,
  skillStopAt,
  TARGET_IDS,
  TARGETS,
  type TargetId,
} from "../connect/targets.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";

// Result of running an agent's own CLI (Claude's `claude mcp add/remove`).
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: string, args: string[]) => CommandResult;

// Default runner. A missing binary surfaces as a non-zero result, not a throw,
// so a connect for one target failing is reported, not fatal to the process.
function defaultRunCommand(command: string, args: string[]): CommandResult {
  try {
    const res = Bun.spawnSync({
      cmd: [command, ...args],
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export interface ConnectOptions {
  json: boolean;
  url?: string;
  // Skip the SKILL.md drop (MCP wiring only). Default: drop it.
  skill?: boolean;
  // Write repo-scoped files instead of machine-global ones. Default: global.
  local?: boolean;
  // Injected in tests; default to the real cwd/homes. `home` is the keelson home
  // (where the receipt lives); `osHome` is the OS home (where an agent's own
  // config dir lives, e.g. ~/.codex) — deliberately distinct.
  cwd?: string;
  home?: string;
  osHome?: string;
  // Injected in tests so Claude's `claude mcp` calls don't touch the real
  // ~/.claude.json.
  runCommand?: CommandRunner;
}

export interface DisconnectOptions {
  json: boolean;
  cwd?: string;
  home?: string;
  runCommand?: CommandRunner;
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

// Read a file, or null when it does not exist — the race-free replacement for
// existsSync-then-readFileSync, so there is no check-then-act (TOCTOU) window.
function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Create the skill dir tree below `stopAt` (an existing ancestor, e.g. cwd or the
// OS home) and report the chain of dirs it newly made, deepest-first, so a last
// disconnect removes exactly what connect introduced. Each level is created
// top-down with a non-recursive mkdir: a successful create means the dir is new,
// EEXIST means it was already there. mkdir is itself the atomic check, so there
// is no check-then-act (TOCTOU) window and no reliance on a platform-specific
// recursive-mkdir return value.
function ensureSkillDir(dir: string, stopAt: string): string[] {
  const levels: string[] = [];
  let d = dir;
  while (d !== stopAt) {
    levels.unshift(d);
    const parent = dirname(d);
    if (parent === d) break; // reached the fs root without hitting stopAt
    d = parent;
  }
  const created: string[] = [];
  for (const level of levels) {
    try {
      mkdirSync(level);
      created.push(level);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return created.reverse(); // deepest-first, for removal order
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
  const scope: Scope = opts.local ? "local" : "global";
  const run = opts.runCommand ?? defaultRunCommand;
  const now = new Date().toISOString();
  const data = loadConnections(home);

  const connected: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  const succeeded: TargetId[] = [];
  for (const id of targets) {
    const spec = TARGETS[id];
    const mcp = spec.resolveMcp(scope, cwd, osHome, url);
    try {
      if (mcp.kind === "file") {
        const existing = readIfExists(mcp.file);
        const existed = existing !== null;
        let result: string;
        if (mcp.format === "json") {
          const { text, alreadyPresent } = applyJsonMcp(existing, url);
          writeConfigFile(mcp.file, text);
          result = alreadyPresent ? "updated" : "added";
        } else {
          const { text, alreadyPresent } = applyTomlMcp(existing);
          writeConfigFile(mcp.file, text);
          result = alreadyPresent ? "already-present" : "added";
        }
        const prior = data.targets[id];
        const createdFile = prior?.mcp.kind === "file" ? prior.mcp.createdFile : !existed;
        data.targets[id] = {
          target: id,
          mcp: { kind: "file", file: mcp.file, format: mcp.format, createdFile },
          connectedAt: now,
        };
        connected.push({
          target: id,
          label: spec.label,
          transport: spec.transport,
          file: mcp.file,
          result,
        });
      } else {
        // Idempotent: clear any prior keelson entry, then add, so a re-connect
        // leaves a single clean registration whether or not `add` rejects dupes.
        run(mcp.command, mcp.removeArgs);
        const res = run(mcp.command, mcp.addArgs);
        if (res.code !== 0) {
          const detail = res.stderr.trim();
          throw new Error(
            detail.length > 0
              ? detail
              : `\`${mcp.command} ${mcp.addArgs.join(" ")}\` exited ${res.code}`,
          );
        }
        data.targets[id] = {
          target: id,
          mcp: { kind: "cli", command: mcp.command, removeArgs: mcp.removeArgs },
          connectedAt: now,
        };
        connected.push({
          target: id,
          label: spec.label,
          transport: spec.transport,
          via: `${mcp.command} mcp`,
          result: "added",
        });
      }
      succeeded.push(id);
    } catch (err) {
      failed.push({ target: id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const skills: string[] = [];
  if (dropSkill && succeeded.length > 0) {
    // Group by the skill file path so copilot + codex (both `.agents/skills`)
    // share one reference-counted file rather than clobbering each other.
    const byFile = new Map<string, TargetId[]>();
    for (const id of succeeded) {
      const file = skillFilePath(TARGETS[id], scope, cwd, osHome);
      byFile.set(file, [...(byFile.get(file) ?? []), id]);
    }
    const stopAt = skillStopAt(scope, cwd, osHome);
    for (const [file, ids] of byFile) {
      const dir = dirname(file);
      const prior = data.skills[file];
      const createdDirs = prior?.createdDirs ?? ensureSkillDir(dir, stopAt);
      if (prior) mkdirSync(dir, { recursive: true });
      // Detect first-creation atomically with an exclusive write (no check-then-
      // act): `wx` throws EEXIST when the file is already there, meaning connect
      // did not create it and undo must not delete it. A prior record knows.
      let createdFile: boolean;
      if (prior) {
        createdFile = prior.createdFile;
        writeFileSync(file, SKILL_CONTENT);
      } else {
        try {
          writeFileSync(file, SKILL_CONTENT, { flag: "wx" });
          createdFile = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          writeFileSync(file, SKILL_CONTENT);
          createdFile = false;
        }
      }
      const requestedBy = new Set<TargetId>(prior?.requestedBy ?? []);
      for (const id of ids) requestedBy.add(id);
      data.skills[file] = { file, createdFile, createdDirs, requestedBy: [...requestedBy] };
      skills.push(file);
    }
  }

  saveConnections(home, data);
  emit(
    {
      data: {
        connected,
        ...(skills.length > 0 ? { skills } : {}),
        ...(failed.length > 0 ? { failed } : {}),
        scope,
        url,
        hint: "restart the agent (or open a new session) so it picks up the connection",
      },
    },
    { json: opts.json },
  );
  if (failed.length > 0) process.exit(EXIT_FAIL);
}

export function runDisconnect(rawTargets: readonly string[], opts: DisconnectOptions): void {
  const targets = resolveTargets(rawTargets, opts.json);
  const home = opts.home ?? resolveKeelsonHome();
  const run = opts.runCommand ?? defaultRunCommand;
  const data = loadConnections(home);

  const results: Array<Record<string, unknown>> = [];
  for (const id of targets) {
    const rec = data.targets[id];
    if (!rec) {
      results.push({ target: id, result: "not-connected" });
      continue;
    }
    if (rec.mcp.kind === "file") {
      reverseTargetConfig(rec.mcp.file, rec.mcp.format, rec.mcp.createdFile);
      results.push({ target: id, result: "disconnected", file: rec.mcp.file });
    } else {
      run(rec.mcp.command, rec.mcp.removeArgs);
      results.push({ target: id, result: "disconnected", via: `${rec.mcp.command} mcp` });
    }
    delete data.targets[id];
    reverseSkillsFor(data, id);
  }

  saveConnections(home, data);
  emit({ data: { disconnected: results } }, { json: opts.json });
}

function reverseTargetConfig(file: string, format: "json" | "toml", createdFile: boolean): void {
  const existing = readIfExists(file);
  if (existing === null) return;
  const { text, empty } = format === "json" ? removeJsonMcp(existing) : removeTomlMcp(existing);
  if (empty && createdFile) rmSync(file, { force: true });
  else writeFileSync(file, text);
}

// Drop a target's claim on every skill it requested; remove a skill (and the
// dirs connect created for it) only once no connected target still wants it.
function reverseSkillsFor(data: ConnectionsData, id: TargetId): void {
  for (const [path, skill] of Object.entries(data.skills)) {
    if (!skill.requestedBy.includes(id)) continue;
    skill.requestedBy = skill.requestedBy.filter((t) => t !== id);
    if (skill.requestedBy.length > 0) continue;
    if (skill.createdFile) rmSync(skill.file, { force: true });
    for (const dir of skill.createdDirs) removeDirIfEmpty(dir);
    delete data.skills[path];
  }
}

export function runConnectStatus(opts: { json: boolean; home?: string }): void {
  const home = opts.home ?? resolveKeelsonHome();
  const data = loadConnections(home);
  const connections = Object.values(data.targets)
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({
      target: r.target,
      ...(r.mcp.kind === "file" ? { file: r.mcp.file } : { via: `${r.mcp.command} mcp` }),
      connectedAt: r.connectedAt,
    }));
  const skills = Object.keys(data.skills);
  emit(
    {
      data: {
        connections,
        ...(skills.length > 0 ? { skills } : {}),
        ...(connections.length === 0
          ? { note: "no agents connected; run `keelson connect <agent>`" }
          : {}),
      },
    },
    { json: opts.json },
  );
}

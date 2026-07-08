// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The connect receipt: a record under the keelson home of exactly what
// `keelson connect` wrote (or ran) for each external agent, so `keelson
// disconnect` reverses precisely that and never a file or key the operator
// owned. Honesty over cleverness — undo trusts this ledger, not a re-derivation.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetFormat, TargetId } from "./targets.ts";

export const CONNECTIONS_FILE = "connections.json";

// How a target's MCP wiring is reversed. `file` records the config file we
// edited surgically (and whether we created it, the only deletion candidate);
// `cli` records the exact command to undo it (Claude's `claude mcp remove`).
export type McpRecord =
  | { kind: "file"; file: string; format: TargetFormat; createdFile: boolean }
  | { kind: "cli"; command: string; removeArgs: string[] };

// One external agent keelson wired to the MCP endpoint.
export interface TargetRecord {
  target: TargetId;
  mcp: McpRecord;
  connectedAt: string;
}

// A dropped SKILL.md, reference-counted across the targets that share its path
// (copilot and codex both read `.agents/skills`), so disconnecting one leaves it
// while another still wants it.
export interface SkillRecord {
  file: string;
  createdFile: boolean;
  // Dirs connect created to place the skill, deepest-first, removed on the last
  // disconnect only if still empty.
  createdDirs: string[];
  // Targets that requested this skill; undo removes the file only when this
  // empties.
  requestedBy: TargetId[];
}

export interface ConnectionsData {
  version: 2;
  targets: Partial<Record<TargetId, TargetRecord>>;
  // Keyed by absolute skill-file path so one shared file (copilot + codex) is
  // tracked once, and a global and a `--local` drop of the same agent stay
  // distinct records.
  skills: Record<string, SkillRecord>;
}

export function connectionsPath(home: string): string {
  return join(home, CONNECTIONS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function empty(): ConnectionsData {
  return { version: 2, targets: {}, skills: {} };
}

// Structural guards so a hand-edited or corrupted receipt degrades to an empty
// ledger instead of crashing a later reverse (e.g. `skill.requestedBy.filter`),
// upholding the never-throws contract loadConnections documents.
function isMcpRecord(v: unknown): v is McpRecord {
  if (!isRecord(v)) return false;
  if (v.kind === "file") {
    return (
      typeof v.file === "string" &&
      (v.format === "json" || v.format === "toml") &&
      typeof v.createdFile === "boolean"
    );
  }
  if (v.kind === "cli") {
    return (
      typeof v.command === "string" &&
      Array.isArray(v.removeArgs) &&
      v.removeArgs.every((a) => typeof a === "string")
    );
  }
  return false;
}

function isTargetRecord(v: unknown): v is TargetRecord {
  return isRecord(v) && typeof v.target === "string" && isMcpRecord(v.mcp);
}

function isSkillRecord(v: unknown): v is SkillRecord {
  return (
    isRecord(v) &&
    typeof v.file === "string" &&
    typeof v.createdFile === "boolean" &&
    Array.isArray(v.createdDirs) &&
    v.createdDirs.every((d) => typeof d === "string") &&
    Array.isArray(v.requestedBy) &&
    v.requestedBy.every((t) => typeof t === "string")
  );
}

function parseTargets(raw: unknown): ConnectionsData["targets"] {
  const targets: ConnectionsData["targets"] = {};
  if (isRecord(raw)) {
    for (const [id, rec] of Object.entries(raw)) {
      if (isTargetRecord(rec)) targets[id as TargetId] = rec;
    }
  }
  return targets;
}

function parseSkills(raw: unknown): ConnectionsData["skills"] {
  const skills: ConnectionsData["skills"] = {};
  if (isRecord(raw)) {
    for (const [path, rec] of Object.entries(raw)) {
      if (isSkillRecord(rec)) skills[path] = rec;
    }
  }
  return skills;
}

// v1 stored file-only targets and a single shared skill. Lift them into the v2
// shape so an operator who connected under the old CLI can still auto-disconnect.
function migrateV1(parsed: Record<string, unknown>): ConnectionsData {
  const out = empty();
  if (isRecord(parsed.targets)) {
    for (const [id, rec] of Object.entries(parsed.targets)) {
      if (
        isRecord(rec) &&
        typeof rec.target === "string" &&
        typeof rec.file === "string" &&
        (rec.format === "json" || rec.format === "toml") &&
        typeof rec.createdFile === "boolean"
      ) {
        out.targets[id as TargetId] = {
          target: rec.target as TargetId,
          mcp: { kind: "file", file: rec.file, format: rec.format, createdFile: rec.createdFile },
          connectedAt: typeof rec.connectedAt === "string" ? rec.connectedAt : "",
        };
      }
    }
  }
  if (isSkillRecord(parsed.skill)) out.skills[parsed.skill.file] = parsed.skill;
  return out;
}

// Read the receipt, tolerating absence/corruption by returning an empty ledger —
// a connect that isn't recorded simply can't be auto-undone, never a throw.
export function loadConnections(home: string): ConnectionsData {
  let text: string;
  try {
    text = readFileSync(connectionsPath(home), "utf8");
  } catch {
    return empty();
  }
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      if (parsed.version === 2) {
        return {
          version: 2,
          targets: parseTargets(parsed.targets),
          skills: parseSkills(parsed.skills),
        };
      }
      if (parsed.version === 1) return migrateV1(parsed);
    }
  } catch {
    // fall through
  }
  return empty();
}

// Persist the receipt, or delete it once nothing is connected — a clean home
// leaves no dangling ledger.
export function saveConnections(home: string, data: ConnectionsData): void {
  const noTargets = Object.keys(data.targets).length === 0;
  const noSkills = Object.keys(data.skills).length === 0;
  if (noTargets && noSkills) {
    rmSync(connectionsPath(home), { force: true });
    return;
  }
  // The keelson home may not exist yet (its creation is best-effort at CLI
  // startup), and the receipt is written AFTER the agent configs — so ensure it
  // exists here rather than let the write fail and strand an un-recorded connect.
  mkdirSync(home, { recursive: true });
  writeFileSync(connectionsPath(home), `${JSON.stringify(data, null, 2)}\n`);
}

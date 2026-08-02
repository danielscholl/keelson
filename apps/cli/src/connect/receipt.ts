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

// Structural guards so a hand-edited or corrupted receipt is rejected by the
// reader rather than crashing a later reverse (e.g. `skill.requestedBy.filter`).
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
      // The key and the record's own `target` must agree. Reversal reads the
      // key for skill claims but the record for its MCP path, so a receipt
      // where they disagree cleans one target's wiring while leaving the
      // other's claim behind. connect only ever writes them equal.
      if (isTargetRecord(rec) && rec.target === id) targets[id as TargetId] = rec;
    }
  }
  return targets;
}

function parseSkills(raw: unknown): ConnectionsData["skills"] {
  const skills: ConnectionsData["skills"] = {};
  if (isRecord(raw)) {
    for (const [path, rec] of Object.entries(raw)) {
      // Key and `file` must agree, for the same reason target records must:
      // reverseSkillsFor unlinks `skill.file` but drops the entry by its key,
      // so a divergent pair unlinks a file the ledger never claimed.
      if (isSkillRecord(rec) && rec.file === path) skills[path] = rec;
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
        rec.target === id &&
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

export type ReadConnectionsResult =
  | { ok: true; data: ConnectionsData }
  | { ok: false; reason: string };

// Strict read, separating "no receipt" (an empty ledger, fine) from "a receipt
// that cannot be parsed". Any caller that REWRITES the ledger must use this:
// degrading an unreadable file to empty and then saving deletes the only record
// of what connect wrote, while the agent stays wired to keelson.
// Entries present in the file but dropped by the structural guards. A rewriting
// caller must treat these as a hard failure: saving the filtered ledger deletes
// their only record while the wiring they describe is still in place.
function droppedEntries(raw: unknown, kept: number): number {
  return isRecord(raw) ? Object.keys(raw).length - kept : 0;
}

// A v2 container that is absent, or present but not an object at all. Either
// way the parse* helpers read it as empty and droppedEntries then sees nothing
// missing, so counting alone would accept it as a legitimately empty ledger.
// saveConnections always writes both keys, so a missing one is not a shape
// keelson produces — only an absent receipt means an empty ledger.
function malformedContainer(raw: unknown): boolean {
  return !isRecord(raw);
}

export function readConnections(home: string): ReadConnectionsResult {
  let text: string;
  try {
    text = readFileSync(connectionsPath(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: empty() };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not a JSON object" };
  if (parsed.version === 2) {
    if (malformedContainer(parsed.targets) || malformedContainer(parsed.skills)) {
      return { ok: false, reason: "missing or malformed 'targets' or 'skills' container" };
    }
    const targets = parseTargets(parsed.targets);
    const skills = parseSkills(parsed.skills);
    const bad =
      droppedEntries(parsed.targets, Object.keys(targets).length) +
      droppedEntries(parsed.skills, Object.keys(skills).length);
    if (bad > 0) return { ok: false, reason: `${bad} malformed record(s)` };
    return { ok: true, data: { version: 2, targets, skills } };
  }
  if (parsed.version === 1) {
    // Present-but-not-an-object only: v1 is a legacy shape this code never
    // wrote, so an omitted container is not evidence of tampering the way a
    // missing v2 one is.
    if (parsed.targets !== undefined && !isRecord(parsed.targets)) {
      return { ok: false, reason: "malformed v1 'targets' container" };
    }
    // v1's `skill` is a single record, not a container; migrateV1 drops an
    // invalid one silently, which is the same loss by another route.
    if (parsed.skill !== undefined && !isSkillRecord(parsed.skill)) {
      return { ok: false, reason: "malformed v1 'skill' record" };
    }
    const data = migrateV1(parsed);
    const bad = droppedEntries(parsed.targets, Object.keys(data.targets).length);
    if (bad > 0) return { ok: false, reason: `${bad} malformed v1 record(s)` };
    return { ok: true, data };
  }
  return { ok: false, reason: `unsupported receipt version ${JSON.stringify(parsed.version)}` };
}

// There is deliberately no tolerant reader here. One that degraded a corrupt
// receipt to an empty ledger existed, and every caller that paired it with
// saveConnections destroyed the record of already-wired agents while reporting
// success. A caller that genuinely wants to proceed on an unreadable receipt
// must say so at its own call site, where the choice is visible.

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

// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The connect receipt: a record under the keelson home of exactly what
// `keelson connect` wrote into each external agent's config, so `keelson
// disconnect` reverses precisely that and never a file or key the operator
// owned. Honesty over cleverness — undo trusts this ledger, not a re-derivation.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetFormat, TargetId } from "./targets.ts";

export const CONNECTIONS_FILE = "connections.json";

// One external agent keelson wrote MCP config into.
export interface TargetRecord {
  target: TargetId;
  // Absolute path to the config file that was written.
  file: string;
  format: TargetFormat;
  // Whether connect created the config file itself (vs. adding a key to an
  // existing one). Only a file connect created is a deletion candidate on undo.
  createdFile: boolean;
  connectedAt: string;
}

// The shared SKILL.md, tracked once and reference-counted across targets so
// disconnecting one target that still leaves another connected keeps the skill.
export interface SkillRecord {
  file: string;
  createdFile: boolean;
  // Dirs connect created to place the skill, deepest-first, removed on the last
  // disconnect only if still empty.
  createdDirs: string[];
  // Targets that requested the skill drop; undo removes the file only when this
  // empties.
  requestedBy: TargetId[];
}

export interface ConnectionsData {
  version: 1;
  targets: Partial<Record<TargetId, TargetRecord>>;
  skill?: SkillRecord;
}

export function connectionsPath(home: string): string {
  return join(home, CONNECTIONS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Read the receipt, tolerating absence/corruption by returning an empty ledger —
// a connect that isn't recorded simply can't be auto-undone, never a throw.
export function loadConnections(home: string): ConnectionsData {
  let text: string;
  try {
    text = readFileSync(connectionsPath(home), "utf8");
  } catch {
    return { version: 1, targets: {} };
  }
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.targets)) {
      return {
        version: 1,
        targets: parsed.targets as ConnectionsData["targets"],
        ...(isRecord(parsed.skill) ? { skill: parsed.skill as unknown as SkillRecord } : {}),
      };
    }
  } catch {
    // fall through
  }
  return { version: 1, targets: {} };
}

// Persist the receipt, or delete it once nothing is connected — a clean home
// leaves no dangling ledger.
export function saveConnections(home: string, data: ConnectionsData): void {
  const noTargets = Object.keys(data.targets).length === 0;
  const noSkill = data.skill === undefined || data.skill.requestedBy.length === 0;
  if (noTargets && noSkill) {
    rmSync(connectionsPath(home), { force: true });
    return;
  }
  writeFileSync(connectionsPath(home), `${JSON.stringify(data, null, 2)}\n`);
}

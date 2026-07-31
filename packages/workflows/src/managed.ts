// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANAGED_MANIFEST_NAME = ".managed.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readManagedManifest(workflowsDir: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(workflowsDir, MANAGED_MANIFEST_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  // A missing manifest means "nothing tracked yet"; damaged content does not.
  // Reading it as empty would let the next write replace it with only the
  // current bundle, discarding the provenance that makes a retired overlay
  // recognizable — the permanent-orphan state this manifest exists to prevent.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`managed workflow manifest is unreadable: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("managed workflow manifest is not a JSON object");
  }

  const manifest: Record<string, string> = {};
  for (const [name, hash] of Object.entries(parsed)) {
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      throw new Error(`managed workflow manifest has a malformed entry for ${name}`);
    }
    manifest[name] = hash;
  }
  return manifest;
}

export function writeManagedManifest(workflowsDir: string, manifest: Record<string, string>): void {
  mkdirSync(workflowsDir, { recursive: true });
  const destination = join(workflowsDir, MANAGED_MANIFEST_NAME);
  const temporary = join(workflowsDir, `${MANAGED_MANIFEST_NAME}.${process.pid}.tmp`);
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );

  try {
    writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

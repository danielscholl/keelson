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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const manifest: Record<string, string> = {};
  for (const [name, hash] of Object.entries(parsed)) {
    if (typeof hash === "string" && SHA256_PATTERN.test(hash)) manifest[name] = hash;
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

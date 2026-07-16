// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

// First unscoped `registry=` assignment; scoped lines (@scope:registry=) don't
// govern where ordinary dependencies resolve from.
export function parseNpmrcRegistry(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const m = line.match(/^registry\s*=\s*(\S+)/);
    if (m?.[1]) return m[1];
  }
  return null;
}

// The registry bun resolves from when installing in `dir` — dir .npmrc wins
// over the user's, mirroring bun's own lookup (it does not walk parent dirs).
export function effectiveRegistry(dir: string, userHome: string = homedir()): string {
  for (const p of [join(dir, ".npmrc"), join(userHome, ".npmrc")]) {
    try {
      const found = parseNpmrcRegistry(readFileSync(p, "utf8"));
      if (found) return found;
    } catch {}
  }
  return DEFAULT_NPM_REGISTRY;
}

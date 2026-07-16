// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

// Mirrors the npmrc INI semantics bun applies: ;/# comments, last assignment
// wins, optional surrounding quotes, ${VAR} / ${VAR?} environment expansion
// (undefined ${VAR} stays literal; undefined ${VAR?} becomes empty).
export function parseNpmrcRegistry(
  content: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  let registry: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const m = line.match(/^registry\s*=\s*(.+)$/);
    if (!m?.[1]) continue;
    let value = m[1].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/g,
      (whole, name: string, optional) => env[name] ?? (optional ? "" : whole),
    );
    if (value) registry = value;
  }
  return registry;
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

// Registry URLs can embed credentials (user:pass@host, ?token=…) — strip
// userinfo, query, and fragment before the URL appears in any output.
export function displayRegistry(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

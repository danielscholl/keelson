// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Shell resolution shared by the `bash` handler and the loop `until_bash` probe.
 *
 * On POSIX `bash` is on PATH and this resolves to a bare `"bash"`. On Windows
 * the bare `bash` on PATH is usually `C:\Windows\System32\bash.exe` — the WSL
 * launcher, which runs inside a separate Linux filesystem namespace where the
 * Windows working directory and the `KEELSON_*`/`ARTIFACTS_DIR` paths we project
 * into the env do not resolve. Git for Windows ships a genuine POSIX bash that
 * honors a Windows cwd, so prefer it. `KEELSON_BASH` is the operator escape
 * hatch for non-standard installs (MSYS2, a custom path, etc.).
 *
 * A subprocess is spawned with an explicit env (it carries the `KEELSON_*`
 * channel), which replaces — rather than augments — the inherited environment.
 * That drops Git Bash's own `usr/bin`, so its coreutils (`sleep`, `head`, `cat`,
 * `grep`, …) become unfindable and scripts fail with `command not found`.
 * `resolveBash` therefore also reports the dirs to splice back onto PATH.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ResolvedBash {
  cmd: string;
  // Dirs to prepend to the subprocess PATH so a Windows Git Bash finds its
  // coreutils. Empty on POSIX and for a PATH-resolved `bash`. Windows-style
  // paths — MSYS2 bash converts them to POSIX form at startup.
  pathDirs: readonly string[];
}

// Resolution order (first hit wins): KEELSON_BASH → Git Bash (Windows) → PATH.
export function resolveBash(): ResolvedBash {
  const override = process.env.KEELSON_BASH?.trim();
  if (override) return { cmd: override, pathDirs: gitBashPathDirs(override) };
  if (process.platform === "win32") {
    for (const candidate of windowsGitBashCandidates()) {
      if (existsSync(candidate)) return { cmd: candidate, pathDirs: gitBashPathDirs(candidate) };
    }
  }
  return { cmd: "bash", pathDirs: [] };
}

// Prepend dirs to the env's PATH using the platform delimiter, mutating and
// returning env. Targets the existing PATH-ish key (Windows carries `Path`), so
// the result stays a single variable rather than a `Path`/`PATH` split.
export function prependPath(
  env: Record<string, string>,
  dirs: readonly string[],
): Record<string, string> {
  if (dirs.length === 0) return env;
  let key = "PATH";
  if (env[key] === undefined) {
    for (const k of Object.keys(env)) {
      if (k.toUpperCase() === "PATH") {
        key = k;
        break;
      }
    }
  }
  const existing = env[key];
  env[key] = existing ? `${dirs.join(delimiter)}${delimiter}${existing}` : dirs.join(delimiter);
  return env;
}

// Derive Git Bash's coreutils dirs from the resolved bash.exe path. The exe
// lives at <root>\bin\bash.exe or <root>\usr\bin\bash.exe; the coreutils sit
// under <root>\usr\bin (plus mingw64\bin for the toolchain). Returns [] when the
// path isn't a recognized Git-for-Windows layout (e.g. a custom KEELSON_BASH).
function gitBashPathDirs(bashExe: string): readonly string[] {
  if (process.platform !== "win32") return [];
  const norm = bashExe.replace(/\//g, "\\").toLowerCase();
  let root: string | undefined;
  if (norm.endsWith("\\usr\\bin\\bash.exe")) {
    root = bashExe.slice(0, bashExe.length - "\\usr\\bin\\bash.exe".length);
  } else if (norm.endsWith("\\bin\\bash.exe")) {
    root = bashExe.slice(0, bashExe.length - "\\bin\\bash.exe".length);
  }
  if (!root) return [];
  return [join(root, "mingw64", "bin"), join(root, "usr", "bin"), join(root, "bin")].filter((d) =>
    existsSync(d),
  );
}

function windowsGitBashCandidates(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined,
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    // bin/bash.exe is the wrapper that sets up the MSYS2 environment; usr/bin
    // is the fallback layout some Git installs expose.
    out.push(join(root, "Git", "bin", "bash.exe"));
    out.push(join(root, "Git", "usr", "bin", "bash.exe"));
  }
  return out;
}

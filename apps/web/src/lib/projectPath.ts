// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Recognize an absolute filesystem path across platforms so `/project <path>`
// registers a local checkout: POSIX (`/...`), home (`~...`), Windows
// drive-letter (`C:\...` or `C:/...`), or UNC (`\\server\share`). Without the
// Windows arms a `C:\...` path falls through to the command's usage error.
export function isAbsoluteLocalPath(input: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(input);
}

// Fold a raw string into the project-name charset (shared projectNameSchema):
// lowercase `[a-z0-9_-]`, no leading/trailing separators.
export function slugifyProjectName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

// Derive a project name from a path's final segment, splitting on both `/` and
// `\` so a Windows path yields its leaf dir (`C:\...\keelson` → `keelson`).
export function deriveProjectNameFromPath(rootPath: string): string {
  const segs = rootPath.replace(/[/\\]+$/, "").split(/[/\\]/);
  return slugifyProjectName(segs[segs.length - 1] ?? "");
}

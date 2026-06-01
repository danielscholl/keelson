// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// One always-on markdown document per project — the local user's accumulated
// context about a repo. Lives only in this Keelson instance's SQLite store,
// never in the project repo. Distinct from the governed `memories` ledger.

import type { Database } from "bun:sqlite";

export interface ProjectNotebook {
  projectId: string;
  content: string;
  updatedAt: string;
}

// Where agent + one-click appends land unless a section is named.
export const DEFAULT_NOTEBOOK_SECTION = "Log";

// Generous headroom above the ~6 KB injected budget so a notebook can grow
// before Tidy compacts it, while still bounding a runaway write. Shared with
// the PUT route so hand-edits and appends reject at the same ceiling.
export const NOTEBOOK_CONTENT_LIMIT = 200_000;

export type AppendResult =
  | { ok: true; notebook: ProjectNotebook; previousContent: string }
  | { ok: false; reason: "notebook_full" };

export interface ProjectNotebookStore {
  get(projectId: string): ProjectNotebook | undefined;
  upsert(projectId: string, content: string): ProjectNotebook;
  appendEntry(projectId: string, entry: string, section?: string, date?: string): AppendResult;
}

interface NotebookRow {
  project_id: string;
  content: string;
  updated_at: string;
}

function rowToNotebook(row: NotebookRow): ProjectNotebook {
  return { projectId: row.project_id, content: row.content, updatedAt: row.updated_at };
}

// A raw newline in a header injects a spurious `##` boundary and in a bullet
// breaks the list, so section names and free-text entries are folded to one
// line before composition.
function flattenInline(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

// A section boundary is an H2 header; deeper headers (`### …`) are content
// within the block. `## ` (two hashes + space) never matches `### `.
function isSectionBoundary(trimmed: string): boolean {
  return trimmed.startsWith("## ");
}

// Append a dated bullet to `## <section>`, creating the section at the end of
// the document when absent. Whitespace is only touched at the seam so a
// hand-edited notebook keeps clean diffs in the Memory tab. Pure + date-injected
// for deterministic tests; the limit is enforced by the caller, not here.
export function appendEntryToSection(
  content: string,
  section: string,
  entry: string,
  date: string,
): string {
  const header = `## ${flattenInline(section)}`;
  const bullet = `- ${date}: ${flattenInline(entry)}`;

  if (content.trim() === "") {
    return `${header}\n${bullet}\n`;
  }

  const lines = content.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);

  if (headerIdx === -1) {
    const trimmedDoc = content.replace(/\n+$/, "");
    return `${trimmedDoc}\n\n${header}\n${bullet}\n`;
  }

  // Block end = next H2 boundary or EOF; walk back past trailing blanks so the
  // bullet sits right after the last content line, before the next header.
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isSectionBoundary(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1]!.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, bullet);
  const result = lines.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function createProjectNotebookStore(db: Database): ProjectNotebookStore {
  const getStmt = db.prepare(
    "SELECT project_id, content, updated_at FROM project_notebooks WHERE project_id = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO project_notebooks (project_id, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  );

  function get(projectId: string): ProjectNotebook | undefined {
    const row = getStmt.get(projectId) as NotebookRow | null;
    return row ? rowToNotebook(row) : undefined;
  }

  function upsert(projectId: string, content: string): ProjectNotebook {
    const updatedAt = new Date().toISOString();
    upsertStmt.run(projectId, content, updatedAt);
    return { projectId, content, updatedAt };
  }

  return {
    get,
    upsert,
    appendEntry(projectId, entry, section, date) {
      const sectionName = section?.trim() || DEFAULT_NOTEBOOK_SECTION;
      const day = date ?? new Date().toISOString().slice(0, 10);
      const previousContent = get(projectId)?.content ?? "";
      const nextContent = appendEntryToSection(previousContent, sectionName, entry, day);
      if (nextContent.length > NOTEBOOK_CONTENT_LIMIT) {
        return { ok: false, reason: "notebook_full" };
      }
      return { ok: true, notebook: upsert(projectId, nextContent), previousContent };
    },
  };
}

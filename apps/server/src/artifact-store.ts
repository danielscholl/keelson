// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// File-backed store for published canvas artifacts under <home>/artifacts:
// one <slug>.html (the page, operator-openable in any browser) plus one
// <slug>.json sidecar (title, updatedAt). Files survive restarts; boot walks
// the sidecars and re-registers each slug's snapshot key.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canvasArtifactSlugSchema } from "@keelson/shared";

export interface CanvasArtifactMeta {
  slug: string;
  title: string;
  updatedAt: string;
}

export interface CanvasArtifact extends CanvasArtifactMeta {
  html: string;
}

export interface ArtifactStore {
  list(): CanvasArtifactMeta[];
  get(slug: string): CanvasArtifact | undefined;
  save(input: { slug: string; title: string; html: string }): CanvasArtifact;
}

function htmlPath(dir: string, slug: string): string {
  return join(dir, `${slug}.html`);
}

function metaPath(dir: string, slug: string): string {
  return join(dir, `${slug}.json`);
}

// Temp-file + rename so a crash mid-write never leaves a torn artifact; both
// files live in the same directory, so the rename is atomic on POSIX.
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function createArtifactStore(dir: string): ArtifactStore {
  return {
    list(): CanvasArtifactMeta[] {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      const out: CanvasArtifactMeta[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith(".json")) continue;
        const slug = entry.slice(0, -".json".length);
        if (!canvasArtifactSlugSchema.safeParse(slug).success) continue;
        try {
          const meta = JSON.parse(readFileSync(metaPath(dir, slug), "utf8")) as {
            title?: unknown;
            updatedAt?: unknown;
          };
          out.push({
            slug,
            title: typeof meta.title === "string" && meta.title.length > 0 ? meta.title : slug,
            updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : "",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[canvas] skipping unreadable artifact meta '${entry}': ${msg}`);
        }
      }
      return out;
    },

    get(slug: string): CanvasArtifact | undefined {
      if (!canvasArtifactSlugSchema.safeParse(slug).success) return undefined;
      try {
        const html = readFileSync(htmlPath(dir, slug), "utf8");
        let title = slug;
        let updatedAt = "";
        try {
          const meta = JSON.parse(readFileSync(metaPath(dir, slug), "utf8")) as {
            title?: unknown;
            updatedAt?: unknown;
          };
          if (typeof meta.title === "string" && meta.title.length > 0) title = meta.title;
          if (typeof meta.updatedAt === "string") updatedAt = meta.updatedAt;
        } catch {
          // A missing/corrupt sidecar degrades to slug-as-title; the page still renders.
        }
        return { slug, title, updatedAt, html };
      } catch {
        return undefined;
      }
    },

    save(input: { slug: string; title: string; html: string }): CanvasArtifact {
      const slug = canvasArtifactSlugSchema.parse(input.slug);
      mkdirSync(dir, { recursive: true });
      const updatedAt = new Date().toISOString();
      writeAtomic(htmlPath(dir, slug), input.html);
      try {
        writeAtomic(metaPath(dir, slug), `${JSON.stringify({ title: input.title, updatedAt })}\n`);
      } catch (err) {
        // Keep the pair consistent: a page without a sidecar would silently
        // vanish from list(); surface the failure instead.
        rmSync(htmlPath(dir, slug), { force: true });
        throw err;
      }
      return { slug, title: input.title, updatedAt, html: input.html };
    },
  };
}

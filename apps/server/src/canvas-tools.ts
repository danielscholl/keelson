// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Chat/workflow/MCP tools for designed canvas artifacts. canvas_publish
// persists a self-contained HTML page and drives its `canvas:artifact:<slug>`
// snapshot key; canvas_design_guide serves the on-demand design references.
// Publish validation is fail-closed on the computable checks: a declared
// categorical palette that hard-fails CVD/contrast rejects the call with the
// per-check report so the model fixes the colors and retries in-turn.

import {
  CANVAS_DESIGN_GUIDE_SECTIONS,
  CANVAS_PUBLISH_CONTRACT,
  canvasArtifactKey,
  canvasArtifactSlugSchema,
  type DesignThemeName,
  formatPaletteReport,
  type SnapshotManager,
  type ToolContext,
  type ToolDefinition,
  validateCategoricalPalette,
} from "@keelson/shared";
import { z } from "zod";
import type { ArtifactStore } from "./artifact-store.ts";

const MAX_HTML_BYTES = 512 * 1024;

const publishInputSchema = z
  .object({
    title: z.string().min(1).max(80).describe("Human title shown on the canvas drawer."),
    html: z
      .string()
      .min(1)
      .max(MAX_HTML_BYTES)
      .describe("The page body markup (self-contained; the host supplies the document shell)."),
    name: canvasArtifactSlugSchema
      .optional()
      .describe(
        "Stable artifact slug. Pass the slug from an earlier publish to update that artifact in place; omit to create a new one derived from the title.",
      ),
  })
  .strict();

const guideInputSchema = z
  .object({
    section: z
      .enum(["page", "form", "color", "marks", "anti-patterns"])
      .describe(
        "Which reference to read: 'page' layout/typography/theming, 'form' choosing a chart, 'color' the color jobs + keelson palette instance, 'marks' mark anatomy and interaction, 'anti-patterns' the catalog to check drafts against.",
      ),
  })
  .strict();

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  // toolUseId is a placeholder — Claude ignores it, Copilot rewrites it to the
  // real call id. See the provider factories.
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "artifact";
}

// Pull one data-palette-* attribute's hex list off the <body> tag. Attribute
// order is free; values are comma-separated hex in slot order.
function declaredPalette(html: string, attr: string): string[] | undefined {
  const body = /<body\b[^>]*>/i.exec(html)?.[0];
  if (!body) return undefined;
  const value = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i").exec(body)?.[1];
  if (value === undefined) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

// Structural rejects that would otherwise fail silently at render: the frame
// CSP blocks external scripts/stylesheets, so publishing them is always a bug.
function structuralError(html: string): string | undefined {
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    return "external <script src> is blocked by the frame CSP — inline all script.";
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) {
    return "external stylesheets are blocked by the frame CSP — inline all CSS in a <style> block.";
  }
  return undefined;
}

export interface CreateCanvasToolsDeps {
  store: ArtifactStore;
  snapshotManager: SnapshotManager;
}

export interface CanvasToolsHandle {
  tools: ToolDefinition[];
  // Re-register every persisted artifact's snapshot key — called once at boot
  // so pages survive a server restart without a re-publish.
  registerExisting(): void;
  unregister(slug: string): void;
}

export function createCanvasTools(deps: CreateCanvasToolsDeps): CanvasToolsHandle {
  const registered = new Set<string>();
  const unregisters = new Map<string, () => void>();

  function ensureKey(slug: string): void {
    if (registered.has(slug)) return;
    const off = deps.snapshotManager.register(
      canvasArtifactKey(slug),
      () => deps.store.get(slug)?.html ?? "",
      {
        validate: (data: unknown) => {
          if (typeof data !== "string" || data.length === 0) {
            throw new Error(`${canvasArtifactKey(slug)} expects a non-empty html string`);
          }
          return data;
        },
      },
    );
    unregisters.set(slug, off);
    registered.add(slug);
  }

  const publish: ToolDefinition = {
    name: "canvas_publish",
    description: CANVAS_PUBLISH_CONTRACT,
    inputSchema: publishInputSchema,
    state_changing: true,
    async execute(input: unknown, ctx: ToolContext): Promise<void> {
      const parsed = publishInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const { title, html, name } = parsed.data;

      const structural = structuralError(html);
      if (structural !== undefined) {
        emitResult(ctx, structural, true);
        return;
      }

      const both = declaredPalette(html, "data-palette");
      const palettes: Partial<Record<DesignThemeName, string[]>> = {
        dark: declaredPalette(html, "data-palette-dark") ?? both,
        light: declaredPalette(html, "data-palette-light") ?? both,
      };
      const paletteSummary: string[] = [];
      for (const mode of ["dark", "light"] as const) {
        const palette = palettes[mode];
        if (!palette) continue;
        let report: ReturnType<typeof validateCategoricalPalette>;
        try {
          report = validateCategoricalPalette(palette, { mode });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitResult(ctx, `data-palette-${mode}: ${msg}`, true);
          return;
        }
        if (!report.ok) {
          emitResult(
            ctx,
            `the declared ${mode} palette fails validation — fix the colors (prefer the keelson series slots from canvas_design_guide section "color") and publish again:\n${formatPaletteReport(report)}`,
            true,
          );
          return;
        }
        const warns = report.checks.filter((c) => c.status === "warn").length;
        paletteSummary.push(
          `${mode}: validated${warns > 0 ? ` (${warns} warn — secondary encoding required)` : ""}`,
        );
      }
      if (paletteSummary.length === 0) {
        paletteSummary.push(
          "none declared — fine for chart-free pages; declare data-palette-dark/-light when the page carries categorical series",
        );
      }

      // Explicit name updates in place; a bare title never silently overwrites
      // a different artifact that happens to slugify the same.
      let slug = name ?? slugifyTitle(title);
      if (name === undefined) {
        const base = slug;
        for (let n = 2; deps.store.get(slug) !== undefined; n++) slug = `${base}-${n}`.slice(0, 64);
      }
      const updated = deps.store.get(slug) !== undefined;

      let saved: ReturnType<ArtifactStore["save"]>;
      try {
        saved = deps.store.save({ slug, title, html });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitResult(ctx, `failed to persist artifact: ${msg}`, true);
        return;
      }
      ensureKey(slug);
      await deps.snapshotManager.recompose(canvasArtifactKey(slug));

      emitResult(
        ctx,
        JSON.stringify({
          key: canvasArtifactKey(slug),
          slug,
          title: saved.title,
          updated,
          bytes: Buffer.byteLength(html, "utf8"),
          palette: paletteSummary.join("; "),
        }),
      );
    },
  };

  const guide: ToolDefinition = {
    name: "canvas_design_guide",
    description:
      "Read one section of the canvas artifact design guide before authoring: layout/typography/theming rules, chart-form selection, the color system and keelson palette instance, mark anatomy, or the anti-pattern catalog to check a draft against.",
    inputSchema: guideInputSchema,
    async execute(input: unknown, ctx: ToolContext): Promise<void> {
      const parsed = guideInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const text = CANVAS_DESIGN_GUIDE_SECTIONS[parsed.data.section];
      if (text === undefined) {
        emitResult(ctx, `unknown section '${parsed.data.section}'`, true);
        return;
      }
      emitResult(ctx, text);
    },
  };

  return {
    tools: [publish, guide],
    registerExisting(): void {
      for (const meta of deps.store.list()) {
        ensureKey(meta.slug);
        // GET /api/snapshots/:key serves only the cached frame — without a boot
        // recompose a restored artifact would render empty until republished.
        void deps.snapshotManager.recompose(canvasArtifactKey(meta.slug));
      }
    },
    unregister(slug: string): void {
      unregisters.get(slug)?.();
      unregisters.delete(slug);
      registered.delete(slug);
    },
  };
}

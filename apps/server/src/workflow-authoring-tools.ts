// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Chat-callable tools for AUTHORING workflows, beside the workflow_* run
// family: workflow_schema serves the embedded reference, workflow_get reads an
// existing workflow's YAML to adapt, workflow_validate dry-runs the loader,
// and workflow_save validates-then-writes into the global or project scope.
// Validation lives inside the write path on purpose — an invalid workflow
// physically cannot be saved, and the loader's structured errors come back as
// the tool result so the model self-corrects in the same turn.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ToolDefinition } from "@keelson/shared";
import { projectWorkflowsDir } from "@keelson/shared/paths";
import {
  AUTHORING_GUIDE_TOPICS,
  authoringGuideSection,
  parseWorkflow,
  WORKFLOW_AUTHORING_GUIDE,
  type WorkflowLoadWarning,
} from "@keelson/workflows";
import { z } from "zod";
import type { WorkflowCatalog, WorkflowScopeContext } from "./bootstrap.ts";
import { resolveWorkflowName } from "./workflow-resolve.ts";
import { emitResult, truncate } from "./workflow-tools.ts";

export interface CreateWorkflowAuthoringToolsDeps {
  catalog: WorkflowCatalog;
  // The SAME resolved dir the catalog's global root scans (index.ts passes
  // keelsonPaths().workflowsDir, honoring KEELSON_WORKFLOWS_DIR). Never
  // recomputed here, so save targets cannot drift from discovery.
  globalWorkflowsDir: string;
  // The conversation's project, resolved per request (note_project pattern).
  // Null means scope:"project" saves error with guidance.
  project: { id: string; name?: string; rootPath: string } | null;
}

const MAX_YAML_BYTES = 131_072;
const GET_OUTPUT_CAP = 49_152;

// Strict kebab-case with no separators or dots — the filename is
// `name + ".yaml"`, so this regex is also the path-traversal guard.
const WORKFLOW_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_CHARS = 64;

const getInputSchema = z.object({ name: z.string().min(1).max(120) }).strict();
const validateInputSchema = z.object({ yaml: z.string().min(1).max(MAX_YAML_BYTES) }).strict();
const saveInputSchema = z
  .object({
    name: z
      .string()
      .max(MAX_NAME_CHARS)
      .regex(
        WORKFLOW_NAME_RE,
        "must be kebab-case: lowercase letters and digits separated by single hyphens",
      ),
    yaml: z.string().min(1).max(MAX_YAML_BYTES),
    scope: z.enum(["global", "project"]),
    overwrite: z.boolean().optional(),
  })
  .strict();
const schemaInputSchema = z.object({ topic: z.string().optional() }).strict();

function renderWarnings(warnings: readonly WorkflowLoadWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => {
    const nodeRef = w.nodeId ? `(node ${w.nodeId}) ` : "";
    return `- [${w.kind}] ${nodeRef}${w.message}`;
  });
  return `Warnings (${warnings.length}, non-blocking):\n${lines.join("\n")}`;
}

// The loader aggregates node errors into one "; "-joined string. Split only
// at node boundaries — individual messages legitimately contain "; " (e.g.
// "…substitution namespace); rename the node."), so a bare split would
// fragment one error into misleading bullets.
function renderError(error: { error: string; errorType: string }): string {
  const bullets = error.error
    .split(/;\s+(?=Node ')/)
    .map((line) => `- ${line}`)
    .join("\n");
  return `INVALID (${error.errorType}):\n${bullets}`;
}

// realpath-based comparison so symlinked layouts (macOS /tmp → /private/tmp,
// symlinked checkouts) can't make one physical directory look like two scopes.
function sameDir(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return canonical(a) === canonical(b);
}

export function createWorkflowAuthoringTools(
  deps: CreateWorkflowAuthoringToolsDeps,
): ToolDefinition[] {
  const { catalog, globalWorkflowsDir, project } = deps;
  const scope: WorkflowScopeContext | undefined = project ? { projectId: project.id } : undefined;

  const workflowSchema: ToolDefinition = {
    name: "workflow_schema",
    description: `Return the keelson workflow-authoring reference (YAML schema, node types, variables, patterns). Call this before drafting or editing a workflow. Optional \`topic\` narrows to one section: ${AUTHORING_GUIDE_TOPICS.join(", ")}.`,
    inputSchema: schemaInputSchema,
    async execute(input, ctx) {
      const parsed = schemaInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const topic = parsed.data.topic;
      if (topic !== undefined) {
        const section = authoringGuideSection(topic);
        if (section !== undefined) {
          emitResult(ctx, section);
          return;
        }
        emitResult(
          ctx,
          `No section "${topic}" — valid topics: ${AUTHORING_GUIDE_TOPICS.join(", ")}. Full guide follows.\n\n${WORKFLOW_AUTHORING_GUIDE}`,
        );
        return;
      }
      emitResult(ctx, WORKFLOW_AUTHORING_GUIDE);
    },
  };

  const workflowGet: ToolDefinition = {
    name: "workflow_get",
    description:
      "Read an existing workflow's raw YAML source (plus its scope and file path) to use as a model when authoring. Names are matched leniently. Rib-contributed workflows have no YAML file and cannot be fetched.",
    inputSchema: getInputSchema,
    async execute(input, ctx) {
      const parsed = getInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const requested = parsed.data.name;
      let name = requested;
      if (!catalog.get(name, scope)) {
        const names = catalog.list(scope).map((w) => w.name);
        const resolution = resolveWorkflowName(requested, names);
        if (resolution.kind === "match") {
          name = resolution.name;
        } else if (resolution.kind === "suggest") {
          emitResult(
            ctx,
            `No workflow named "${requested}". Did you mean: ${resolution.candidates.join(", ")}?`,
            true,
          );
          return;
        } else {
          const avail =
            names.length > 0
              ? `Available workflows: ${names.join(", ")}.`
              : "No workflows are available.";
          emitResult(ctx, `No workflow matches "${requested}". ${avail}`, true);
          return;
        }
      }
      const entry = catalog.getWithSource(name, scope);
      if (!entry) {
        emitResult(
          ctx,
          `"${name}" is contributed by a rib and has no YAML file to copy. Pick a file-based example via workflow_list, or start from workflow_schema.`,
          true,
        );
        return;
      }
      let yaml: string;
      try {
        yaml = readFileSync(entry.path, "utf-8");
      } catch (err) {
        emitResult(
          ctx,
          `Could not read ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
        return;
      }
      emitResult(
        ctx,
        [
          `Workflow "${name}" — scope: ${entry.source}`,
          `Path: ${entry.path}`,
          "",
          "--- YAML source ---",
          truncate(yaml, GET_OUTPUT_CAP),
        ].join("\n"),
      );
    },
  };

  const workflowValidate: ToolDefinition = {
    name: "workflow_validate",
    description:
      "Dry-run a draft workflow YAML through the real loader without writing anything. Returns structured errors to fix, or VALID plus any non-blocking warnings. Always validate before workflow_save.",
    inputSchema: validateInputSchema,
    async execute(input, ctx) {
      const parsed = validateInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const result = parseWorkflow(parsed.data.yaml, "draft.yaml");
      const warningBlock = renderWarnings(result.warnings);
      if (result.error) {
        emitResult(
          ctx,
          [
            renderError(result.error),
            warningBlock,
            "Fix the YAML and call workflow_validate again. Call workflow_schema for the field reference.",
          ]
            .filter((p) => p !== "")
            .join("\n\n"),
          true,
        );
        return;
      }
      const nodeIds = result.workflow.nodes.map((n) => n.id).join(", ");
      // The loader accepts any non-empty name, but workflow_save only writes
      // kebab-case ≤64 chars — surface the mismatch here so VALID never
      // promises a save that the next step will refuse.
      const saveableNote =
        WORKFLOW_NAME_RE.test(result.workflow.name) && result.workflow.name.length <= MAX_NAME_CHARS
          ? ""
          : `Heads up: the name "${result.workflow.name}" is valid to run but NOT saveable via workflow_save (names must be kebab-case, ≤${MAX_NAME_CHARS} chars). Rename it before saving.`;
      emitResult(
        ctx,
        [
          `VALID — workflow "${result.workflow.name}" parsed cleanly. ${result.workflow.nodes.length} node(s): ${nodeIds}.`,
          warningBlock,
          saveableNote,
          "Next: show the user the complete YAML and get approval, then call workflow_save.",
        ]
          .filter((p) => p !== "")
          .join("\n\n"),
      );
    },
  };

  const workflowSave: ToolDefinition = {
    name: "workflow_save",
    description:
      'Validate and save a workflow YAML to disk. `scope: "project"` writes <project>/.keelson/workflows/ (requires the conversation to have a project); `scope: "global"` writes the shared workflows dir. The `name` must be kebab-case and equal the YAML `name:` field. Refuses to replace an existing file unless `overwrite: true`. ALWAYS show the user the final YAML and get their approval (including scope and overwrite) before calling this.',
    inputSchema: saveInputSchema,
    state_changing: true,
    requires_confirmation: true,
    async execute(input, ctx) {
      const parsed = saveInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const { name, yaml, scope: saveScope } = parsed.data;
      const overwrite = parsed.data.overwrite === true;

      if (saveScope === "project") {
        if (!project) {
          emitResult(
            ctx,
            'This conversation has no linked project, so scope "project" is unavailable. Save with scope "global", or ask the user to link the conversation to a project first.',
            true,
          );
          return;
        }
        if (!existsSync(project.rootPath)) {
          emitResult(
            ctx,
            `The project root ${project.rootPath} does not exist on disk — cannot save there. Ask the user to fix the project's root path or save with scope "global".`,
            true,
          );
          return;
        }
      }

      const result = parseWorkflow(yaml, `${name}.yaml`);
      const warningBlock = renderWarnings(result.warnings);
      if (result.error) {
        emitResult(
          ctx,
          [
            "Save blocked — the YAML does not validate.",
            renderError(result.error),
            warningBlock,
            "Fix the YAML (workflow_validate to iterate) and call workflow_save again.",
          ]
            .filter((p) => p !== "")
            .join("\n\n"),
          true,
        );
        return;
      }
      if (result.workflow.name !== name) {
        emitResult(
          ctx,
          `The YAML declares name: "${result.workflow.name}" but you asked to save "${name}". Make them identical — the filename and the catalog key both derive from name.`,
          true,
        );
        return;
      }

      const targetDir =
        saveScope === "project" && project
          ? projectWorkflowsDir(project.rootPath)
          : globalWorkflowsDir;
      // In the monorepo dev layout a project's .keelson/workflows IS the
      // global dir (the catalog skips indexing it as a project scope). The
      // guards below must then run with GLOBAL semantics, or a scoped lookup
      // would fall through to the global entry and skip every check.
      const aliasesGlobal = saveScope === "project" && sameDir(targetDir, globalWorkflowsDir);
      const effectiveScope = aliasesGlobal ? "global" : saveScope;

      // Overwrite guard at the file level. With overwrite, the rewrite target
      // is the EXISTING file's name so a .yml never gains a .yaml twin.
      let filename = `${name}.yaml`;
      const existing = [`${name}.yaml`, `${name}.yml`].find((f) => existsSync(join(targetDir, f)));
      if (existing !== undefined) {
        if (!overwrite) {
          emitResult(
            ctx,
            `A workflow file already exists at ${join(targetDir, existing)}. Pass overwrite: true to replace it — confirm with the user first.`,
            true,
          );
          return;
        }
        // Filename matching is not identity: the existing file may declare a
        // DIFFERENT workflow name, and replacing it would silently destroy
        // that other workflow.
        try {
          const current = parseWorkflow(readFileSync(join(targetDir, existing), "utf-8"), existing);
          if (current.error === null && current.workflow.name !== name) {
            emitResult(
              ctx,
              `${join(targetDir, existing)} defines the workflow "${current.workflow.name}", not "${name}" — overwriting it would silently destroy that workflow. Pick a different name, or edit that workflow under its own name.`,
              true,
            );
            return;
          }
        } catch {
          // Unreadable existing file — the overwrite replaces it; nothing to protect.
        }
        filename = existing;
      }

      // A same-named workflow defined by a DIFFERENT file in this scope (e.g.
      // saved under another filename) would leave two definitions racing for
      // one catalog key — refuse rather than ever touching a third file.
      const sameScopePre =
        effectiveScope === "project"
          ? (() => {
              const entry = catalog.getWithSource(name, scope);
              return entry?.source === "project" ? entry : undefined;
            })()
          : catalog.getWithSource(name);
      if (sameScopePre !== undefined && basename(sameScopePre.path) !== filename) {
        emitResult(
          ctx,
          `"${name}" is already defined by ${sameScopePre.path} in the ${effectiveScope} scope. Saving ${filename} would create two files claiming one workflow name — rename this workflow or edit that file instead.`,
          true,
        );
        return;
      }

      // Shadow analysis, before the write so the pre-save catalog answers.
      // Provenance labels the shadowed side correctly (global file vs
      // rib-contributed) instead of calling everything "the global".
      const notes: string[] = [];
      if (aliasesGlobal) {
        notes.push(
          "Note: this project's .keelson/workflows is the global workflows dir, so the save is effectively global.",
        );
      }
      if (effectiveScope === "project") {
        if (catalog.get(name) !== undefined) {
          const shadowedKind = catalog.provenance(name).source.kind;
          notes.push(
            shadowedKind === "rib"
              ? `Note: this shadows the rib-contributed "${name}" for conversations in this project.`
              : `Note: this shadows the global "${name}" for conversations in this project.`,
          );
        }
      } else {
        if (catalog.getWithSource(name) === undefined && catalog.get(name) !== undefined) {
          notes.push(
            `Note: this file shadows the rib-contributed workflow "${name}" — the filesystem copy wins everywhere.`,
          );
        }
        if (project && !aliasesGlobal) {
          const projectEntry = catalog.getWithSource(name, scope);
          if (projectEntry?.source === "project") {
            notes.push(
              `Note: the project workflow at ${projectEntry.path} will continue to shadow this global copy inside that project.`,
            );
          }
        }
      }

      const targetPath = join(targetDir, filename);
      // Dot-prefixed non-yaml temp name keeps discovery + the catalog
      // fingerprint blind to the write until the atomic rename (seed.ts idiom).
      const tmpPath = join(targetDir, `.${filename}.${process.pid}.savetmp`);
      try {
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(tmpPath, yaml);
        renameSync(tmpPath, targetPath);
      } catch (err) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // Best-effort cleanup — the write error below is the one that matters.
        }
        emitResult(
          ctx,
          `Failed to write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
        return;
      }

      emitResult(
        ctx,
        [
          `Saved workflow "${name}" → ${targetPath} (scope: ${saveScope}).`,
          warningBlock,
          ...notes,
          `The catalog reloads automatically — it can be run now with workflow_run("${name}").`,
        ]
          .filter((p) => p !== "")
          .join("\n"),
      );
    },
  };

  return [workflowSchema, workflowGet, workflowValidate, workflowSave];
}

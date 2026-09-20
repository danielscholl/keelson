// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { fetchLiveModelCatalog, getProviderInfoList } from "@keelson/providers";
import {
  loadKeelsonConfig,
  readModelClassOverride,
  resolveDefaultProvider,
} from "@keelson/shared/config";
import {
  checkWorkflowCatalog,
  type PreflightViolation,
  parseWorkflow,
  resolveWorkflowResolution,
  type WorkflowDefinition,
} from "@keelson/workflows";

import { EXIT_BAD_ARGS, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { bootstrapCliProviders } from "../in-process/providers.ts";
import { emit } from "../output.ts";
import { workflowDiscoveryRoots } from "../paths.ts";

export interface WorkflowValidateOptions {
  json: boolean;
  dir?: string;
  live?: boolean;
}

interface ValidationRow {
  filename: string;
  ok: boolean;
  warnings: { kind: string; message: string }[];
  error: string | null;
  preflight?: {
    violations: PreflightViolation[];
    notChecked: string[];
  };
}

function listYaml(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .map((entry) => join(dir, entry))
      .filter((p) => statSync(p).isFile())
      .sort();
  } catch {
    return [];
  }
}

// Match a file whose workflow `name` field is `target` within one dir. If the
// file parses successfully, use the resolved name. If the file fails schema
// validation but its raw YAML names itself the same thing (toplevel
// `name: foo`), still return it — the operator asked to validate `foo`, and the
// right answer is to surface foo's validation error rather than "not found",
// which would hide the very failure they were trying to diagnose.
function findByNameInDir(dir: string, target: string): string | null {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameLine = new RegExp(`^name:\\s*['"]?${escaped}['"]?\\s*$`, "m");
  for (const filename of listYaml(dir)) {
    let content: string;
    try {
      content = readFileSync(filename, "utf-8");
    } catch {
      continue;
    }
    const result = parseWorkflow(content, filename);
    if (result.workflow?.name === target) return filename;
    if (!result.workflow && nameLine.test(content)) return filename;
  }
  return null;
}

// Resolve `target` across discovery dirs, highest precedence first
// (project > global > bundled), so validate inspects the file that would
// actually run when a name is defined in more than one root.
function findByName(dirs: readonly string[], target: string): string | null {
  for (const dir of [...dirs].reverse()) {
    const hit = findByNameInDir(dir, target);
    if (hit !== null) return hit;
  }
  return null;
}

export async function runWorkflowValidate(
  name: string | undefined,
  opts: WorkflowValidateOptions,
): Promise<never> {
  // An explicit --dir validates just that directory; otherwise validate every
  // discoverable root (bundled + global + project).
  const dirs = opts.dir ? [opts.dir] : workflowDiscoveryRoots().map((r) => r.dir);
  const files = name
    ? [findByName(dirs, name)].filter((f): f is string => f !== null)
    : dirs.flatMap(listYaml);

  if (name && files.length === 0) {
    emit(
      { error: `no workflow named '${name}' under ${dirs.join(", ")}`, code: "WORKFLOW_NOT_FOUND" },
      { json: opts.json },
    );
    process.exit(EXIT_NOT_FOUND);
  }

  const parsedFiles: Array<{ row: ValidationRow; workflow: WorkflowDefinition | null }> = [];
  for (const filename of files) {
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    parsedFiles.push({
      row: {
        filename,
        ok: result.error === null,
        warnings: result.warnings.map((w) => ({ kind: w.kind, message: w.message })),
        error: result.error?.error ?? null,
      },
      workflow: result.workflow,
    });
  }

  if (opts.live) {
    bootstrapCliProviders();
    const providerInfos = getProviderInfoList();
    if (providerInfos.length === 0) {
      emit(
        {
          error: "live workflow validation requires at least one registered provider",
          code: "NO_PROVIDERS",
        },
        { json: opts.json },
      );
      process.exit(EXIT_BAD_ARGS);
    }

    const config = loadKeelsonConfig();
    const providerIds = providerInfos.map(({ id }) => id);
    const envProviderId = process.env.KEELSON_WORKFLOW_PROVIDER?.trim();
    const defaultProviderId = envProviderId || resolveDefaultProvider(config, providerIds);
    const providers = new Map(
      providerInfos.map(({ id, capabilities }) => [
        id,
        {
          defaultModel: capabilities.defaultModel,
          models: capabilities.models,
          ...(capabilities.modelClasses !== undefined
            ? { modelClasses: capabilities.modelClasses }
            : {}),
        },
      ]),
    );
    const modelClassOverride = (id: string, modelClass: "fast" | "balanced" | "deep") =>
      readModelClassOverride(config, id)?.[modelClass];
    const effectiveProviders = parsedFiles.flatMap(({ workflow }) =>
      workflow === null
        ? []
        : resolveWorkflowResolution(workflow, {
            providers,
            defaultProviderId,
            modelClassOverride,
          }).nodes.flatMap(({ effectiveProvider }) =>
            effectiveProvider === undefined ? [] : [effectiveProvider],
          ),
    );
    const liveCatalog = await fetchLiveModelCatalog(effectiveProviders);

    for (const parsed of parsedFiles) {
      if (parsed.workflow === null) continue;
      const preflight = checkWorkflowCatalog(parsed.workflow, {
        providers,
        defaultProviderId,
        modelClassOverride,
        liveCatalog,
      });
      parsed.row.preflight = preflight;
      if (preflight.violations.length > 0) parsed.row.ok = false;
    }
  }

  const rows = parsedFiles.map(({ row }) => row);
  const failed = rows.filter(({ ok }) => !ok).length;
  emit({ data: { results: rows, failed, total: rows.length } }, { json: opts.json });
  process.exit(failed === 0 ? EXIT_OK : EXIT_BAD_ARGS);
}

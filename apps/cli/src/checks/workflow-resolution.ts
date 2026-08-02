// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { getProviderInfoList } from "@keelson/providers";
import {
  loadKeelsonConfig as defaultLoadConfig,
  type KeelsonConfig,
  readModelClassOverride,
  resolveDefaultProvider,
} from "@keelson/shared/config";
import {
  type DiscoveryResult,
  type DiscoveryRoot,
  discoverWorkflows as defaultDiscoverWorkflows,
  resolveWorkflowCatalog,
  type WorkflowResolution,
} from "@keelson/workflows";

import { bootstrapCliProviders } from "../in-process/providers.ts";
import { defaultWorkflowsDir } from "../paths.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

type ModelClass = "fast" | "balanced" | "deep";

interface StaticProviderInfo {
  id: string;
  capabilities: {
    defaultModel: string;
    models: readonly string[];
    modelClasses?: Record<ModelClass, string>;
  };
}

type Discoverer = (roots: readonly DiscoveryRoot[]) => DiscoveryResult;

export interface WorkflowResolutionDeps {
  discoverWorkflows?: Discoverer;
  workflowsDir?: string;
  loadConfig?: () => KeelsonConfig;
  listProviders?: () => readonly StaticProviderInfo[];
  defaultProviderId?: string;
}

function defaultListProviders(): readonly StaticProviderInfo[] {
  bootstrapCliProviders();
  return getProviderInfoList();
}

function resolutionCheck(result: WorkflowResolution): CheckResult {
  if (result.tier === "blocked") {
    return {
      name: result.name,
      status: "warn",
      detail: "blocked — no chat-capable provider registered",
      hint: "register one: `keelson provider add <id>`",
    };
  }

  if (result.tier === "degrades") {
    const details = [
      ...result.fallbackNodes.map(
        ({ nodeId, to }) => `${nodeId} falls back to ${to}`,
      ),
      ...result.collapses,
    ];
    return {
      name: result.name,
      status: "warn",
      detail: `degrades — ${details.join("; ")}`,
    };
  }

  const providers = [
    ...new Set(
      result.nodes
        .map(({ effectiveProvider }) => effectiveProvider)
        .filter((provider): provider is string => provider !== undefined),
    ),
  ];
  return {
    name: result.name,
    status: "ok",
    detail:
      `native — ${result.nodes.length} node(s) on ` +
      (providers.length > 0 ? providers.join(", ") : "no provider required"),
  };
}

export function runWorkflowResolutionCheck(
  deps: WorkflowResolutionDeps = {},
): CategoryResult {
  const discover = deps.discoverWorkflows ?? defaultDiscoverWorkflows;
  const dir = deps.workflowsDir ?? defaultWorkflowsDir();
  const discovery = discover([{ dir, source: "global" }]);
  const config = (deps.loadConfig ?? defaultLoadConfig)();
  const providerInfos = (deps.listProviders ?? defaultListProviders)();
  const providerIds = providerInfos.map(({ id }) => id);
  const defaultProviderId =
    deps.defaultProviderId ?? resolveDefaultProvider(config, providerIds);
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
  const resolutions = resolveWorkflowCatalog(
    discovery.workflows.map(({ workflow }) => workflow),
    {
      providers,
      defaultProviderId,
      modelClassOverride: (providerId, modelClass) =>
        readModelClassOverride(config, providerId)?.[modelClass],
    },
  );
  const checks = resolutions.map(resolutionCheck);

  for (const error of discovery.errors) {
    checks.push({
      name: error.filename,
      status: "warn",
      detail: error.error,
      hint: "run `keelson workflow validate <name>` for the full diagnostic",
    });
  }

  return { category: "workflow-resolution", checks };
}

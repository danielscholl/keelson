// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  getProviderInfoList,
  isRegisteredProvider,
  waitForCopilotModelClasses,
} from "@keelson/providers";
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
import { workflowDiscoveryRoots } from "../paths.ts";
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
  listProviders?: () => readonly StaticProviderInfo[] | Promise<readonly StaticProviderInfo[]>;
  defaultProviderId?: string;
  envProviderId?: string;
}

async function defaultListProviders(): Promise<readonly StaticProviderInfo[]> {
  bootstrapCliProviders();
  if (isRegisteredProvider("copilot")) await waitForCopilotModelClasses();
  return getProviderInfoList();
}

function resolutionCheck(
  result: WorkflowResolution,
  unavailableDefaultProviderId?: string,
): CheckResult {
  const unavailableNodes =
    unavailableDefaultProviderId === undefined
      ? []
      : result.nodes.filter(
          ({ effectiveProvider }) => effectiveProvider === unavailableDefaultProviderId,
        );
  if (unavailableNodes.length > 0) {
    const allPromptNodesBlocked = unavailableNodes.length === result.nodes.length;
    return {
      name: result.name,
      status: "warn",
      detail: allPromptNodesBlocked
        ? `blocked — provider '${unavailableDefaultProviderId}' selected by KEELSON_WORKFLOW_PROVIDER is not registered`
        : `degrades — ${unavailableNodes.map(({ nodeId }) => nodeId).join(", ")} blocked on unregistered provider '${unavailableDefaultProviderId}'`,
      hint: `register it: \`keelson provider add ${unavailableDefaultProviderId}\``,
    };
  }

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
      ...result.fallbackNodes.map(({ nodeId, to }) => `${nodeId} falls back to ${to}`),
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

export async function runWorkflowResolutionCheck(
  deps: WorkflowResolutionDeps = {},
): Promise<CategoryResult> {
  const discover = deps.discoverWorkflows ?? defaultDiscoverWorkflows;
  const roots: readonly DiscoveryRoot[] = deps.workflowsDir
    ? [{ dir: deps.workflowsDir, source: "global" }]
    : workflowDiscoveryRoots();
  const discovery = discover(roots);
  const config = (deps.loadConfig ?? defaultLoadConfig)();
  const providerInfos = await (deps.listProviders ?? defaultListProviders)();
  const providerIds = providerInfos.map(({ id }) => id);
  const envProviderId = (deps.envProviderId ?? process.env.KEELSON_WORKFLOW_PROVIDER)?.trim();
  const defaultProviderId =
    deps.defaultProviderId ?? (envProviderId || resolveDefaultProvider(config, providerIds));
  const unavailableDefaultProviderId =
    deps.defaultProviderId === undefined && envProviderId && !providerIds.includes(envProviderId)
      ? envProviderId
      : undefined;
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
  const checks = resolutions.map((resolution) =>
    resolutionCheck(resolution, unavailableDefaultProviderId),
  );

  for (const { id, capabilities } of providerInfos) {
    if (id === "workflow") continue;
    const override = readModelClassOverride(config, id);
    const classes = (["fast", "balanced", "deep"] as const).map(
      (cls) => override?.[cls] ?? capabilities.modelClasses?.[cls] ?? capabilities.defaultModel,
    );
    if (classes[0] && classes.every((model) => model === classes[0])) {
      checks.push({
        name: `${id} model classes`,
        status: "warn",
        detail:
          classes[0] === "auto"
            ? "fast, balanced, and deep all request auto routing; the served model may differ between turns"
            : `fast, balanced, and deep all request '${classes[0]}'`,
        hint: config.gateways?.some(({ name }) => name === id)
          ? `set distinct gateways[].modelClasses entries for '${id}' in config.json`
          : `set distinct ${id}.modelClasses entries in config.json`,
      });
    }
  }

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

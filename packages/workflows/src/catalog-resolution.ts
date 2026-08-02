import { diagnoseModelDiversity } from "./model-diversity.ts";
import type { WorkflowDefinition } from "./schema/index.ts";

type ModelClass = "fast" | "balanced" | "deep";

interface ProviderCapabilities {
  defaultModel: string;
  models: readonly string[];
  modelClasses?: Record<ModelClass, string>;
}

interface ResolutionOptions {
  providers: ReadonlyMap<string, ProviderCapabilities>;
  defaultProviderId?: string;
  runProviderId?: string;
  modelClassOverride?: (providerId: string, modelClass: ModelClass) => string | undefined;
}

interface PromptResolution {
  nodeId: string;
  preferredProvider: string | undefined;
  effectiveProvider: string | undefined;
  model: string | undefined;
  providerFellBack: boolean;
  modelFellBack: boolean;
}

export interface WorkflowResolution {
  name: string;
  tier: "native" | "degrades" | "blocked";
  nodes: PromptResolution[];
  fallbackNodes: Array<{ nodeId: string; to: string }>;
  collapses: string[];
}

const MODEL_CLASSES = new Set<ModelClass>(["fast", "balanced", "deep"]);

function isModelClass(value: string): value is ModelClass {
  return MODEL_CLASSES.has(value as ModelClass);
}

function resolvePrompt(
  workflow: WorkflowDefinition,
  node: WorkflowDefinition["nodes"][number],
  options: ResolutionOptions,
): PromptResolution {
  const pinnedProvider = node.provider ?? workflow.provider;
  const preferredProvider =
    pinnedProvider !== undefined && options.providers.has(pinnedProvider)
      ? pinnedProvider
      : options.defaultProviderId;
  const effectiveProvider = options.runProviderId ?? preferredProvider;
  const modelProvider = pinnedProvider ?? preferredProvider;
  const capabilities =
    effectiveProvider === undefined ? undefined : options.providers.get(effectiveProvider);
  let model = node.model ?? workflow.model;
  let modelFellBack = false;

  // Keep this order aligned with the prompt handler's provider/model resolution path.
  const perProviderModel =
    effectiveProvider === undefined ? undefined : node.model_by_provider?.[effectiveProvider];
  if (perProviderModel !== undefined && perProviderModel.length > 0) {
    model = perProviderModel;
  } else if (model !== undefined && isModelClass(model)) {
    model =
      (effectiveProvider === undefined
        ? undefined
        : options.modelClassOverride?.(effectiveProvider, model)) ??
      capabilities?.modelClasses?.[model] ??
      capabilities?.defaultModel;
  }
  if (model === "auto") {
    model = capabilities?.defaultModel ?? model;
  }
  if (
    effectiveProvider !== modelProvider &&
    model !== undefined &&
    model.length > 0 &&
    capabilities !== undefined &&
    capabilities.models.length > 0 &&
    !capabilities.models.includes(model)
  ) {
    model = capabilities.defaultModel;
    modelFellBack = true;
  }
  if (model === undefined && capabilities?.defaultModel.length) {
    model = capabilities.defaultModel;
  }

  return {
    nodeId: node.id,
    preferredProvider,
    effectiveProvider,
    model,
    providerFellBack:
      pinnedProvider !== undefined && effectiveProvider !== pinnedProvider,
    modelFellBack,
  };
}

export function resolveWorkflowResolution(
  workflow: WorkflowDefinition,
  options: ResolutionOptions,
): WorkflowResolution {
  const nodes = workflow.nodes
    .filter((node) => node.prompt !== undefined)
    .map((node) => resolvePrompt(workflow, node, options));
  const collapses = diagnoseModelDiversity(
    workflow,
    options.defaultProviderId,
    options.runProviderId,
  );
  const fallbackNodes = nodes
    .filter((node) => node.providerFellBack || node.modelFellBack)
    .map((node) => ({
      nodeId: node.nodeId,
      to: `${node.effectiveProvider ?? "none"}/${node.model ?? "default"}`,
    }));
  const tier =
    nodes.length > 0 && nodes.every((node) => node.effectiveProvider === undefined)
      ? "blocked"
      : fallbackNodes.length > 0 || collapses.length > 0
        ? "degrades"
        : "native";

  return {
    name: workflow.name,
    tier,
    nodes,
    fallbackNodes,
    collapses,
  };
}

export function resolveWorkflowCatalog(
  workflows: readonly WorkflowDefinition[],
  options: ResolutionOptions,
): WorkflowResolution[] {
  return workflows.map((workflow) => resolveWorkflowResolution(workflow, options));
}

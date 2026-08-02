import type { WorkflowDefinition } from "./schema/index.ts";

interface DiversityCandidate {
  nodeId: string;
  provider: string;
  model: string;
  modelsByProvider: Readonly<Record<string, string>>;
}

export function diagnoseModelDiversity(
  workflow: WorkflowDefinition,
  defaultProviderId?: string,
  providerOverride?: string,
): string[] {
  const groups = new Map<string, DiversityCandidate[]>();

  for (const node of workflow.nodes) {
    if (node.prompt === undefined) continue;

    const model = node.model ?? workflow.model;
    const provider = providerOverride ?? node.provider ?? workflow.provider ?? defaultProviderId;
    const modelsByProvider = node.model_by_provider;
    if (
      model === undefined ||
      provider === undefined ||
      modelsByProvider === undefined ||
      Object.keys(modelsByProvider).length === 0 ||
      modelsByProvider[provider] !== undefined
    ) {
      continue;
    }

    const candidate: DiversityCandidate = {
      nodeId: node.id,
      provider,
      model,
      modelsByProvider,
    };
    const key = JSON.stringify([provider, model]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }

  const messages: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mappedModelsByProvider = new Map<string, Set<string>>();
    for (const candidate of group) {
      for (const [mappedProvider, mappedModel] of Object.entries(candidate.modelsByProvider)) {
        const mappedModels = mappedModelsByProvider.get(mappedProvider);
        if (mappedModels === undefined) {
          mappedModelsByProvider.set(mappedProvider, new Set([mappedModel]));
        } else {
          mappedModels.add(mappedModel);
        }
      }
    }
    if (![...mappedModelsByProvider.values()].some((models) => models.size > 1)) continue;

    const { provider, model } = group[0]!;
    const nodeIds = group.map((candidate) => candidate.nodeId).join(", ");
    messages.push(
      `${workflow.name}: no '${provider}' entry in model_by_provider for nodes ${nodeIds} -- all resolve to '${model}'; lens/role diversity collapsed on this provider.`,
    );
  }
  return messages;
}

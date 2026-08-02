import type { WorkflowDefinition } from "./schema/index.ts";

interface DiversityCandidate {
  nodeId: string;
  provider: string;
  model: string;
  mappedModels: string[];
}

export function diagnoseModelDiversity(
  workflow: WorkflowDefinition,
  defaultProviderId?: string,
): string[] {
  const groups = new Map<string, DiversityCandidate[]>();

  for (const node of workflow.nodes) {
    if (node.prompt === undefined || node.model === undefined) continue;

    const provider = node.provider ?? workflow.provider ?? defaultProviderId;
    const modelsByProvider = node.model_by_provider;
    if (
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
      model: node.model,
      mappedModels: Object.values(modelsByProvider),
    };
    const key = JSON.stringify([provider, node.model]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }

  const messages: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mappedModels = new Set(group.flatMap((candidate) => candidate.mappedModels));
    if (mappedModels.size < 2) continue;

    const { provider, model } = group[0]!;
    const nodeIds = group.map((candidate) => candidate.nodeId).join(", ");
    messages.push(
      `${workflow.name}: no '${provider}' entry in model_by_provider for nodes ${nodeIds} -- all resolve to '${model}'; lens/role diversity collapsed on this provider.`,
    );
  }
  return messages;
}

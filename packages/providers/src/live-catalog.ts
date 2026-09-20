import { getAgentProvider, isRegisteredProvider } from "./registry.ts";
import type { ModelInfo } from "./types.ts";

export async function fetchLiveModelCatalog(
  ids: Iterable<string>,
): Promise<Map<string, ModelInfo[] | null>> {
  const entries = await Promise.all(
    [...new Set(ids)].map(async (id) => {
      if (!isRegisteredProvider(id)) return [id, null] as const;
      try {
        const provider = getAgentProvider(id);
        const models =
          provider.listModelsLive !== undefined
            ? await provider.listModelsLive()
            : await provider.listModels();
        return [id, models] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return new Map(entries);
}

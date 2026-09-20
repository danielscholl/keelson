import { getAgentProvider, isRegisteredProvider } from "./registry.ts";
import type { ModelInfo } from "./types.ts";

export async function fetchLiveModelCatalog(
  ids: Iterable<string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Map<string, ModelInfo[] | null>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const entries = await Promise.all(
    [...new Set(ids)].map(async (id) => {
      if (!isRegisteredProvider(id)) return [id, null] as const;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        options.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([options.signal, timeoutSignal]);
      const aborted = new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      try {
        const provider = getAgentProvider(id);
        const request =
          provider.listModelsLive !== undefined
            ? provider.listModelsLive(signal)
            : provider.listModels();
        const models = await Promise.race([request, aborted]);
        return [id, models] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return new Map(entries);
}

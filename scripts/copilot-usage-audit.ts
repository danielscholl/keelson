// Runs real Copilot turns through Keelson's CopilotProvider and compares what
// Keelson records (tokens and estimated cost) with the raw per-call SDK usage,
// including GitHub's own billed cost (copilotUsage.totalNanoAiu).
//
//   bun scripts/copilot-usage-audit.ts [model ...] > audit.json
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClientFactory, CopilotProvider } from "@keelson/providers";
import { estimateCostUsd, type ModelPrice } from "@keelson/shared";

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "claude-sonnet-5.5", "claude-opus-5.5"];

type Raw = Record<string, unknown> & { agentId?: string };
const rawEvents: Raw[] = [];

// Tap every session the provider opens so each assistant.usage /
// session.compaction_complete event is recorded alongside the provider's own handler.
function tapSession<S extends { on: (...a: unknown[]) => unknown }>(session: S): S {
  for (const type of ["assistant.usage", "session.compaction_complete", "session.shutdown"]) {
    session.on(type, (event: unknown) => rawEvents.push({ type, ...(event as object) } as Raw));
  }
  return session;
}

const factory = new CopilotClientFactory({
  sdkLoader: async () => {
    const sdk = (await import("@github/copilot-sdk")) as Record<string, unknown>;
    const Base = sdk.CopilotClient as new (o: unknown) => Record<string, unknown>;
    class TappedClient extends (Base as new (o: unknown) => object) {
      // biome-ignore lint/suspicious/noExplicitAny: SDK shape is structural here
      async createSession(config?: unknown): Promise<any> {
        // biome-ignore lint/suspicious/noExplicitAny: calling through to the SDK
        return tapSession(await (Base.prototype as any).createSession.call(this, config));
      }
      // biome-ignore lint/suspicious/noExplicitAny: SDK shape is structural here
      async resumeSession(id: string, config?: unknown): Promise<any> {
        // biome-ignore lint/suspicious/noExplicitAny: calling through to the SDK
        return tapSession(await (Base.prototype as any).resumeSession.call(this, id, config));
      }
    }
    return { ...sdk, CopilotClient: TappedClient } as never;
  },
});

const provider = new CopilotProvider({ getCredential: async () => undefined, clientFactory: factory });
await provider.listModels();
const prices = provider.modelPrices() ?? {};

const cwd = mkdtempSync(join(tmpdir(), "copilot-audit-"));
const filler = Array.from(
  { length: 400 },
  (_, i) => `Line ${i}: the harbor log records vessel ${i * 7} arriving at berth ${i % 13}.`,
).join("\n");
writeFileSync(join(cwd, "notes.txt"), `${filler}\nThe secret word is lighthouse.\n`);

const TURNS = [
  `Here is a log you will need later. Reply only "ok".\n\n${filler}`,
  "Which berth did vessel 70 arrive at? One line.",
  "Read notes.txt in the current directory with your tools and tell me the secret word. One line.",
];

function num(e: Raw, k: string): number {
  const v = (e.data as Record<string, unknown> | undefined)?.[k] ?? e[k];
  return typeof v === "number" ? v : 0;
}
function nanoAiu(e: Raw): number {
  const d = (e.data ?? e) as Record<string, unknown>;
  const cu = d.copilotUsage as { totalNanoAiu?: number } | undefined;
  return cu?.totalNanoAiu ?? 0;
}

const report: unknown[] = [];
for (const model of MODELS) {
  let sessionId: string | undefined;
  for (const [i, prompt] of TURNS.entries()) {
    const start = rawEvents.length;
    // biome-ignore lint/suspicious/noExplicitAny: usage chunk shape
    let usage: any;
    let error: string | undefined;
    try {
      for await (const chunk of provider.sendQuery(prompt, cwd, sessionId, {
        model,
        onSessionId: (id: string) => {
          sessionId = id;
        },
      } as never)) {
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "error") error = chunk.message;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const calls = rawEvents.slice(start).filter((e) => e.type === "assistant.usage");
    const other = rawEvents.slice(start).filter((e) => e.type !== "assistant.usage");
    const raw = {
      calls: calls.length,
      subAgentCalls: calls.filter((e) => e.agentId !== undefined).length,
      models: [...new Set(calls.map((e) => (e.data as { model?: string } | undefined)?.model))],
      inputTokens: calls.reduce((s, e) => s + num(e, "inputTokens"), 0),
      outputTokens: calls.reduce((s, e) => s + num(e, "outputTokens"), 0),
      cacheReadTokens: calls.reduce((s, e) => s + num(e, "cacheReadTokens"), 0),
      cacheWriteTokens: calls.reduce((s, e) => s + num(e, "cacheWriteTokens"), 0),
      reasoningTokens: calls.reduce((s, e) => s + num(e, "reasoningTokens"), 0),
      billedNanoAiu: calls.reduce((s, e) => s + nanoAiu(e), 0),
      otherEvents: other.map((e) => e.type),
    };
    const price: ModelPrice | undefined = prices[model];
    const keelsonCostUsd =
      usage && price
        ? estimateCostUsd(
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              cacheWriteTokens: usage.cacheCreationInputTokens,
            },
            price,
          )
        : null;
    report.push({
      model,
      turn: i + 1,
      error,
      keelson: usage ?? null,
      keelsonCostUsd,
      raw,
      price: price ?? null,
      firstRawCall: calls[0] ?? null,
    });
    console.error(
      `${model} turn ${i + 1}: keelson $${keelsonCostUsd?.toFixed(5) ?? "?"} vs billed ${raw.billedNanoAiu} nAIU`,
    );
  }
}
await provider.dispose?.();
console.log(JSON.stringify(report, null, 2));

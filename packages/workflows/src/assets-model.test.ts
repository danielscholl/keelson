// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import type { NodeContext, NodeResult, NodeStreamEvent } from "./executor.ts";
import {
  makePromptHandler,
  type PromptHandlerProvider,
  type PromptHandlerSendOptions,
} from "./handlers/prompt.ts";
import { parseWorkflow } from "./loader.ts";
import { diagnoseModelDiversity } from "./model-diversity.ts";
import type { DagNode, WorkflowDefinition } from "./schema/index.ts";

const MODEL_TIERS = new Set(["fast", "balanced", "deep"]);
const MIGRATED_WORKFLOWS = new Set([
  "adversarial-review",
  "fix-issue",
  "interactive-prd",
  "plan-act-evaluate",
  "pr-review",
  "resolve-pr",
  "workflow-builder",
]);
const EXPECTED_PROVIDER_PINS = new Map([["adversarial-review", "copilot"]]);
const COPILOT_CAPABILITIES = {
  defaultModel: "auto",
  reasoningEffort: true,
  models: ["auto"],
  modelClasses: { fast: "auto", balanced: "auto", deep: "auto" },
} as const;
const CLAUDE_CAPABILITIES = {
  defaultModel: "claude-opus-4-8",
  reasoningEffort: false,
  models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  modelClasses: {
    fast: "claude-haiku-4-5",
    balanced: "claude-opus-4-8",
    deep: "claude-fable-5",
  },
} as const;
const CLAUDE_MODELS: ReadonlySet<string> = new Set(CLAUDE_CAPABILITIES.models);

type PromptCapabilities = ReturnType<NonNullable<PromptHandlerProvider["getCapabilities"]>>;

function makeProviderHarness(
  providerId: string,
  capabilities: PromptCapabilities,
  response = "ok",
): {
  handler: ReturnType<typeof makePromptHandler>;
  calls: PromptHandlerSendOptions[];
} {
  const calls: PromptHandlerSendOptions[] = [];
  const provider: PromptHandlerProvider = {
    getType: () => providerId,
    getCapabilities: () => capabilities,
    async *sendQuery(_prompt, _cwd, _resumeSessionId, options) {
      calls.push(options ?? {});
      yield { type: "text", content: response };
      yield { type: "done" };
    },
  };
  return {
    handler: makePromptHandler({
      getProvider: () => provider,
      resolveProviderId: () => providerId,
      getRegisteredTools: () => [],
    }),
    calls,
  };
}

async function runPromptNode(
  workflow: WorkflowDefinition,
  node: DagNode,
  handler: ReturnType<typeof makePromptHandler>,
  providerOverride?: string,
): Promise<{ result: NodeResult; events: NodeStreamEvent[] }> {
  const events: NodeStreamEvent[] = [];
  const body = node.prompt ?? "";
  const context: NodeContext = {
    runId: `model-test-${node.id}`,
    nodeId: node.id,
    inputs: {},
    upstreamOutputs: new Map(),
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    emit: (event) => events.push(event),
    resolvedBody: body,
    rawBody: body,
    workflow,
    ...(providerOverride !== undefined ? { providerOverride } : {}),
  };
  return { result: await handler.handle(node, context), events };
}

function bareConcreteModelIds(
  workflow: WorkflowDefinition,
): Array<{ nodeId: string; model: string }> {
  const findings: Array<{ nodeId: string; model: string }> = [];
  if (workflow.model !== undefined && !MODEL_TIERS.has(workflow.model)) {
    findings.push({ nodeId: "<workflow>", model: workflow.model });
  }
  for (const node of workflow.nodes) {
    if (node.prompt !== undefined && node.model !== undefined && !MODEL_TIERS.has(node.model)) {
      findings.push({ nodeId: node.id, model: node.model });
    }
  }
  return findings;
}

function loadBundledWorkflows(): Array<{ filename: string; workflow: WorkflowDefinition }> {
  const dir = path.join(import.meta.dir, "../assets/workflows");
  const filenames = fs
    .readdirSync(dir)
    .filter((filename) => /\.ya?ml$/.test(filename))
    .sort();

  return filenames.map((filename) => {
    const filePath = path.join(dir, filename);
    const result = parseWorkflow(fs.readFileSync(filePath, "utf8"), filePath);
    if (result.error !== null || result.workflow === null) {
      throw new Error(`${filename}: ${result.error?.error ?? "workflow missing"}`);
    }
    return { filename, workflow: result.workflow };
  });
}

describe("bundled workflow model policy", () => {
  test("uses portable tiers and only soft provider pins", () => {
    const violations: string[] = [];
    for (const { filename, workflow } of loadBundledWorkflows()) {
      for (const finding of bareConcreteModelIds(workflow)) {
        violations.push(`${filename}:${finding.nodeId} uses model '${finding.model}'`);
      }
      const expectedProvider = EXPECTED_PROVIDER_PINS.get(workflow.name);
      if (workflow.provider !== expectedProvider) {
        violations.push(
          `${filename}:<workflow> provider is '${workflow.provider}' instead of '${expectedProvider}'`,
        );
      }
      if (workflow.provider_required === true) {
        violations.push(
          `${filename}:<workflow> hard-requires provider '${workflow.provider ?? "<unspecified>"}'`,
        );
      }
      if (workflow.model === "auto") {
        violations.push(`${filename}:<workflow> uses model 'auto'`);
      }
      for (const node of workflow.nodes) {
        if ("model" in node && node.model === "auto") {
          violations.push(`${filename}:${node.id} uses model 'auto'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("flags a bare concrete prompt model", () => {
    const result = parseWorkflow(
      `
name: pinned-model
description: exercises the bundled asset model guard
nodes:
  - id: review
    prompt: Review the change.
    model: gpt-5.6-sol
`,
      "pinned-model.yaml",
    );

    expect(result.error).toBeNull();
    expect(bareConcreteModelIds(result.workflow!)).toEqual([
      { nodeId: "review", model: "gpt-5.6-sol" },
    ]);
  });
});

describe("bundled workflow model resolution", () => {
  test("preserves every migrated prompt node's Copilot model and effort", async () => {
    const { handler } = makeProviderHarness("copilot", COPILOT_CAPABILITIES);
    const violations: string[] = [];

    for (const { filename, workflow } of loadBundledWorkflows()) {
      if (!MIGRATED_WORKFLOWS.has(workflow.name)) continue;
      for (const node of workflow.nodes) {
        if (node.prompt === undefined) continue;
        const { result, events } = await runPromptNode(workflow, node, handler);
        const expectedModel = node.model_by_provider?.copilot ?? "auto";
        const expectedEffort = node.effort ?? workflow.effort;
        if (result.model !== expectedModel) {
          violations.push(
            `${filename}:${node.id} resolved '${result.model}' instead of '${expectedModel}'`,
          );
        }
        if (result.effort !== expectedEffort) {
          violations.push(
            `${filename}:${node.id} kept effort '${result.effort}' instead of '${expectedEffort}'`,
          );
        }
        if (
          events.some(
            (event) =>
              event.type === "node_warning" && event.message.includes("is not in provider"),
          )
        ) {
          violations.push(`${filename}:${node.id} emitted a provider catalog warning`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("resolves fix-issue entirely within the Claude catalog", async () => {
    const { handler } = makeProviderHarness("claude", CLAUDE_CAPABILITIES);
    const violations: string[] = [];

    for (const { filename, workflow } of loadBundledWorkflows()) {
      if (workflow.name !== "fix-issue") continue;
      for (const node of workflow.nodes) {
        if (node.prompt === undefined) continue;
        const { result, events } = await runPromptNode(workflow, node, handler);
        if (result.model === undefined || !CLAUDE_MODELS.has(result.model)) {
          violations.push(`${filename}:${node.id} resolved outside the Claude catalog`);
        }
        if (
          events.some(
            (event) =>
              event.type === "node_warning" && event.message.includes("is not in provider"),
          )
        ) {
          violations.push(`${filename}:${node.id} emitted a provider catalog warning`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("runs adversarial-review on Claude with a diversity-collapse notice", async () => {
    const adversarial = loadBundledWorkflows().find(
      ({ workflow }) => workflow.name === "adversarial-review",
    )?.workflow;
    expect(adversarial).toBeDefined();

    const { handler, calls } = makeProviderHarness("claude", CLAUDE_CAPABILITIES, "{}");
    const violations: string[] = [];
    const promptNodes = adversarial!.nodes.filter((node) => node.prompt !== undefined);
    for (const node of promptNodes) {
      const { result, events } = await runPromptNode(adversarial!, node, handler, "claude");
      if (result.status !== "succeeded") {
        violations.push(`${node.id} failed: ${result.error ?? "unknown error"}`);
      }
      if (result.provider !== "claude") {
        violations.push(`${node.id} resolved provider '${result.provider}'`);
      }
      if (result.model === undefined || !CLAUDE_MODELS.has(result.model)) {
        violations.push(`${node.id} resolved outside the Claude catalog`);
      }
      if (
        events.some(
          (event) => event.type === "node_warning" && event.message.includes("is not in provider"),
        )
      ) {
        violations.push(`${node.id} emitted a provider catalog warning`);
      }
    }

    expect(violations).toEqual([]);
    expect(calls).toHaveLength(promptNodes.length);

    const claudeMessages = diagnoseModelDiversity(adversarial!, undefined, "claude");
    expect(
      claudeMessages.some((message) =>
        ["reviewer-logic", "reviewer-evidence", "reviewer-risk"].every((id) =>
          message.includes(id),
        ),
      ),
    ).toBe(true);
    expect(diagnoseModelDiversity(adversarial!, undefined, "copilot")).toEqual([]);
  });
});

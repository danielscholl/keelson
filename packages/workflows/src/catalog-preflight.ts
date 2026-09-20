import { resolveWorkflowResolution } from "./catalog-resolution.ts";
import type { WorkflowDefinition } from "./schema/index.ts";

type ModelClass = "fast" | "balanced" | "deep";

interface ProviderCapabilities {
  defaultModel: string;
  models: readonly string[];
  modelClasses?: Record<ModelClass, string>;
}

export interface PreflightModel {
  id: string;
  supportedReasoningEfforts?: readonly string[];
}

export type LiveCatalog = ReadonlyMap<string, readonly PreflightModel[] | null>;

export interface PreflightViolation {
  nodeId: string;
  provider: string;
  kind: "model" | "effort";
  value: string;
  reason: string;
}

export interface PreflightResult {
  violations: PreflightViolation[];
  notChecked: string[];
}

export interface PreflightOptions {
  providers: ReadonlyMap<string, ProviderCapabilities>;
  defaultProviderId?: string;
  runProviderId?: string;
  modelClassOverride?: (providerId: string, modelClass: ModelClass) => string | undefined;
  liveCatalog: LiveCatalog;
}

const MODEL_CLASSES = new Set(["fast", "balanced", "deep"]);
const EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

type Effort = (typeof EFFORTS)[number];

function isConcreteModel(value: string | undefined): value is string {
  return value !== undefined && value !== "auto" && !MODEL_CLASSES.has(value);
}

function normalizeEffort(value: unknown): Effort | undefined {
  if (typeof value !== "string") return undefined;
  const level = value === "max" ? "xhigh" : value;
  return EFFORTS.includes(level as Effort) ? (level as Effort) : undefined;
}

function pinnedLiteralFor(
  node: WorkflowDefinition["nodes"][number],
  workflow: WorkflowDefinition,
  provider: string,
): string | undefined {
  const perProvider = node.model_by_provider?.[provider];
  if (perProvider !== undefined) return perProvider;
  if (node.model !== undefined) return isConcreteModel(node.model) ? node.model : undefined;
  return isConcreteModel(workflow.model) ? workflow.model : undefined;
}

export function checkWorkflowCatalog(
  workflow: WorkflowDefinition,
  options: PreflightOptions,
): PreflightResult {
  const resolution = resolveWorkflowResolution(workflow, options);
  const promptNodes = new Map(
    workflow.nodes.filter((node) => node.prompt !== undefined).map((node) => [node.id, node]),
  );
  const violations: PreflightViolation[] = [];
  const notChecked = new Set<string>();

  for (const resolved of resolution.nodes) {
    const provider = resolved.effectiveProvider;
    const node = promptNodes.get(resolved.nodeId);
    if (provider === undefined || node === undefined) continue;

    const live = options.liveCatalog.get(provider);
    if (live === null || live === undefined) {
      notChecked.add(provider);
      continue;
    }

    const literal = pinnedLiteralFor(node, workflow, provider);
    if (literal !== undefined && !live.some((model) => model.id === literal)) {
      violations.push({
        nodeId: node.id,
        provider,
        kind: "model",
        value: literal,
        reason: `model '${literal}' is not in ${provider}'s live catalog`,
      });
    }

    const rawEffort = node.effort ?? workflow.effort;
    const effort = normalizeEffort(rawEffort);
    if (effort === undefined) continue;

    const modelId = literal ?? resolved.model;
    const model = live.find((candidate) => candidate.id === modelId);
    const supported = model?.supportedReasoningEfforts;
    // An absent or empty effort list is not evidence that the requested effort is invalid.
    if (supported === undefined || supported.length === 0) continue;
    if (!supported.includes(effort)) {
      violations.push({
        nodeId: node.id,
        provider,
        kind: "effort",
        value: String(rawEffort),
        reason: `effort '${String(rawEffort)}' exceeds ${provider}/${modelId} (supports ${supported.join(", ")})`,
      });
    }
  }

  return { violations, notChecked: [...notChecked].sort() };
}

export function formatPreflightViolations(result: PreflightResult): string {
  const lines = result.violations.map((violation) => `- ${violation.nodeId}: ${violation.reason}`);
  if (result.notChecked.length > 0) {
    lines.push(`not checked: ${[...result.notChecked].sort().join(", ")}`);
  }
  return lines.join("\n");
}

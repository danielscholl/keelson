import { resolveWorkflowResolution } from "./catalog-resolution.ts";
import { applyModelCase } from "./model-by.ts";
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
  // Set when the violation came from one branch of a `model_by` map rather than
  // the node's static pin, so the message can name the branch to fix.
  caseKey?: string;
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

    // Every branch is checked, not just the one this run would take: which case
    // wins is run data, so a typo in a cold branch is only catchable here. The
    // branch is applied to the node first, because a case sets only the fields it
    // names and `model_by_provider` still outranks a case's plain `model`.
    if (node.model_by !== undefined) {
      for (const [caseKey, branch] of Object.entries(node.model_by.cases)) {
        const dispatched = applyModelCase(node, branch) as typeof node;
        const caseLiteral = pinnedLiteralFor(dispatched, workflow, provider);
        // A branch naming no model of its own runs on the node's resolved model,
        // so its effort is judged against that. A branch naming a model class is
        // left alone, the same way the static path leaves one alone.
        const branchNamesModel =
          branch.model !== undefined || branch.model_by_provider?.[provider] !== undefined;
        const effectiveModel = caseLiteral ?? (branchNamesModel ? undefined : resolved.model);
        const listed =
          effectiveModel === undefined
            ? undefined
            : live.find((candidate) => candidate.id === effectiveModel);
        if (caseLiteral !== undefined && live.every((c) => c.id !== caseLiteral)) {
          violations.push({
            nodeId: node.id,
            provider,
            kind: "model",
            value: caseLiteral,
            reason: `model '${caseLiteral}' (model_by case '${caseKey}') is not in ${provider}'s live catalog`,
            caseKey,
          });
          continue;
        }
        const caseEffort = normalizeEffort(dispatched.effort ?? workflow.effort);
        const caseSupported = listed?.supportedReasoningEfforts;
        if (caseEffort === undefined || caseSupported === undefined || caseSupported.length === 0) {
          continue;
        }
        if (!caseSupported.includes(caseEffort)) {
          violations.push({
            nodeId: node.id,
            provider,
            kind: "effort",
            value: caseEffort,
            reason: `effort '${caseEffort}' (model_by case '${caseKey}') exceeds ${provider}/${effectiveModel} (supports ${caseSupported.join(", ")})`,
            caseKey,
          });
        }
      }
      // Every dispatch goes through a case, so the node's own model/effort are
      // only reachable via a case that leaves them in place, which the loop
      // above already evaluated.
      continue;
    }

    const literal = pinnedLiteralFor(node, workflow, provider);
    if (
      literal !== undefined &&
      literal === resolved.model &&
      !live.some((model) => model.id === literal)
    ) {
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

    const modelId = resolved.model;
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

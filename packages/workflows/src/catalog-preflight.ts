import { resolvePrompt, resolveWorkflowResolution } from "./catalog-resolution.ts";
import { applyModelCase } from "./model-by.ts";
import { nodeReachesProvider, type WorkflowDefinition } from "./schema/index.ts";

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

interface PinnedLiteral {
  literal: string;
  classKey?: ModelClass;
}

function pinnedLiteralFor(
  node: WorkflowDefinition["nodes"][number],
  workflow: WorkflowDefinition,
  provider: string,
  modelClassOverride: PreflightOptions["modelClassOverride"],
): PinnedLiteral | undefined {
  const perProvider = node.model_by_provider?.[provider];
  if (perProvider !== undefined) return { literal: perProvider };
  const model = node.model ?? workflow.model;
  if (model === undefined) return undefined;
  if (isConcreteModel(model)) return { literal: model };
  if (MODEL_CLASSES.has(model)) {
    const overridden = modelClassOverride?.(provider, model as ModelClass);
    return overridden === undefined
      ? undefined
      : { literal: overridden, classKey: model as ModelClass };
  }
  return undefined;
}

export function checkWorkflowCatalog(
  workflow: WorkflowDefinition,
  options: PreflightOptions,
): PreflightResult {
  const resolution = resolveWorkflowResolution(workflow, options);
  const providerNodes = new Map(
    workflow.nodes.filter(nodeReachesProvider).map((node) => [node.id, node]),
  );
  const violations: PreflightViolation[] = [];
  const notChecked = new Set<string>();

  for (const resolved of resolution.nodes) {
    const provider = resolved.effectiveProvider;
    const node = providerNodes.get(resolved.nodeId);
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
        const casePinned = pinnedLiteralFor(
          dispatched,
          workflow,
          provider,
          options.modelClassOverride,
        );
        // Resolved from the dispatched node, not the original: a case replaces the
        // whole `model_by_provider` map, so the node's resolution can name a pin
        // the case just removed.
        const effectiveModel = resolvePrompt(workflow, dispatched, options).model;
        const listed =
          effectiveModel === undefined
            ? undefined
            : live.find((candidate) => candidate.id === effectiveModel);
        if (
          casePinned !== undefined &&
          casePinned.literal === effectiveModel &&
          live.every((c) => c.id !== casePinned.literal)
        ) {
          violations.push({
            nodeId: node.id,
            provider,
            kind: "model",
            value: casePinned.literal,
            reason:
              casePinned.classKey === undefined
                ? `model '${casePinned.literal}' (model_by case '${caseKey}') is not in ${provider}'s live catalog`
                : `model class '${casePinned.classKey}' (model_by case '${caseKey}') resolves via config.json modelClasses to '${casePinned.literal}', which is not in ${provider}'s live catalog`,
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

    const pinned = pinnedLiteralFor(node, workflow, provider, options.modelClassOverride);
    if (
      pinned !== undefined &&
      pinned.literal === resolved.model &&
      !live.some((model) => model.id === pinned.literal)
    ) {
      violations.push({
        nodeId: node.id,
        provider,
        kind: "model",
        value: pinned.literal,
        reason:
          pinned.classKey === undefined
            ? `model '${pinned.literal}' is not in ${provider}'s live catalog`
            : `model class '${pinned.classKey}' resolves via config.json modelClasses to '${pinned.literal}', which is not in ${provider}'s live catalog`,
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

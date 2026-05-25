/**
 * Workflow loader — discovers and parses workflow YAML files.
 *
 * - Warnings are returned as data on `WorkflowLoadResult.warnings` so the
 *   caller (CLI, server) renders them.
 * - Provider validation accepts `claude` (or omitted) by default. Other
 *   providers can be wired by the server's prompt handler.
 * - `WorkflowLoadWarning` channel surfaces the "Adapted" / "Ignored"
 *   compatibility tiers (e.g. `hooks`, `agents`, `sandbox`, `script`).
 * - Discovery walks bundled defaults plus `<repo>/.keelson/workflows/`.
 *
 * Validation invariants:
 * - YAML parse via `Bun.YAML.parse`
 * - Mutual exclusivity, command-name validation, retry/loop rules → from
 *   `dagNodeSchema.safeParse`
 * - DAG shape (duplicate ids, unknown deps, cycles) → `validateDagShape`
 *   in `./graph.ts`
 * - Cross-node `$nodeId.output` reference validation
 * - Reject legacy `steps:` workflows
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { parse as parseYamlString } from "yaml";
import type { z } from "zod";
import { validateDagShape } from "./graph.ts";
import {
  BASH_NODE_AI_FIELDS,
  type DagNode,
  dagNodeSchema,
  isApprovalNode,
  isCancelNode,
  isLoopNode,
  isScriptNode,
  LOOP_NODE_AI_FIELDS,
  modelReasoningEffortSchema,
  SCRIPT_NODE_AI_FIELDS,
  type WorkflowDefinition,
  type WorkflowLoadError,
  type WorkflowLoadResult,
  type WorkflowSource,
  type WorkflowWithSource,
  webSearchModeSchema,
} from "./schema/index.ts";

/**
 * Non-fatal warning from the loader. Distinct from `WorkflowLoadError` (which
 * causes the workflow to be dropped). Warnings are surfaced by the slash
 * command on first run of a workflow, then suppressed.
 */
export interface WorkflowLoadWarning {
  readonly filename: string;
  readonly nodeId?: string;
  readonly kind:
    | "ai_fields_on_non_ai_node"
    | "ignored_capability"
    | "invalid_field_value"
    | "interactive_loop_in_non_interactive_workflow"
    // Slice 4 — fields the schema accepts and the executor *can* honor,
    // but only when paired with the claude provider. Emitted at load
    // time so the warning surfaces even if the workflow never runs.
    | "provider_specific_capability";
  readonly message: string;
}

/**
 * Per-node fields that Keelson runtime does NOT honor at all
 * (warned on every node where they appear). The schema accepts them for
 * cross-runtime portability.
 *
 * Worktree integration, hooks, sandbox, MCP, inline agents, betas, fallback
 * model, max-budget, output-format JSON-schema validation, and script nodes
 * are tracked for future releases. Until those land, the loader
 * surfaces the warning and `--strict` refuses workflows that depend on them
 * so users aren't silently misled by the README's compatibility table.
 */
const IGNORED_FIELDS_PER_NODE: readonly string[] = [
  "agents",
  "sandbox",
  "betas",
  "fallbackModel",
  "maxBudgetUsd",
  "mcp",
  "skills",
  "output_format",
];

// Per-node fields the runtime honors ONLY when the claude provider is the
// active workflow provider. Surfaced as a `provider_specific_capability`
// warning so authors know an architect-style workflow won't enforce these
// rails under stub/copilot.
const CLAUDE_ONLY_FIELDS_PER_NODE: readonly string[] = ["allowed_tools", "denied_tools", "hooks"];

const IGNORED_FIELDS_WORKFLOW: readonly string[] = [
  "sandbox",
  "betas",
  "fallbackModel",
  "additionalDirectories",
  "mutates_checkout",
];

// ---------------------------------------------------------------------------
// YAML parse + raw shape utilities
// ---------------------------------------------------------------------------

function parseYaml(content: string): unknown {
  return parseYamlString(content);
}

function formatNodeIssue(id: string, issue: z.ZodIssue): string {
  const pathStr = issue.path.length > 0 ? `'${issue.path.join(".")}' ` : "";
  return `Node '${id}': ${pathStr}${issue.message}`;
}

// ---------------------------------------------------------------------------
// Per-node parsing
// ---------------------------------------------------------------------------

interface ParseNodeContext {
  filename: string;
  errors: string[];
  warnings: WorkflowLoadWarning[];
}

function parseDagNode(raw: unknown, index: number, ctx: ParseNodeContext): DagNode | null {
  const rawId =
    raw !== null && typeof raw === "object" && "id" in raw
      ? String((raw as Record<string, unknown>).id)
      : "";
  const id = rawId.trim() || `#${String(index + 1)}`;

  const result = dagNodeSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.errors.push(formatNodeIssue(id, issue));
    }
    return null;
  }

  const node = result.data;
  const rawObj = (raw as Record<string, unknown>) ?? {};

  // Warn about AI-specific fields on non-AI nodes .
  let nonAi: { type: string; fields: readonly string[] } | undefined;
  if (isCancelNode(node)) nonAi = { type: "cancel", fields: BASH_NODE_AI_FIELDS };
  else if (isApprovalNode(node)) nonAi = { type: "approval", fields: BASH_NODE_AI_FIELDS };
  else if (isLoopNode(node)) nonAi = { type: "loop", fields: LOOP_NODE_AI_FIELDS };
  else if (isScriptNode(node)) nonAi = { type: "script", fields: SCRIPT_NODE_AI_FIELDS };
  else if ("bash" in node && typeof node.bash === "string") {
    nonAi = { type: "bash", fields: BASH_NODE_AI_FIELDS };
  }
  if (nonAi) {
    const present = nonAi.fields.filter((f) => rawObj[f] !== undefined);
    if (present.length > 0) {
      ctx.warnings.push({
        filename: ctx.filename,
        nodeId: node.id,
        kind: "ai_fields_on_non_ai_node",
        message: `AI-only fields on ${nonAi.type} node are ignored at runtime: ${present.join(", ")}`,
      });
    }
  }

  // Warn about Keelson ignored fields, regardless of node type.
  const ignoredPresent = IGNORED_FIELDS_PER_NODE.filter(
    (f) => rawObj[f] !== undefined && (nonAi?.fields.includes(f) ?? false) === false,
  );
  if (ignoredPresent.length > 0) {
    ctx.warnings.push({
      filename: ctx.filename,
      nodeId: node.id,
      kind: "ignored_capability",
      message: `Keelson does not honor these node fields in at runtime (workflow still runs, fields dropped): ${ignoredPresent.join(", ")}`,
    });
  }

  // Slice 4 — warn for fields the runtime DOES honor but only under claude.
  // AI-shaped fields on non-AI nodes are already covered by the
  // `ai_fields_on_non_ai_node` warning above, so skip them here.
  const claudeOnlyPresent = CLAUDE_ONLY_FIELDS_PER_NODE.filter(
    (f) => rawObj[f] !== undefined && (nonAi?.fields.includes(f) ?? false) === false,
  );
  if (claudeOnlyPresent.length > 0) {
    ctx.warnings.push({
      filename: ctx.filename,
      nodeId: node.id,
      kind: "provider_specific_capability",
      message: `These node fields are honored only by the claude provider; other providers silently ignore: ${claudeOnlyPresent.join(", ")}`,
    });
  }

  // Interactive loops tie into W4.6's metadata-approval flow and are not yet
  // wired in this engine. Flag at load so the user sees it before run.
  if (isLoopNode(node) && node.loop.interactive === true) {
    ctx.warnings.push({
      filename: ctx.filename,
      nodeId: node.id,
      kind: "ignored_capability",
      message: `'loop.interactive' is not yet supported in this engine; this node will fail at runtime`,
    });
  }

  // `loop.until_bash` (per-iteration shell completion probe) is in the
  // vendored schema but not yet implemented. Without an explicit warning, a
  // workflow that relies on the bash check would silently keep iterating
  // until the text `until` signal or max-iteration cap fires.
  if (isLoopNode(node) && typeof node.loop.until_bash === "string") {
    ctx.warnings.push({
      filename: ctx.filename,
      nodeId: node.id,
      kind: "ignored_capability",
      message: `'loop.until_bash' is not yet supported in this engine; this node will fail at runtime`,
    });
  }

  return node;
}

// ---------------------------------------------------------------------------
// Cross-node $nodeId.output reference validation
// ---------------------------------------------------------------------------

/** Reserved namespaces that look like `$X.output` but aren't node references.
 *  The executor's resolveBody handles `$inputs.<key>` and `$ARTIFACTS_DIR`
 *  directly, so the validator must not false-positive when those appear with
 *  a `.output` suffix in a workflow body (e.g. literal path text). */
const RESERVED_REF_NAMESPACES = new Set(["inputs", "ARTIFACTS_DIR"]);

/** Node ids that can't be declared because they collide with substitution
 *  namespaces. The executor's resolveBody resolves `$inputs.*`, `$ARGUMENTS`,
 *  and `$ARTIFACTS_DIR` before considering them as node refs, so a node
 *  literally named any of these would be silently shadowed — reject at parse
 *  time. */
const RESERVED_NODE_IDS = new Set(["inputs", "ARGUMENTS", "ARTIFACTS_DIR"]);

/** Workflow names that can't be declared because they collide with the
 *  `/api/workflows/<name>` route family. The path segment `runs` is owned by
 *  the run-collection routes (`GET /api/workflows/runs` aggregate query +
 *  `GET|DELETE /api/workflows/runs/:runId` per-run ops), so a workflow named
 *  `runs` would be unreachable from the UI. Reject at parse time so authors
 *  see the conflict immediately instead of debugging a silent 400 / 404. */
const RESERVED_WORKFLOW_NAMES = new Set(["runs"]);

function validateReservedNodeIds(nodes: readonly DagNode[]): string | null {
  for (const node of nodes) {
    if (RESERVED_NODE_IDS.has(node.id)) {
      return `Node id '${node.id}' is reserved (collides with the $${node.id}.* substitution namespace); rename the node.`;
    }
  }
  return null;
}

/**
 * Build the transitive depends_on closure for every node. Assumes the DAG is
 * acyclic — callers must run `validateDagShape` first.
 */
function buildAncestorMap(nodes: readonly DagNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const ancestors = new Map<string, Set<string>>();
  for (const node of nodes) {
    const set = new Set<string>();
    const stack = [...(node.depends_on ?? [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || set.has(id)) continue;
      set.add(id);
      const parent = byId.get(id);
      if (parent?.depends_on) stack.push(...parent.depends_on);
    }
    ancestors.set(node.id, set);
  }
  return ancestors;
}

function validateOutputRefs(nodes: readonly DagNode[]): string | null {
  const ids = new Set(nodes.map((n) => n.id));
  const ancestors = buildAncestorMap(nodes);
  // Leading (?<!\\) mirrors the executor's escape handling: a backslash-
  // prefixed $X.output is a literal in the workflow body (e.g. a jq/template
  // snippet that needs the placeholder text), so the validator must not
  // false-positive on it.
  const refPattern = /(?<!\\)\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;
  const stripMarkdownCode = (s: string): string =>
    s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

  type Source = { text: string; label: string; allowReservedNamespace: boolean };
  for (const node of nodes) {
    const sources: Source[] = [];
    // `when:` is evaluated by evaluateCondition (in conditions.ts), which
    // only understands `$nodeId.output` — it has no plumbing for $inputs.*
    // or $ARGUMENTS. Reject reserved namespaces in when bodies so the
    // condition can't silently evaluate against "".
    if (node.when) sources.push({ text: node.when, label: "when", allowReservedNamespace: false });
    if ("prompt" in node && typeof node.prompt === "string") {
      sources.push({
        text: stripMarkdownCode(node.prompt),
        label: "prompt",
        allowReservedNamespace: true,
      });
    }
    // bash bodies are substituted by the executor's resolveBody, so their
    // $X.output refs need the same ancestor check. Markdown stripping does
    // NOT apply — bash uses backticks for command substitution, not for
    // markdown fences.
    if ("bash" in node && typeof node.bash === "string") {
      sources.push({ text: node.bash, label: "bash", allowReservedNamespace: true });
    }
    if (isLoopNode(node)) {
      sources.push({
        text: stripMarkdownCode(node.loop.prompt),
        label: "loop.prompt",
        allowReservedNamespace: true,
      });
    }
    // cancel bodies go through the same executor resolveBody substitution,
    // so $X.output refs need the same ancestor-chain check as bash/prompt.
    // Without this, a typo or missing depends_on silently cancels with an
    // empty reason at runtime instead of failing at load.
    if (isCancelNode(node)) {
      sources.push({ text: node.cancel, label: "cancel", allowReservedNamespace: true });
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      refPattern.lastIndex = 0;
      while ((m = refPattern.exec(source.text)) !== null) {
        const refId = m[1];
        if (refId === undefined) continue;
        if (RESERVED_REF_NAMESPACES.has(refId)) {
          if (source.allowReservedNamespace) continue;
          return `Node '${node.id}' ${source.label}: '$${refId}.*' references aren't supported here — evaluateCondition only resolves '$nodeId.output' refs. Rewrite the condition to reference a producer node's output.`;
        }
        if (!ids.has(refId)) {
          return `Node '${node.id}' references unknown node '$${refId}.output'`;
        }
        // Catches the silent-empty trap where a node references an output
        // from a non-ancestor: at runtime that output isn't in the
        // upstreams map yet, substitution resolves to "", and the
        // referencing node can run with a wrong value (e.g. a `when:`
        // comparing to '' passes when the producer just hasn't run).
        if (!ancestors.get(node.id)?.has(refId)) {
          return `Node '${node.id}' references '$${refId}.output' but '${refId}' is not in its depends_on chain (add 'depends_on: [${refId}]' or remove the reference)`;
        }
      }

      // when: clauses additionally need a broader scan because
      // evaluateCondition only resolves $nodeId.output — `$inputs.env` (no
      // `.output`), bare `$ARGUMENTS`, or `$ARTIFACTS_DIR` parse cleanly
      // but evaluate against "" at runtime, silently skipping the node.
      // Boundary excludes `-` so hyphenated node refs like
      // `$ARTIFACTS_DIR-cache.output` (handled by the main refPattern
      // above) don't false-positive here — must match the executor's
      // SUB_PATTERN boundary semantics exactly.
      if (!source.allowReservedNamespace) {
        const broadPattern =
          /(?<!\\)\$(?:inputs\.[a-zA-Z_][a-zA-Z0-9_]*|ARGUMENTS(?![a-zA-Z0-9_-])|ARTIFACTS_DIR(?![a-zA-Z0-9_-]))/g;
        let r: RegExpExecArray | null;
        while ((r = broadPattern.exec(source.text)) !== null) {
          return `Node '${node.id}' ${source.label}: '${r[0]}' isn't supported in this context — evaluateCondition only resolves '$nodeId.output' refs. Encode the input via a producer node and reference its output.`;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level parseWorkflow
// ---------------------------------------------------------------------------

export type ParseResult =
  | { workflow: WorkflowDefinition; warnings: WorkflowLoadWarning[]; error: null }
  | { workflow: null; warnings: WorkflowLoadWarning[]; error: WorkflowLoadError };

export function parseWorkflow(content: string, filename: string): ParseResult {
  const warnings: WorkflowLoadWarning[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const lineMatch = /line (\d+)/i.exec(message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : "";
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${message}`,
        errorType: "parse_error",
      },
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: "YAML file is empty or does not contain an object",
        errorType: "validation_error",
      },
    };
  }
  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== "string") {
    return {
      workflow: null,
      warnings,
      error: { filename, error: "Missing required field 'name'", errorType: "validation_error" },
    };
  }
  if (RESERVED_WORKFLOW_NAMES.has(obj.name)) {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: `Workflow name '${obj.name}' is reserved (collides with the /api/workflows/${obj.name}/* route family); rename the workflow.`,
        errorType: "validation_error",
      },
    };
  }
  if (!obj.description || typeof obj.description !== "string") {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: "Missing required field 'description'",
        errorType: "validation_error",
      },
    };
  }

  if (Array.isArray(obj.steps) && obj.steps.length > 0) {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error:
          "`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively.",
        errorType: "validation_error",
      },
    };
  }
  if (!Array.isArray(obj.nodes) || (obj.nodes as unknown[]).length === 0) {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: "Workflow must have a non-empty 'nodes:' array",
        errorType: "validation_error",
      },
    };
  }

  // Per-node parse
  const nodeErrors: string[] = [];
  const ctx: ParseNodeContext = { filename, errors: nodeErrors, warnings };
  const nodes = (obj.nodes as unknown[])
    .map((n, i) => parseDagNode(n, i, ctx))
    .filter((n): n is DagNode => n !== null);
  if (nodes.length !== (obj.nodes as unknown[]).length) {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: `DAG node validation failed: ${nodeErrors.join("; ")}`,
        errorType: "validation_error",
      },
    };
  }

  // DAG shape (validateDagShape — same coverage as the upstream
  // validateDagStructure for ids/deps/cycles, but returns structured errors).
  const shapeErrors = validateDagShape(nodes);
  if (shapeErrors.length > 0) {
    const messages = shapeErrors
      .map((e) => {
        switch (e.kind) {
          case "duplicate_id":
            return `Duplicate node id: '${e.id}'`;
          case "unknown_dependency":
            return `Node '${e.nodeId}' depends_on unknown node '${e.missing}'`;
          case "self_dependency":
            return `Node '${e.nodeId}' depends on itself`;
          case "cycle":
            return `Cycle detected among nodes: ${e.nodeIds.join(", ")}`;
        }
      })
      .join("; ");
    return {
      workflow: null,
      warnings,
      error: { filename, error: messages, errorType: "validation_error" },
    };
  }

  // Reserved-id check: a node literally named "inputs" would collide with
  // the $inputs.* substitution namespace and be silently shadowed.
  const reservedError = validateReservedNodeIds(nodes);
  if (reservedError) {
    return {
      workflow: null,
      warnings,
      error: { filename, error: reservedError, errorType: "validation_error" },
    };
  }

  // Cross-node output ref validation
  const refError = validateOutputRefs(nodes);
  if (refError) {
    return {
      workflow: null,
      warnings,
      error: { filename, error: refError, errorType: "validation_error" },
    };
  }

  // Provider — Keelson only honors 'claude' (or omitted).
  const provider =
    typeof obj.provider === "string" && obj.provider.trim().length > 0
      ? obj.provider.trim()
      : undefined;
  if (provider !== undefined && provider !== "claude") {
    return {
      workflow: null,
      warnings,
      error: {
        filename,
        error: `Provider '${provider}' is not supported in Keelson; only 'claude' (or omitting the field) is accepted.`,
        errorType: "validation_error",
      },
    };
  }
  for (const node of nodes) {
    if (node.provider !== undefined && node.provider !== "claude") {
      return {
        workflow: null,
        warnings,
        error: {
          filename,
          error: `Node '${node.id}': provider '${node.provider}' is not supported in Keelson.`,
          errorType: "validation_error",
        },
      };
    }
  }

  // Warn-and-ignore scalars
  const model = typeof obj.model === "string" ? obj.model : undefined;

  const mreResult = modelReasoningEffortSchema.safeParse(obj.modelReasoningEffort);
  const modelReasoningEffort = mreResult.success ? mreResult.data : undefined;
  if (obj.modelReasoningEffort !== undefined && !mreResult.success) {
    warnings.push({
      filename,
      kind: "invalid_field_value",
      message: `invalid 'modelReasoningEffort' value (ignored); valid: ${modelReasoningEffortSchema.options.join(", ")}`,
    });
  }

  const wsmResult = webSearchModeSchema.safeParse(obj.webSearchMode);
  const webSearchMode = wsmResult.success ? wsmResult.data : undefined;
  if (obj.webSearchMode !== undefined && !wsmResult.success) {
    warnings.push({
      filename,
      kind: "invalid_field_value",
      message: `invalid 'webSearchMode' value (ignored); valid: ${webSearchModeSchema.options.join(", ")}`,
    });
  }

  const additionalDirectories = Array.isArray(obj.additionalDirectories)
    ? obj.additionalDirectories.filter((d): d is string => typeof d === "string")
    : undefined;

  const interactive = typeof obj.interactive === "boolean" ? obj.interactive : undefined;
  if (obj.interactive !== undefined && typeof obj.interactive !== "boolean") {
    warnings.push({
      filename,
      kind: "invalid_field_value",
      message: `invalid 'interactive' value (ignored); expected boolean`,
    });
  }
  if (!interactive) {
    const hasInteractiveLoop = nodes.some((n) => isLoopNode(n) && n.loop.interactive === true);
    if (hasInteractiveLoop) {
      warnings.push({
        filename,
        kind: "interactive_loop_in_non_interactive_workflow",
        message:
          "workflow has an interactive loop but is not marked top-level interactive — gate messages will not pause for input",
      });
    }
  }

  let worktreePolicy: { enabled?: boolean } | undefined;
  if (obj.worktree && typeof obj.worktree === "object" && !Array.isArray(obj.worktree)) {
    const enabled = (obj.worktree as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") worktreePolicy = { enabled };
  }

  let mutatesCheckout: boolean | undefined;
  if (typeof obj.mutates_checkout === "boolean") mutatesCheckout = obj.mutates_checkout;

  let tags: string[] | undefined;
  if (Array.isArray(obj.tags)) {
    tags = [
      ...new Set(
        obj.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      ),
    ];
  }

  // Workflow-level ignored capability warnings
  for (const field of IGNORED_FIELDS_WORKFLOW) {
    if (obj[field] !== undefined) {
      warnings.push({
        filename,
        kind: "ignored_capability",
        message: `Keelson does not honor workflow-level '${field}' at runtime (field dropped)`,
      });
    }
  }

  const workflow: WorkflowDefinition = {
    name: obj.name,
    description: obj.description,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelReasoningEffort !== undefined ? { modelReasoningEffort } : {}),
    ...(webSearchMode !== undefined ? { webSearchMode } : {}),
    ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    ...(interactive !== undefined ? { interactive } : {}),
    ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
    nodes,
    ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };

  return { workflow, warnings, error: null };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryRoot {
  dir: string;
  source: WorkflowSource;
}

/**
 * Discover workflows from a list of roots. Higher-precedence roots later in the
 * list override same-named earlier ones (caller orders: bundled, global,
 * project).
 *
 * Surfaces both successful loads and errors so the caller can render both.
 * Warnings are aggregated separately on the returned object.
 */
export interface DiscoveryResult extends WorkflowLoadResult {
  readonly warnings: readonly WorkflowLoadWarning[];
}

export function discoverWorkflows(roots: readonly DiscoveryRoot[]): DiscoveryResult {
  const byName = new Map<string, WorkflowWithSource>();
  const errors: WorkflowLoadError[] = [];
  const warnings: WorkflowLoadWarning[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      if (!fs.existsSync(root.dir)) continue;
      entries = fs.readdirSync(root.dir);
    } catch (err) {
      errors.push({
        filename: root.dir,
        error: `failed to read discovery root: ${(err as Error).message}`,
        errorType: "read_error",
      });
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const filePath = path.join(root.dir, entry);
      let content: string;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        content = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        errors.push({
          filename: filePath,
          error: `failed to read file: ${(err as Error).message}`,
          errorType: "read_error",
        });
        continue;
      }
      const result = parseWorkflow(content, filePath);
      for (const w of result.warnings) warnings.push(w);
      if (result.error) {
        errors.push(result.error);
        continue;
      }
      const wf = result.workflow;
      byName.set(wf.name, { workflow: wf, source: root.source, path: filePath });
    }
  }

  return {
    workflows: Array.from(byName.values()),
    errors,
    warnings,
  };
}

import { parse as parseYaml } from "yaml";

// Build-time catalog for the workflow cards on the Starter workflows page.
// Reads the bundled workflow YAML straight from the monorepo so the cards never
// drift from the source: the `Use when:` / `Triggers:` / `Does:` / `NOT for:`
// sections and the node-type pills are derived from the same files the harness
// ships. Parsing mirrors the server (the `yaml` parser, the description split,
// and the node-type discriminant order) so a card matches the app's card.

// Ordered node-type discriminants — a node's type is the first of these keys it
// carries. Mirrors NODE_TYPE_FIELDS in apps/server/src/workflows-handler.ts.
const NODE_TYPE_FIELDS = [
  "prompt",
  "bash",
  "command",
  "loop",
  "approval",
  "cancel",
  "script",
] as const;

export interface NodeTypeCount {
  type: string;
  count: number;
}

export interface WorkflowCardData {
  name: string;
  title: string;
  useWhen?: string;
  does?: string;
  triggers?: string;
  notFor?: string;
  body?: string;
  pills: NodeTypeCount[];
  nodeCount: number;
}

interface ParsedDescription {
  body?: string;
  useWhen?: string;
  triggers?: string;
  does?: string;
  notFor?: string;
}

// Port of @keelson/shared's parseWorkflowDescription. Copied (not imported)
// because the docs project is a standalone Astro build with its own lockfile and
// does not depend on the monorepo packages.
const SECTION_LABELS: ReadonlyArray<{ key: keyof ParsedDescription; pattern: RegExp }> = [
  { key: "useWhen", pattern: /^use\s+when$/i },
  { key: "triggers", pattern: /^triggers$/i },
  { key: "does", pattern: /^does$/i },
  { key: "notFor", pattern: /^not\s+for$/i },
];

function matchLabel(line: string): keyof ParsedDescription | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const label = line.slice(0, idx).trim();
  for (const { key, pattern } of SECTION_LABELS) {
    if (pattern.test(label)) return key;
  }
  return null;
}

function parseDescription(raw: string | undefined | null): ParsedDescription {
  const text = (raw ?? "").trim();
  if (!text) return {};

  const lines = text.split(/\r?\n/);
  const sections: Partial<Record<keyof ParsedDescription, string[]>> = {};
  let current: keyof ParsedDescription | null = null;
  const pre: string[] = [];

  for (const line of lines) {
    const label = matchLabel(line);
    if (label) {
      current = label;
      const after = line.slice(line.indexOf(":") + 1).trim();
      sections[current] = after ? [after] : [];
      continue;
    }
    if (current) sections[current]!.push(line);
    else pre.push(line);
  }

  if (!current) return { body: text };

  const out: ParsedDescription = {};
  const preText = pre.join("\n").trim();
  if (preText) out.body = preText;
  for (const { key } of SECTION_LABELS) {
    // Collapse the YAML block scalar's alignment whitespace so a wrapped value
    // reads as one sentence rather than keeping its source line breaks.
    const joined = sections[key]?.join(" ").replace(/\s+/g, " ").trim();
    if (joined) out[key] = joined;
  }
  return out;
}

function humanTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
}

function nodeType(node: Record<string, unknown>): string {
  for (const t of NODE_TYPE_FIELDS) {
    if (t in node) return t;
  }
  return "unknown";
}

interface RawWorkflow {
  name?: string;
  description?: string;
  nodes?: Array<Record<string, unknown>>;
}

// Eager raw import of every bundled workflow, resolved relative to this file
// (../../../ reaches the repo root from docs/src/lib/).
const files = import.meta.glob("../../../packages/workflows/assets/workflows/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const byName = new Map<string, WorkflowCardData>();
for (const text of Object.values(files)) {
  const doc = parseYaml(text) as RawWorkflow | null;
  if (!doc?.name) continue;
  const nodes = doc.nodes ?? [];
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const t = nodeType(n);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  byName.set(doc.name, {
    name: doc.name,
    title: humanTitle(doc.name),
    ...parseDescription(doc.description),
    pills: Array.from(counts.entries(), ([type, count]) => ({ type, count })),
    nodeCount: nodes.length,
  });
}

// Resolve a group's workflows in the order the page lists them. Throws on an
// unknown name so a rename surfaces at build instead of silently dropping a card.
export function getWorkflowCards(names: readonly string[]): WorkflowCardData[] {
  return names.map((name) => {
    const data = byName.get(name);
    if (!data) {
      throw new Error(
        `WorkflowCards: no bundled workflow named '${name}' in packages/workflows/assets/workflows`,
      );
    }
    return data;
  });
}

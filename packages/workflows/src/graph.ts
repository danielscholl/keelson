/**
 * DAG construction and validation: topological layering + cycle detection.
 *
 * Ported from Archon's `packages/workflows/src/dag-executor.ts:buildTopologicalLayers`,
 * with cycle detection split into `validateDagShape` so the loader can reject
 * malformed workflows before runtime.
 *
 * Pure: depends only on schema types.
 */

import type { DagNode } from "./schema/index.ts";

export type DagShapeError =
  | {
      kind: "duplicate_id";
      id: string;
    }
  | {
      kind: "unknown_dependency";
      nodeId: string;
      missing: string;
    }
  | {
      kind: "self_dependency";
      nodeId: string;
    }
  | {
      kind: "cycle";
      /** Node ids that participate in at least one cycle. */
      nodeIds: string[];
    };

/**
 * Validate the static shape of the DAG: unique ids, every depends_on refers to
 * an existing id, no self-dependencies, no cycles.
 *
 * Returns an empty array when the DAG is well-formed. Otherwise returns the
 * complete list of issues so the loader can report all of them at once.
 */
export function validateDagShape(nodes: readonly DagNode[]): DagShapeError[] {
  const errors: DagShapeError[] = [];
  const ids = new Set<string>();
  const duplicates = new Set<string>();

  for (const node of nodes) {
    if (ids.has(node.id)) {
      if (!duplicates.has(node.id)) {
        duplicates.add(node.id);
        errors.push({ kind: "duplicate_id", id: node.id });
      }
    } else {
      ids.add(node.id);
    }
  }

  for (const node of nodes) {
    const deps = node.depends_on ?? [];
    for (const dep of deps) {
      if (dep === node.id) {
        errors.push({ kind: "self_dependency", nodeId: node.id });
        continue;
      }
      if (!ids.has(dep)) {
        errors.push({
          kind: "unknown_dependency",
          nodeId: node.id,
          missing: dep,
        });
      }
    }
  }

  // Cycle detection via Kahn's algorithm — nodes left over after layering
  // participate in a cycle.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = (node.depends_on ?? []).filter((d) => ids.has(d) && d !== node.id);
    inDegree.set(node.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  let queue = nodes.map((n) => n.id).filter((id) => (inDegree.get(id) ?? 0) === 0);
  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    const next: string[] = [];
    for (const id of queue) {
      for (const downstream of dependents.get(id) ?? []) {
        const remaining = (inDegree.get(downstream) ?? 0) - 1;
        inDegree.set(downstream, remaining);
        if (remaining === 0 && !visited.has(downstream)) {
          visited.add(downstream);
          next.push(downstream);
        }
      }
    }
    queue = next;
  }
  if (visited.size < ids.size) {
    const cycleIds = nodes.map((n) => n.id).filter((id) => !visited.has(id));
    errors.push({ kind: "cycle", nodeIds: cycleIds });
  }

  return errors;
}

/**
 * Build topological layers from DAG nodes using Kahn's algorithm.
 *
 * Layer 0: nodes with no dependencies.
 * Layer N: nodes whose dependencies are all in layers 0..N-1.
 *
 * Throws when a cycle is detected (the sum of layer sizes < node count). Cycle
 * detection at load time via `validateDagShape` is the primary guard; this
 * runtime throw exists so misuse from non-loader callers fails loudly.
 */
export function buildTopologicalLayers(nodes: readonly DagNode[]): DagNode[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const layers: DagNode[][] = [];
  let ready = [...nodes].filter((n) => (inDegree.get(n.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const node of ready) {
      for (const depId of dependents.get(node.id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) nextIds.push(depId);
      }
    }
    ready = nextIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is DagNode => n !== undefined);
  }

  const totalPlaced = layers.reduce((sum, l) => sum + l.length, 0);
  if (totalPlaced < nodes.length) {
    throw new Error(
      "buildTopologicalLayers: cycle detected — call validateDagShape() at load time to reject these earlier",
    );
  }

  return layers;
}

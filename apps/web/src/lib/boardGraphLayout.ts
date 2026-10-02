import type { CanvasGraphSection } from "@keelson/shared";

type GraphNode = CanvasGraphSection["nodes"][number];
type GraphEdge = CanvasGraphSection["edges"][number];

export function computeRanks(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const ranks = new Map(nodes.map((node) => [node.id, node.rank ?? 0]));
  const fixed = new Set(nodes.filter((node) => node.rank !== undefined).map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!ranks.has(edge.source) || !ranks.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const processed = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    processed.add(id);
    for (const target of outgoing.get(id)!) {
      if (!fixed.has(target)) ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  for (const node of nodes) {
    if (processed.has(node.id) || fixed.has(node.id)) continue;
    const predecessors = edges.filter(
      (edge) => edge.target === node.id && processed.has(edge.source),
    );
    ranks.set(node.id, Math.max(0, ...predecessors.map((edge) => ranks.get(edge.source)! + 1)));
  }
  return ranks;
}

export function buildColumns(nodes: GraphNode[], ranks: Map<string, number>, titles?: string[]) {
  const columns = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const members = columns.get(rank) ?? [];
    members.push(node);
    columns.set(rank, members);
  }
  return [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, members]) => ({ rank, title: titles?.[rank], nodes: members }));
}

export function chainOf(id: string, edges: GraphEdge[]): { up: Set<string>; down: Set<string> } {
  const visit = (from: "source" | "target", to: "source" | "target") => {
    const seen = new Set([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of edges) {
        if (edge[from] !== queue[i] || seen.has(edge[to])) continue;
        seen.add(edge[to]);
        queue.push(edge[to]);
      }
    }
    seen.delete(id);
    return seen;
  };
  return { up: visit("target", "source"), down: visit("source", "target") };
}

export function litSet(activeIds: string[], edges: GraphEdge[]): Set<string> {
  const lit = new Set(activeIds);
  for (const id of activeIds) {
    const { up, down } = chainOf(id, edges);
    for (const member of up) lit.add(member);
    for (const member of down) lit.add(member);
  }
  return lit;
}

export function waitsOn(nodeId: string, nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  return edges
    .filter((edge) => edge.target === nodeId && labels.has(edge.source))
    .map((edge) => labels.get(edge.source)!);
}

export type GraphGeometry = {
  columns: {
    left: number;
    right: number;
    nodes: { id: string; top: number; bottom: number; left: number; right: number }[];
  }[];
};

export function routeEdge(
  sourceId: string,
  targetId: string,
  geometry: GraphGeometry,
): { d: string; waypoints: { x: number; y: number }[] } | null {
  const sourceColumn = geometry.columns.findIndex((column) =>
    column.nodes.some((n) => n.id === sourceId),
  );
  const targetColumn = geometry.columns.findIndex((column) =>
    column.nodes.some((n) => n.id === targetId),
  );
  if (sourceId === targetId || sourceColumn < 0 || targetColumn <= sourceColumn) return null;
  const source = geometry.columns[sourceColumn]!.nodes.find((node) => node.id === sourceId)!;
  const target = geometry.columns[targetColumn]!.nodes.find((node) => node.id === targetId)!;
  const start = { x: source.right, y: (source.top + source.bottom) / 2 };
  const end = { x: target.left, y: (target.top + target.bottom) / 2 };
  const waypoints = [start];
  for (let i = sourceColumn + 1; i < targetColumn; i++) {
    const column = geometry.columns[i]!;
    const boxes = [...column.nodes].sort((a, b) => a.top - b.top);
    const gaps = boxes.length
      ? [Math.max(0, boxes[0]!.top - 8), boxes.at(-1)!.bottom + 8]
      : [start.y];
    for (let j = 1; j < boxes.length; j++) {
      if (boxes[j]!.top > boxes[j - 1]!.bottom)
        gaps.push((boxes[j]!.top + boxes[j - 1]!.bottom) / 2);
    }
    const x = (column.left + column.right) / 2;
    const idealY = start.y + (end.y - start.y) * ((x - start.x) / (end.x - start.x));
    const y = gaps.reduce((best, gap) =>
      Math.abs(gap - idealY) < Math.abs(best - idealY) ? gap : best,
    );
    waypoints.push({ x: column.left, y }, { x: column.right, y });
  }
  waypoints.push(end);
  let d = `M ${start.x} ${start.y}`;
  for (let i = 1; i < waypoints.length; i++) {
    const previous = waypoints[i - 1]!;
    const next = waypoints[i]!;
    if (i % 2 === 0) d += ` L ${next.x} ${next.y}`;
    else {
      const midX = (previous.x + next.x) / 2;
      d += ` C ${midX} ${previous.y} ${midX} ${next.y} ${next.x} ${next.y}`;
    }
  }
  return { d, waypoints };
}

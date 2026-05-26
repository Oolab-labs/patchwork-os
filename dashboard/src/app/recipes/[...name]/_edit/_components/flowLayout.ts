export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  rank: number;
  posInRank: number;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
}

export interface FlowLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export const NODE_W = 200;
export const NODE_H = 56;
const COL_GAP = 80;
const ROW_GAP = 28;
const PAD = 24;

export interface FlowStep {
  id: string;
  dependencies?: string[];
}

export function computeFlowLayout(steps: FlowStep[]): FlowLayout {
  if (steps.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const stepIds = new Set(steps.map((s) => s.id));
  const edges: LayoutEdge[] = [];
  const outgoing = new Map<string, string[]>();
  const rawInDegree = new Map<string, number>();

  for (const s of steps) {
    outgoing.set(s.id, []);
    rawInDegree.set(s.id, 0);
  }

  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      if (!stepIds.has(dep)) continue;
      edges.push({ fromId: dep, toId: s.id });
      outgoing.get(dep)!.push(s.id);
      rawInDegree.set(s.id, (rawInDegree.get(s.id) ?? 0) + 1);
    }
  }

  // Longest-path rank via Kahn's BFS
  const rank = new Map<string, number>(steps.map((s) => [s.id, 0]));
  const inDegree = new Map(rawInDegree);
  const queue: string[] = [];
  for (const s of steps) {
    if ((inDegree.get(s.id) ?? 0) === 0) queue.push(s.id);
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    for (const childId of outgoing.get(id) ?? []) {
      const candidate = (rank.get(id) ?? 0) + 1;
      if (candidate > (rank.get(childId) ?? 0)) rank.set(childId, candidate);
      const deg = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, deg);
      if (deg <= 0) queue.push(childId);
    }
  }

  // Group by rank preserving declaration order
  const byRank = new Map<number, string[]>();
  for (const s of steps) {
    const r = rank.get(s.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(s.id);
  }

  const maxRank = Math.max(...Array.from(rank.values()));

  const nodes: LayoutNode[] = steps.map((s) => {
    const r = rank.get(s.id) ?? 0;
    const siblings = byRank.get(r) ?? [];
    const pos = siblings.indexOf(s.id);
    return {
      id: s.id,
      x: PAD + r * (NODE_W + COL_GAP),
      y: PAD + pos * (NODE_H + ROW_GAP),
      rank: r,
      posInRank: pos,
    };
  });

  const maxCol = maxRank + 1;
  const maxRow = Math.max(...Array.from(byRank.values()).map((v) => v.length));
  const width = PAD * 2 + maxCol * NODE_W + (maxCol - 1) * COL_GAP;
  const height = PAD * 2 + maxRow * NODE_H + (maxRow - 1) * ROW_GAP;

  return { nodes, edges, width, height };
}

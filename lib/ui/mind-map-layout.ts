import type { MindMapNode } from "../../contracts/mind-map.ts";

export type PositionedNode = { node: MindMapNode; x: number; y: number; depth: number };
export const MAP_CENTER = { x: 600, y: 380 };

/** Lay out a forest without adding nodes or changing its parent relationships. */
export function buildPositionedNodes(nodes: MindMapNode[]): PositionedNode[] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, MindMapNode[]>();
  for (const node of nodes) {
    if (!node.parentNodeId || !byId.has(node.parentNodeId)) continue;
    const siblings = children.get(node.parentNodeId) ?? [];
    siblings.push(node); children.set(node.parentNodeId, siblings);
  }
  const roots = nodes.filter(node => !node.parentNodeId || !byId.has(node.parentNodeId));
  const visited = new Set<string>();
  const trees: PositionedNode[][] = [];
  // The trailing candidates keep malformed/cyclic snapshots finite and visible.
  for (const root of [...roots, ...nodes]) {
    if (visited.has(root.id)) continue;
    const tree: PositionedNode[] = [];
    let leaf = 0;
    function place(node: MindMapNode, depth: number): number {
      visited.add(node.id);
      const positioned = { node, x: depth * 300, y: 0, depth };
      tree.push(positioned);
      const childYs: number[] = [];
      for (const child of children.get(node.id) ?? []) {
        if (!visited.has(child.id)) childYs.push(place(child, depth + 1));
      }
      positioned.y = childYs.length ? (childYs[0] + childYs[childYs.length - 1]) / 2 : leaf++ * 150;
      return positioned.y;
    }
    place(root, 0); trees.push(tree);
  }
  const cellWidth = Math.max(...trees.map(tree => Math.max(...tree.map(p => p.x)))) + 420;
  const cellHeight = Math.max(...trees.map(tree => Math.max(...tree.map(p => p.y)))) + 260;
  const columns = Math.max(1, Math.round(Math.sqrt(trees.length * 1200 / 760 * cellHeight / cellWidth)));
  const positioned = trees.flatMap((tree, index) => tree.map(p => ({ ...p,
    x: p.x + (index % columns) * cellWidth,
    y: p.y + Math.floor(index / columns) * cellHeight,
  })));
  const midX = (Math.min(...positioned.map(p => p.x)) + Math.max(...positioned.map(p => p.x))) / 2;
  const midY = (Math.min(...positioned.map(p => p.y)) + Math.max(...positioned.map(p => p.y))) / 2;
  return positioned.map(p => ({ ...p, x: p.x - midX + MAP_CENTER.x, y: p.y - midY + MAP_CENTER.y }));
}

/** Include labels as well as circles so Fit to screen covers every tree. */
export function getMapViewport(nodes: PositionedNode[]) {
  const width = Math.max(1200, ...nodes.map(p => 2 * (Math.abs(p.x - MAP_CENTER.x) + 220)));
  const height = Math.max(760, ...nodes.map(p => 2 * (Math.abs(p.y - MAP_CENTER.y) + 130)));
  return { x: MAP_CENTER.x - width / 2, y: MAP_CENTER.y - height / 2, width, height };
}

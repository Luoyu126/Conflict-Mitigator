import { z } from "zod";
import type { MindMapNode } from "../../contracts/rooms.ts";
import { nodeUpsertSchema, type NodeUpsert } from "../../contracts/worker.ts";

export type GroupingNode = Pick<MindMapNode, "id" | "parentNodeId" | "topic" | "summary" | "contentionScore" | "discussionLoopCount" | "status">;
export const nodeGroupSchema = z.object({
  id: z.string().uuid(),
  topic: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
  childNodeIds: z.array(z.string().uuid()).min(2).max(20),
}).strict();
export type NodeGroup = z.infer<typeof nodeGroupSchema>;

/** Convert categorization proposals into existing API-24 writes, never inventing participant evidence. */
export function applyNodeGroups(existing: GroupingNode[], upserts: NodeUpsert[], groups: NodeGroup[]): NodeUpsert[] {
  const before = new Map(existing.map(node => [node.id, node]));
  const working = new Map<string, Pick<GroupingNode, "id" | "parentNodeId" | "topic" | "summary" | "contentionScore" | "discussionLoopCount">>(existing.map(node => [node.id, node]));
  const writes = new Map(upserts.map(node => [node.id, { ...node }]));
  for (const node of upserts) working.set(node.id, node);
  const grouped = new Set<string>();
  const newParents = new Set<string>();
  const protectedNode = (id: string | null) => id && ["private_mediation", "ready_to_resume"].includes(before.get(id)?.status ?? "");
  for (const candidate of groups) {
    const parsed = nodeGroupSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const group = parsed.data;
    if (working.has(group.id) || new Set(group.childNodeIds).size !== group.childNodeIds.length) continue;
    if (group.childNodeIds.some(id => !working.has(id) || grouped.has(id) || newParents.has(id) || protectedNode(id))) continue;
    const children = group.childNodeIds.map(id => working.get(id)!);
    const parentNodeId = children[0].parentNodeId ?? null;
    if (protectedNode(parentNodeId) || children.some(node => (node.parentNodeId ?? null) !== parentNodeId)) continue;
    if (new Set([...writes.keys(), group.id, ...group.childNodeIds]).size > 50) continue;
    if (parentNodeId) {
      const currentParent = working.get(parentNodeId);
      const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
      const allSiblings = [...working.values()].filter(node => node.parentNodeId === parentNodeId);
      // Never wrap all children of an existing parent in a redundant extra layer.
      if ((currentParent && normalize(currentParent.topic) === normalize(group.topic)) ||
        allSiblings.every(node => group.childNodeIds.includes(node.id))) continue;
    }
    // The parent summarizes its children; it makes no new personal claims or conflict judgments.
    const parent: NodeUpsert = { id: group.id, parentNodeId, topic: group.topic, summary: group.summary,
      contentionScore: 0, discussionLoopCount: 0, participantStates: [] };
    working.set(group.id, parent); writes.set(group.id, parent); newParents.add(group.id);
    for (const child of children) {
      const priorWrite = writes.get(child.id);
      const updated: NodeUpsert = priorWrite ? { ...priorWrite, parentNodeId: group.id } : {
        id: child.id, parentNodeId: group.id, topic: child.topic, summary: child.summary,
        contentionScore: child.contentionScore, discussionLoopCount: child.discussionLoopCount, participantStates: [],
      };
      working.set(child.id, updated); writes.set(child.id, updated); grouped.add(child.id);
    }
  }
  // Validate the complete graph before it leaves the Worker; the backend repeats this under its room lock.
  for (const node of working.values()) {
    const seen = new Set<string>(); let cursor: string | null = node.id;
    while (cursor !== null) {
      if (seen.has(cursor) || !working.has(cursor)) throw new Error("Grouping would produce an invalid hierarchy.");
      seen.add(cursor); cursor = working.get(cursor)!.parentNodeId ?? null;
    }
  }
  if (writes.size > 50) throw new Error("Grouping exceeds the analysis batch limit.");
  return [...writes.values()].map(node => nodeUpsertSchema.parse(node));
}

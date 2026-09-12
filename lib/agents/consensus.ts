import type { ConsensusTree, ConsensusTreeEdge, ConsensusTreeNode } from "../../contracts/mediation.ts";
import type { MindMapNode, PublicParticipantNodeState } from "../../contracts/rooms.ts";

const uuid = () => (crypto as unknown as { randomUUID?: () => string }).randomUUID?.() ?? `${Math.random().toString(16).slice(2)}`;

/**
 * Deterministically synthesizes a privacy-safe consensus tree from the sharing
 * allowlist (node topic + public positions/concerns/compromises). No raw private
 * message text is ever included.
 */
export function synthesizeConsensusTree(
  node: MindMapNode,
  states: PublicParticipantNodeState[],
  version: number,
  generatedAt: string,
): ConsensusTree {
  const nodes: ConsensusTreeNode[] = [];
  const edges: ConsensusTreeEdge[] = [];
  const rootId = uuid();
  nodes.push({
    id: rootId, kind: "surface_conflict", label: node.topic, participantId: null,
    epistemicStatus: "shared_statement",
  });

  const viewIds = new Map<string, string>();
  for (const state of states) {
    const id = uuid();
    viewIds.set(state.participantId, id);
    nodes.push({
      id, kind: "participant_view", participantId: state.participantId,
      label: state.position ?? "No stated position",
      epistemicStatus: state.position ? "participant_confirmed" : "insufficient_evidence",
    });
    edges.push({ id: uuid(), sourceNodeId: rootId, targetNodeId: id, relation: "underlies" });
  }

  const sharedConcerns = new Set<string>();
  const seen = new Set<string>();
  for (const state of states) {
    for (const concern of state.underlyingConcerns) {
      if (seen.has(concern)) sharedConcerns.add(concern);
      seen.add(concern);
    }
  }
  for (const concern of sharedConcerns) {
    const id = uuid();
    nodes.push({ id, kind: "inferred_common_ground", label: concern, participantId: null, epistemicStatus: "shared_statement" });
    for (const state of states) {
      if (state.underlyingConcerns.includes(concern) && viewIds.has(state.participantId)) {
        edges.push({ id: uuid(), sourceNodeId: viewIds.get(state.participantId)!, targetNodeId: id, relation: "supports" });
      }
    }
  }

  return { version, generatedAt, nodes, edges };
}

export function synthesizeSharedSummary(node: MindMapNode, states: PublicParticipantNodeState[]): string {
  const positions = states.filter((state) => state.position).map((state) => state.position).join(" · ");
  const compromises = [...new Set(states.flatMap((state) => state.acceptableCompromises))];
  const compromiseText = compromises.length ? ` Acceptable compromises: ${compromises.join(" · ")}.` : "";
  return `The team discussed "${node.topic}".${positions ? ` Positions: ${positions}.` : ""}${compromiseText}`;
}

import { createHash } from "node:crypto";
import type { ConsensusTree, ConsensusTreeEdge, ConsensusTreeNode } from "../../contracts/mediation.ts";
import type { MindMapNode, PublicParticipantNodeState } from "../../contracts/rooms.ts";

function stableId(...parts: string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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
  const rootId = stableId(node.id, "surface_conflict", node.topic);
  nodes.push({
    id: rootId, kind: "surface_conflict", label: node.topic, participantId: null,
    epistemicStatus: "shared_statement",
  });

  const viewIds = new Map<string, string>();
  for (const state of states.slice(0, 12)) {
    const id = stableId(node.id, "participant_view", state.participantId, state.position ?? "unknown");
    viewIds.set(state.participantId, id);
    nodes.push({
      id, kind: "participant_view", participantId: state.participantId,
      label: state.position ?? "No stated position",
      epistemicStatus: state.position ? "llm_inferred" : "insufficient_evidence",
    });
    edges.push({ id: stableId(rootId, id, "underlies"), sourceNodeId: rootId, targetNodeId: id, relation: "underlies" });
  }

  const sharedConcerns = new Set<string>();
  const seen = new Set<string>();
  for (const state of states) {
    for (const concern of new Set(state.underlyingConcerns)) {
      if (seen.has(concern)) sharedConcerns.add(concern);
      seen.add(concern);
    }
  }
  for (const concern of sharedConcerns) {
    const id = stableId(node.id, "inferred_common_ground", concern);
    if (nodes.length >= 100) break;
    nodes.push({ id, kind: "inferred_common_ground", label: concern, participantId: null, epistemicStatus: "llm_inferred" });
    for (const state of states) {
      if (edges.length < 200 && state.underlyingConcerns.includes(concern) && viewIds.has(state.participantId)) {
        edges.push({ id: stableId(viewIds.get(state.participantId)!, id, "supports"), sourceNodeId: viewIds.get(state.participantId)!, targetNodeId: id, relation: "supports" });
      }
    }
  }

  return { version, generatedAt, nodes, edges };
}

export function synthesizeSharedSummary(node: MindMapNode, states: PublicParticipantNodeState[]): string {
  const positions = states.filter((state) => state.position).map((state) => state.position).join(" · ");
  const compromises = [...new Set(states.flatMap((state) => state.acceptableCompromises))];
  const compromiseText = compromises.length ? ` Acceptable compromises: ${compromises.join(" · ")}.` : "";
  return `The team discussed "${node.topic}".${positions ? ` Positions: ${positions}.` : ""}${compromiseText}`.slice(0, 4000);
}

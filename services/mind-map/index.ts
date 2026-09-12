import "server-only";
import type { MindMapData, MindMapNode, NodeData, ParticipantNodeState, PublicParticipantNodeState } from "../../contracts/rooms";
import type { DatabaseExecutor } from "../../lib/db/postgres";
import { getDatabase } from "../../lib/db/postgres.ts";
import { requireRoomMember } from "../../lib/db/repositories/membership.ts";
import { ApiProblem } from "../../lib/server/errors.ts";

type NodeRow = Omit<MindMapNode, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
type StateRow = Omit<ParticipantNodeState, "updatedAt"> & { updatedAt: Date };
function nodeDto(row: NodeRow): MindMapNode { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function publicState(row: StateRow): PublicParticipantNodeState {
  return { id: row.id, nodeId: row.nodeId, participantId: row.participantId, position: row.position,
    supportingReasons: row.supportingReasons, underlyingConcerns: row.underlyingConcerns,
    acceptableCompromises: row.acceptableCompromises, updatedAt: row.updatedAt.toISOString() };
}
function privateState(row: StateRow): ParticipantNodeState { return { ...row, updatedAt: row.updatedAt.toISOString() }; }
async function nodes(db: DatabaseExecutor, roomId: string, nodeId?: string): Promise<NodeRow[]> {
  return db<NodeRow[]>`
    SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", topic, summary, status,
      contention_score AS "contentionScore", readiness_score AS "readinessScore",
      discussion_loop_count AS "discussionLoopCount", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM mind_map_nodes WHERE room_id = ${roomId}::uuid AND (${nodeId ?? null}::uuid IS NULL OR id = ${nodeId ?? null}::uuid)
    ORDER BY created_at, id`;
}
async function states(db: DatabaseExecutor, roomId: string, nodeId?: string): Promise<StateRow[]> {
  return db<StateRow[]>`
    SELECT s.id, s.node_id AS "nodeId", s.participant_id AS "participantId", s.position,
      s.supporting_reasons AS "supportingReasons", s.underlying_concerns AS "underlyingConcerns",
      s.emotion_intensity AS "emotionIntensity", s.view_of_others AS "viewOfOthers",
      s.acceptable_compromises AS "acceptableCompromises", s.updated_at AS "updatedAt"
    FROM participant_node_states s JOIN mind_map_nodes n ON n.id = s.node_id
    WHERE n.room_id = ${roomId}::uuid AND (${nodeId ?? null}::uuid IS NULL OR s.node_id = ${nodeId ?? null}::uuid)
    ORDER BY s.updated_at, s.id`;
}
export async function getMindMap(roomId: string, authUserId: string): Promise<MindMapData> {
  const db = getDatabase();
  await requireRoomMember(db, roomId, authUserId);
  const [roomRows, nodeRows, stateRows] = await Promise.all([
    db<{ mapVersion: number }[]>`SELECT map_version AS "mapVersion" FROM rooms WHERE id = ${roomId}::uuid`, nodes(db, roomId), states(db, roomId),
  ]);
  return { roomId, mapVersion: roomRows[0]?.mapVersion ?? 0, nodes: nodeRows.map(nodeDto), participantStates: stateRows.map(publicState) };
}
export async function getNode(roomId: string, nodeId: string, authUserId: string): Promise<NodeData> {
  const db = getDatabase();
  const me = await requireRoomMember(db, roomId, authUserId);
  const [nodeRows, stateRows, sessions] = await Promise.all([
    nodes(db, roomId, nodeId), states(db, roomId, nodeId),
    db<{ id: string }[]>`SELECT id FROM mediation_sessions WHERE room_id = ${roomId}::uuid AND node_id = ${nodeId}::uuid
      AND status IN ('proposed', 'starting', 'active') ORDER BY created_at DESC LIMIT 1`,
  ]);
  if (!nodeRows[0]) throw new ApiProblem({ status: 404, code: "NODE_NOT_FOUND", message: "Discussion node not found." });
  const self = stateRows.find((state) => state.participantId === me.id) ?? null;
  return { node: nodeDto(nodeRows[0]), participantStates: stateRows.map(publicState),
    selfState: self ? privateState(self) : null, activeMediationSessionId: sessions[0]?.id ?? null };
}

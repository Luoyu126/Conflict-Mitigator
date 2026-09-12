import "server-only";

import type {
  MediationMember, MediationSession, MindMapNode, ParticipantNodeState,
  PublicParticipantNodeState, RoomStatus,
} from "../../contracts/rooms.ts";
import type {
  ChatCompletedData, ChatPendingData, ConsensusTree, MediationMeData,
  PrivateMessage, PrivateMessagePage, SessionData,
} from "../../contracts/mediation.ts";
import type { DatabaseExecutor } from "../../lib/db/postgres.ts";
import { getDatabase } from "../../lib/db/postgres.ts";
import { requireRoomMember } from "../../lib/db/repositories/membership.ts";
import { emitRoomEvent } from "../../lib/db/repositories/room-events.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { generatePrivateReply, type PrivateMediationOutput } from "../../lib/agents/mediation-agent.ts";
import { synthesizeConsensusTree, synthesizeSharedSummary } from "../../lib/agents/consensus.ts";

type NodeRow = Omit<MindMapNode, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
type SessionRow = {
  id: string; roomId: string; nodeId: string; status: MediationSession["status"];
  triggerReason: string | null; sharedSummary: string | null; summaryVersion: number;
  createdAt: Date; expiresAt: Date | null; startedAt: Date | null; endedAt: Date | null;
  transitionError: string | null; consensusTree: ConsensusTree | null; consensusTreeVersion: number;
};
type MemberRow = Omit<MediationMember, "updatedAt" | "isolatedAt"> & { updatedAt: Date; isolatedAt: Date | null };
type StateRow = Omit<ParticipantNodeState, "updatedAt"> & { updatedAt: Date };
type MessageRow = Omit<PrivateMessage, "createdAt"> & { createdAt: Date };

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function nodeDto(row: NodeRow): MindMapNode {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function memberDto(row: MemberRow): MediationMember {
  return { ...row, isolatedAt: iso(row.isolatedAt), updatedAt: row.updatedAt.toISOString() };
}
function sessionDto(row: SessionRow, members: MemberRow[]): MediationSession {
  return {
    id: row.id, roomId: row.roomId, nodeId: row.nodeId, status: row.status,
    triggerReason: row.triggerReason, sharedSummary: row.sharedSummary, summaryVersion: row.summaryVersion,
    createdAt: row.createdAt.toISOString(), expiresAt: iso(row.expiresAt), startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt), members: members.map(memberDto), transitionError: row.transitionError,
  };
}
function stateDto(row: StateRow): ParticipantNodeState {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}
function publicStateDto(row: StateRow): PublicParticipantNodeState {
  return {
    id: row.id, nodeId: row.nodeId, participantId: row.participantId, position: row.position,
    supportingReasons: row.supportingReasons, underlyingConcerns: row.underlyingConcerns,
    acceptableCompromises: row.acceptableCompromises, updatedAt: row.updatedAt.toISOString(),
  };
}
function messageDto(row: MessageRow): PrivateMessage {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

const sessionColumns = `id, room_id AS "roomId", node_id AS "nodeId", status, trigger_reason AS "triggerReason",
  shared_summary AS "sharedSummary", summary_version AS "summaryVersion", created_at AS "createdAt",
  expires_at AS "expiresAt", started_at AS "startedAt", ended_at AS "endedAt", transition_error AS "transitionError",
  consensus_tree AS "consensusTree", consensus_tree_version AS "consensusTreeVersion"`;

async function loadNode(db: DatabaseExecutor, roomId: string, nodeId: string): Promise<NodeRow | null> {
  const rows = await db<NodeRow[]>`SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", topic, summary,
    status, contention_score AS "contentionScore", readiness_score AS "readinessScore",
    discussion_loop_count AS "discussionLoopCount", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM mind_map_nodes WHERE id = ${nodeId}::uuid AND room_id = ${roomId}::uuid LIMIT 1`;
  return rows[0] ?? null;
}
async function loadSession(db: DatabaseExecutor, roomId: string, sessionId: string): Promise<SessionRow | null> {
  const rows = await db.unsafe<SessionRow[]>(`SELECT ${sessionColumns} FROM mediation_sessions WHERE id = $1::uuid AND room_id = $2::uuid LIMIT 1`, [sessionId, roomId]);
  return rows[0] ?? null;
}
async function loadMembers(db: DatabaseExecutor, sessionId: string): Promise<MemberRow[]> {
  return db<MemberRow[]>`SELECT participant_id AS "participantId", entry_decision AS "entryDecision",
    resume_decision AS "resumeDecision", accepted_summary_version AS "acceptedSummaryVersion",
    isolated_at AS "isolatedAt", updated_at AS "updatedAt" FROM mediation_members
    WHERE mediation_session_id = ${sessionId}::uuid ORDER BY updated_at, participant_id`;
}
async function loadStates(db: DatabaseExecutor, nodeId: string): Promise<StateRow[]> {
  return db<StateRow[]>`SELECT id, node_id AS "nodeId", participant_id AS "participantId", position,
    supporting_reasons AS "supportingReasons", underlying_concerns AS "underlyingConcerns",
    emotion_intensity AS "emotionIntensity", view_of_others AS "viewOfOthers",
    acceptable_compromises AS "acceptableCompromises", updated_at AS "updatedAt"
    FROM participant_node_states WHERE node_id = ${nodeId}::uuid ORDER BY updated_at, id`;
}
async function loadRoomStatus(db: DatabaseExecutor, roomId: string): Promise<RoomStatus> {
  const rows = await db<{ status: RoomStatus }[]>`SELECT status FROM rooms WHERE id = ${roomId}::uuid LIMIT 1`;
  if (!rows[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  return rows[0].status;
}

type LoadedSession = { session: SessionRow; members: MemberRow[]; node: NodeRow };
type MemberLoadedSession = LoadedSession & { me: string };
async function requireSession(db: DatabaseExecutor, roomId: string, sessionId: string): Promise<LoadedSession> {
  const session = await loadSession(db, roomId, sessionId);
  if (!session) throw new ApiProblem({ status: 404, code: "NOT_FOUND", message: "Mediation session not found." });
  const [members, node] = await Promise.all([loadMembers(db, sessionId), loadNode(db, roomId, session.nodeId)]);
  if (!node) throw new ApiProblem({ status: 404, code: "NODE_NOT_FOUND", message: "Discussion node not found." });
  return { session, members, node };
}
async function requireMemberSession(db: DatabaseExecutor, roomId: string, sessionId: string, authUserId: string): Promise<LoadedSession & { me: string }> {
  const me = await requireRoomMember(db, roomId, authUserId, { active: true });
  const loaded = await requireSession(db, roomId, sessionId);
  if (!loaded.members.some((member) => member.participantId === me.id)) {
    throw new ApiProblem({ status: 403, code: "FORBIDDEN", message: "You are not a member of this mediation session." });
  }
  return { ...loaded, me: me.id };
}

async function buildSessionData(db: DatabaseExecutor, loaded: LoadedSession): Promise<SessionData> {
  return { session: sessionDto(loaded.session, loaded.members), node: nodeDto(loaded.node), roomStatus: await loadRoomStatus(db, loaded.session.roomId) };
}

// --- API-12 resolve current/latest mediation for a node ---
export async function resolveMediation(roomId: string, nodeId: string, authUserId: string): Promise<{ session: MediationSession | null; isMember: boolean }> {
  const db = getDatabase();
  const me = await requireRoomMember(db, roomId, authUserId);
  const sessions = await db<{ id: string }[]>`SELECT id FROM mediation_sessions WHERE room_id = ${roomId}::uuid AND node_id = ${nodeId}::uuid
    ORDER BY (status IN ('proposed', 'starting', 'active')) DESC, created_at DESC LIMIT 1`;
  if (!sessions[0]) return { session: null, isMember: false };
  const loaded = await requireSession(db, roomId, sessions[0].id);
  return { session: sessionDto(loaded.session, loaded.members), isMember: loaded.members.some((member) => member.participantId === me.id) };
}

// --- API-13 propose ---
export async function proposeMediation(
  db: DatabaseExecutor, roomId: string, nodeId: string, authUserId: string,
  participantIds: string[], reason?: string,
): Promise<SessionData> {
  const me = await requireRoomMember(db, roomId, authUserId, { active: true });
  const node = await loadNode(db, roomId, nodeId);
  if (!node) throw new ApiProblem({ status: 404, code: "NODE_NOT_FOUND", message: "Discussion node not found." });
  if (node.status !== "heated") throw new ApiProblem({ status: 409, code: "NODE_NOT_HEATED", message: "This node is not heated." });
  if (!participantIds.includes(me.id)) throw new ApiProblem({ status: 422, code: "PARTICIPANT_NOT_ELIGIBLE", message: "You must be included in the proposal." });
  const active = await db<{ id: string }[]>`SELECT id FROM participants WHERE room_id = ${roomId}::uuid AND status = 'active'`;
  const activeIds = new Set(active.map((row) => row.id));
  if (participantIds.some((id) => !activeIds.has(id))) throw new ApiProblem({ status: 422, code: "PARTICIPANT_NOT_ELIGIBLE", message: "Every proposed participant must be an active room member." });

  let sessionId: string;
  try {
    const inserted = await db<{ id: string }[]>`INSERT INTO mediation_sessions (room_id, node_id, status, trigger_reason, expires_at)
      VALUES (${roomId}::uuid, ${nodeId}::uuid, 'proposed', ${reason ?? node.summary ?? node.topic}, clock_timestamp() + interval '120 seconds') RETURNING id`;
    sessionId = inserted[0].id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ApiProblem({ status: 409, code: "MEDIATION_ALREADY_OPEN", message: "A mediation session is already open for this room." });
    throw error;
  }
  for (const pid of participantIds) {
    await db`INSERT INTO mediation_members (mediation_session_id, participant_id, entry_decision)
      VALUES (${sessionId}::uuid, ${pid}::uuid, ${pid === me.id ? "accept" : "pending"})`;
  }
  await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: sessionId });
  return buildSessionData(db, await requireSession(db, roomId, sessionId));
}

// --- API-14 accept/decline ---
export async function recordEntryDecision(
  db: DatabaseExecutor, roomId: string, sessionId: string, authUserId: string, decision: "accept" | "decline",
): Promise<{ session: SessionData; triggeredStarting: boolean }> {
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  if (loaded.session.status !== "proposed") throw new ApiProblem({ status: 409, code: "SESSION_STATE_CONFLICT", message: "This session is no longer awaiting entry decisions." });
  if (loaded.session.expiresAt && loaded.session.expiresAt.getTime() < Date.now()) {
    await cancelSessionInternal(db, loaded, "PROPOSAL_EXPIRED");
    throw new ApiProblem({ status: 409, code: "PROPOSAL_EXPIRED", message: "The mediation proposal expired." });
  }
  const me = loaded.me;
  if (decision === "decline") {
    await cancelSessionInternal(db, loaded, "MEMBER_DECLINED");
    return { session: await buildSessionData(db, await requireSession(db, roomId, sessionId)), triggeredStarting: false };
  }
  await db`UPDATE mediation_members SET entry_decision = 'accept' WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${me}::uuid`;
  const members = await loadMembers(db, sessionId);
  const allAccepted = members.every((member) => member.entryDecision === "accept");
  if (allAccepted) {
    await db`UPDATE mediation_sessions SET status = 'starting', updated_at = clock_timestamp() WHERE id = ${sessionId}::uuid`;
    await db`UPDATE participants SET media_isolated = true WHERE id IN (SELECT participant_id FROM mediation_members WHERE mediation_session_id = ${sessionId}::uuid)`;
    await db`UPDATE rooms SET status = 'mediation', active_mediation_session_id = ${sessionId}::uuid, active_mediation_node_id = ${loaded.node.id}::uuid WHERE id = ${roomId}::uuid`;
    await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: sessionId });
  }
  return { session: await buildSessionData(db, await requireSession(db, roomId, sessionId)), triggeredStarting: allAccepted };
}

async function cancelSessionInternal(db: DatabaseExecutor, loaded: LoadedSession, errorCode: string): Promise<void> {
  await db`UPDATE mediation_sessions SET status = 'cancelled', ended_at = clock_timestamp(), transition_error = ${errorCode} WHERE id = ${loaded.session.id}::uuid`;
  await db`UPDATE participants SET media_isolated = false, media_token_not_before = clock_timestamp() WHERE id IN (SELECT participant_id FROM mediation_members WHERE mediation_session_id = ${loaded.session.id}::uuid)`;
  await db`UPDATE mind_map_nodes SET status = 'heated', readiness_score = NULL WHERE id = ${loaded.node.id}::uuid`;
  await db`UPDATE rooms SET status = CASE WHEN status = 'ended' THEN 'ended' ELSE 'meeting' END, active_mediation_session_id = NULL, active_mediation_node_id = NULL WHERE id = ${loaded.session.roomId}::uuid`;
  await emitRoomEvent(db, loaded.session.roomId, "room.mediation.changed", { mediationSessionId: loaded.session.id });
}

// --- API-15 me ---
export async function getMediationMe(roomId: string, sessionId: string, authUserId: string): Promise<MediationMeData> {
  const db = getDatabase();
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  const states = await loadStates(db, loaded.node.id);
  const selfState = states.find((state) => state.participantId === loaded.me) ?? null;
  const others = states.filter((state) => state.participantId !== loaded.me).map(publicStateDto);
  const closed = loaded.session.status === "completed" || loaded.session.status === "cancelled";
  const active = loaded.session.status === "active";
  const meRow = await db<{ structuredSharingConsent: boolean }[]>`SELECT structured_sharing_consent AS "structuredSharingConsent" FROM participants WHERE id = ${loaded.me}::uuid LIMIT 1`;
  const chatAllowed = active && (meRow[0]?.structuredSharingConsent ?? false);
  const canAcceptResume = active && loaded.node.status === "ready_to_resume" && loaded.session.sharedSummary !== null;
  return {
    session: sessionDto(loaded.session, loaded.members), node: nodeDto(loaded.node),
    selfState: selfState ? stateDto(selfState) : null, others,
    chatAllowed, canAcceptResume,
    navigationPath: closed ? `/room/${roomId}` : `/room/${roomId}/mediation/${loaded.node.id}`,
    consensusTree: loaded.session.consensusTree,
  };
}

// --- API-16 messages ---
export async function listPrivateMessages(
  roomId: string, sessionId: string, authUserId: string, options: { limit: number; before?: string },
): Promise<PrivateMessagePage> {
  const db = getDatabase();
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  const cursor = options.before ? decodeMessageCursor(options.before) : null;
  const rows = await db<MessageRow[]>`SELECT id, mediation_session_id AS "mediationSessionId", participant_id AS "participantId",
    role, content, client_message_id AS "clientMessageId", reply_to_message_id AS "replyToMessageId",
    reply_status AS "replyStatus", created_at AS "createdAt"
    FROM private_messages WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${loaded.me}::uuid
      AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    ORDER BY created_at DESC, id DESC LIMIT ${options.limit + 1}`;
  const hasMore = rows.length > options.limit;
  const selected = rows.slice(0, options.limit);
  const oldest = selected.at(-1);
  return {
    items: selected.reverse().map(messageDto),
    pageInfo: { hasMore, nextBeforeCursor: hasMore && oldest ? encodeMessageCursor(oldest) : null },
  };
}
type MessageCursor = { createdAt: string; id: string };
function encodeMessageCursor(row: MessageRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}
function decodeMessageCursor(value: string): MessageCursor {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as MessageCursor;
  } catch {
    throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "The message cursor is invalid.", issues: [{ path: "before", reason: "Must be a cursor returned by this API." }] });
  }
}

// --- API-17 send message ---
export type PrivateAgent = (input: Parameters<typeof generatePrivateReply>[0]) => Promise<PrivateMediationOutput>;
export type SendMessageResult =
  | { status: 201 | 200; data: ChatCompletedData }
  | { status: 202; data: ChatPendingData };

export async function sendPrivateMessage(
  roomId: string, sessionId: string, authUserId: string, clientMessageId: string, content: string,
  agent: PrivateAgent = generatePrivateReply,
): Promise<SendMessageResult> {
  const db = getDatabase();
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  if (loaded.session.status !== "active") throw new ApiProblem({ status: 409, code: "SESSION_NOT_ACTIVE", message: "This mediation session is not accepting messages." });
  const meRow = await db<{ structuredSharingConsent: boolean }[]>`SELECT structured_sharing_consent AS "structuredSharingConsent" FROM participants WHERE id = ${loaded.me}::uuid LIMIT 1`;
  if (!(meRow[0]?.structuredSharingConsent ?? false)) throw new ApiProblem({ status: 403, code: "SHARING_CONSENT_REQUIRED", message: "Structured sharing consent is required." });

  const existing = await db<{ id: string; replyStatus: PrivateMessage["replyStatus"] }[]>`SELECT id, reply_status AS "replyStatus"
    FROM private_messages WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${loaded.me}::uuid
    AND client_message_id = ${clientMessageId}::uuid AND role = 'user' LIMIT 1`;

  if (existing[0]?.replyStatus === "completed") return { status: 200, data: await loadCompleted(db, loaded, existing[0].id) };
  if (existing[0]?.replyStatus === "pending") return { status: 202, data: { userMessage: await loadMessageDto(db, existing[0].id), retryAfterMs: 500, consensusTreeVersion: loaded.session.consensusTreeVersion } };

  let userMessageId: string;
  if (existing[0]) {
    userMessageId = existing[0].id;
    await db`UPDATE private_messages SET content = ${content}, reply_status = 'pending' WHERE id = ${userMessageId}::uuid`;
  } else {
    const inserted = await db<{ id: string }[]>`INSERT INTO private_messages (mediation_session_id, participant_id, role, content, client_message_id, reply_status)
      VALUES (${sessionId}::uuid, ${loaded.me}::uuid, 'user', ${content}, ${clientMessageId}::uuid, 'pending') RETURNING id`;
    userMessageId = inserted[0].id;
  }

  const states = await loadStates(db, loaded.node.id);
  const selfState = states.find((state) => state.participantId === loaded.me) ?? null;
  const others = states.filter((state) => state.participantId !== loaded.me).map(publicStateDto);
  const history = await db<{ role: "user" | "assistant"; content: string }[]>`SELECT role, content FROM private_messages
    WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${loaded.me}::uuid ORDER BY created_at, id LIMIT 20`;

  let result: PrivateMediationOutput;
  try {
    result = await Promise.race([
      agent({
        nodeTopic: loaded.node.topic, selfState: selfState ? stateDto(selfState) : null, others,
        history: history.map((message) => ({ role: message.role, content: message.content })), userMessage: content,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MODEL_TIMEOUT")), 25_000)),
    ]);
  } catch (error) {
    const timedOut = (error as Error).message === "MODEL_TIMEOUT";
    await db`UPDATE private_messages SET reply_status = 'failed' WHERE id = ${userMessageId}::uuid`;
    throw new ApiProblem({ status: timedOut ? 504 : 503, code: timedOut ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE", message: timedOut ? "The mediator timed out." : "The mediator is unavailable.", retryable: true, userMessageId });
  }

  const assistantId = await persistExtraction(db, loaded, userMessageId, result);
  return { status: 201, data: await loadCompleted(db, loaded, userMessageId, assistantId) };
}

async function persistExtraction(db: DatabaseExecutor, loaded: MemberLoadedSession, userMessageId: string, result: PrivateMediationOutput): Promise<string> {
  const assistant = await db<{ id: string }[]>`INSERT INTO private_messages (mediation_session_id, participant_id, role, content, reply_to_message_id, reply_status)
    VALUES (${loaded.session.id}::uuid, ${loaded.me}::uuid, 'assistant', ${result.reply}, ${userMessageId}::uuid, 'completed') RETURNING id`;
  const assistantId = assistant[0].id;
  const existingState = await db<{ id: string }[]>`SELECT id FROM participant_node_states WHERE node_id = ${loaded.node.id}::uuid AND participant_id = ${loaded.me}::uuid LIMIT 1`;
  if (existingState[0]) {
    await db`UPDATE participant_node_states SET position = ${result.structured.position}, supporting_reasons = ${db.json(result.structured.supportingReasons)},
      underlying_concerns = ${db.json(result.structured.underlyingConcerns)}, acceptable_compromises = ${db.json(result.structured.acceptableCompromises)}
      WHERE id = ${existingState[0].id}::uuid`;
  } else {
    await db`INSERT INTO participant_node_states (node_id, participant_id, position, supporting_reasons, underlying_concerns, acceptable_compromises)
      VALUES (${loaded.node.id}::uuid, ${loaded.me}::uuid, ${result.structured.position}, ${db.json(result.structured.supportingReasons)},
        ${db.json(result.structured.underlyingConcerns)}, ${db.json(result.structured.acceptableCompromises)})`;
  }
  await db`UPDATE private_messages SET reply_status = 'completed' WHERE id = ${userMessageId}::uuid`;
  await refreshConsensusAndSummary(db, loaded);
  return assistantId;
}

async function refreshConsensusAndSummary(db: DatabaseExecutor, loaded: LoadedSession): Promise<void> {
  const states = await loadStates(db, loaded.node.id);
  const members = loaded.members.map((member) => member.participantId);
  const memberStates = states.filter((state) => members.includes(state.participantId)).map(publicStateDto);
  const tree = synthesizeConsensusTree(nodeDto(loaded.node), memberStates, loaded.session.consensusTreeVersion + 1, new Date().toISOString());
  const allHaveInsight = members.every((pid) => {
    const state = states.find((item) => item.participantId === pid);
    return state && (state.position !== null || state.underlyingConcerns.length > 0 || state.acceptableCompromises.length > 0);
  });
  const nextSummaryVersion = allHaveInsight ? loaded.session.summaryVersion + 1 : loaded.session.summaryVersion;
  const nextSummary = allHaveInsight ? synthesizeSharedSummary(nodeDto(loaded.node), memberStates) : loaded.session.sharedSummary;
  const readyToResume = allHaveInsight;
  await db`UPDATE mediation_sessions SET consensus_tree = ${db.json(tree)}, consensus_tree_version = ${tree.version},
    consensus_tree_generated_at = clock_timestamp(), shared_summary = ${nextSummary}, summary_version = ${nextSummaryVersion}
    WHERE id = ${loaded.session.id}::uuid`;
  if (readyToResume) {
    await db`UPDATE mind_map_nodes SET status = 'ready_to_resume', readiness_score = 1 WHERE id = ${loaded.node.id}::uuid`;
  }
  await emitRoomEvent(db, loaded.session.roomId, "mediation.consensus-tree.changed", { mediationSessionId: loaded.session.id });
}

async function loadMessageDto(db: DatabaseExecutor, messageId: string): Promise<PrivateMessage> {
  const rows = await db<MessageRow[]>`SELECT id, mediation_session_id AS "mediationSessionId", participant_id AS "participantId",
    role, content, client_message_id AS "clientMessageId", reply_to_message_id AS "replyToMessageId",
    reply_status AS "replyStatus", created_at AS "createdAt" FROM private_messages WHERE id = ${messageId}::uuid LIMIT 1`;
  return messageDto(rows[0]);
}

async function loadCompleted(db: DatabaseExecutor, loaded: MemberLoadedSession, userMessageId: string, assistantId?: string): Promise<ChatCompletedData> {
  const userMessage = await loadMessageDto(db, userMessageId);
  let assistantMessage: PrivateMessage;
  if (assistantId) {
    assistantMessage = await loadMessageDto(db, assistantId);
  } else {
    const rows = await db<MessageRow[]>`SELECT id, mediation_session_id AS "mediationSessionId", participant_id AS "participantId",
      role, content, client_message_id AS "clientMessageId", reply_to_message_id AS "replyToMessageId",
      reply_status AS "replyStatus", created_at AS "createdAt" FROM private_messages
      WHERE mediation_session_id = ${loaded.session.id}::uuid AND participant_id = ${loaded.me}::uuid
      AND reply_to_message_id = ${userMessageId}::uuid AND role = 'assistant' LIMIT 1`;
    assistantMessage = messageDto(rows[0]);
  }
  const states = await loadStates(db, loaded.node.id);
  const selfState = states.find((state) => state.participantId === loaded.me);
  if (!selfState) throw new Error("Self state disappeared.");
  const [freshSession, members] = await Promise.all([
    loadSession(db, loaded.session.roomId, loaded.session.id),
    loadMembers(db, loaded.session.id),
  ]);
  if (!freshSession) throw new Error("Mediation session disappeared.");
  return {
    userMessage, assistantMessage, selfState: stateDto(selfState), node: nodeDto(loaded.node),
    session: sessionDto(freshSession, members),
    consensusTreeVersion: freshSession.consensusTreeVersion,
  };
}

// --- API-18 resume ---
export async function recordResumeDecision(
  db: DatabaseExecutor, roomId: string, sessionId: string, authUserId: string, decision: "accept" | "wait", summaryVersion: number,
): Promise<SessionData> {
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  if (loaded.session.status !== "active") throw new ApiProblem({ status: 409, code: "SESSION_STATE_CONFLICT", message: "This session is not active." });
  if (loaded.session.sharedSummary === null || loaded.session.summaryVersion < 1) throw new ApiProblem({ status: 409, code: "NOT_READY", message: "No shared summary is ready." });
  if (loaded.node.status !== "ready_to_resume") throw new ApiProblem({ status: 409, code: "NOT_READY", message: "The node is not ready to resume." });
  if (summaryVersion !== loaded.session.summaryVersion) throw new ApiProblem({ status: 409, code: "SUMMARY_VERSION_CONFLICT", message: "The summary version is stale." });

  if (decision === "wait") {
    await db`UPDATE mediation_members SET resume_decision = 'wait' WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${loaded.me}::uuid`;
    return buildSessionData(db, await requireSession(db, roomId, sessionId));
  }
  await db`UPDATE mediation_members SET resume_decision = 'accept', accepted_summary_version = ${summaryVersion} WHERE mediation_session_id = ${sessionId}::uuid AND participant_id = ${loaded.me}::uuid`;
  const members = await loadMembers(db, sessionId);
  const allAccepted = members.every((member) => member.resumeDecision === "accept" && member.acceptedSummaryVersion === summaryVersion);
  if (allAccepted) {
    await db`UPDATE mediation_sessions SET status = 'completed', ended_at = clock_timestamp() WHERE id = ${sessionId}::uuid`;
    await db`UPDATE mind_map_nodes SET status = 'normal', readiness_score = NULL, discussion_loop_count = 0 WHERE id = ${loaded.node.id}::uuid`;
    await db`UPDATE participants SET media_isolated = false, media_token_not_before = clock_timestamp() WHERE id IN (SELECT participant_id FROM mediation_members WHERE mediation_session_id = ${sessionId}::uuid)`;
    await db`UPDATE rooms SET status = 'meeting', active_mediation_session_id = NULL, active_mediation_node_id = NULL WHERE id = ${roomId}::uuid`;
    await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: sessionId });
  }
  return buildSessionData(db, await requireSession(db, roomId, sessionId));
}

// --- API-19 cancel ---
export async function cancelMediation(db: DatabaseExecutor, roomId: string, sessionId: string, authUserId: string): Promise<SessionData> {
  const loaded = await requireMemberSession(db, roomId, sessionId, authUserId);
  if (loaded.session.status === "completed" || loaded.session.status === "cancelled") {
    return buildSessionData(db, loaded);
  }
  const isHost = (await db<{ role: string }[]>`SELECT role FROM participants WHERE id = ${loaded.me}::uuid LIMIT 1`)[0]?.role === "host";
  const isMember = loaded.members.some((member) => member.participantId === loaded.me);
  if (!isMember && !isHost) throw new ApiProblem({ status: 403, code: "FORBIDDEN", message: "Only members or the host can cancel mediation." });
  await cancelSessionInternal(db, loaded, "CANCELLED_BY_PARTICIPANT");
  return buildSessionData(db, await requireSession(db, roomId, sessionId));
}

import "server-only";

import { WebhookReceiver } from "livekit-server-sdk";
import type {
  IsolationAckData, IsolationAckRequest, MeetingAnalysisData, MeetingAnalysisRequest,
  TranscriptAcceptedData, TranscriptIngestRequest, WorkerContext, WorkerLeaseData, WorkerStatusRequest,
} from "../../contracts/worker.ts";
import type { MindMapNode, ParticipantNodeState, PublicParticipantNodeState, Room, TranscriptSegment } from "../../contracts/rooms.ts";
import type { DatabaseExecutor } from "../../lib/db/postgres.ts";
import { emitRoomEvent } from "../../lib/db/repositories/room-events.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { synthesizeConsensusTree } from "../../lib/agents/consensus.ts";

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const unixSec = () => Math.floor(Date.now() / 1000);

type RoomRow = Omit<Room, "observer" | "createdAt" | "updatedAt" | "mediaEpochAt"> & {
  createdAt: Date; updatedAt: Date; mediaEpochAt: Date | null;
  observerStatus: Room["observer"]["status"] | null; audioStatus: Room["observer"]["audio"] | null;
  videoStatus: Room["observer"]["video"] | null; meetingAgentStatus: Room["observer"]["meetingAgent"] | null;
  lastHeartbeatAt: Date | null;
};
type NodeRow = Omit<MindMapNode, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
type StateRow = Omit<ParticipantNodeState, "updatedAt"> & { updatedAt: Date };
type SegmentRow = Omit<TranscriptSegment, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

function roomDto(row: RoomRow): Room {
  return {
    id: row.id, title: row.title, status: row.status, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), mediaEpochAt: iso(row.mediaEpochAt),
    activeMediationSessionId: row.activeMediationSessionId, activeMediationNodeId: row.activeMediationNodeId,
    observer: {
      status: row.observerStatus ?? "idle", audio: row.audioStatus ?? "disabled",
      video: row.videoStatus ?? "disabled", meetingAgent: row.meetingAgentStatus ?? "disabled",
      lastHeartbeatAt: iso(row.lastHeartbeatAt),
    },
  };
}
function nodeDto(row: NodeRow): MindMapNode {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
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
function segmentDto(row: SegmentRow): TranscriptSegment {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function requireWorkerLease(db: DatabaseExecutor, roomId: string, runId: string): Promise<void> {
  const rows = await db<{ runId: string; leaseExpiresAt: Date }[]>`SELECT run_id AS "runId", lease_expires_at AS "leaseExpiresAt" FROM worker_leases WHERE room_id = ${roomId}::uuid LIMIT 1`;
  const lease = rows[0];
  if (!lease || lease.runId !== runId || lease.leaseExpiresAt.getTime() < Date.now()) {
    throw new ApiProblem({ status: 409, code: "WORKER_LEASE_CONFLICT", message: "The worker lease is invalid or expired.", retryable: true });
  }
}

export { requireWorkerLease as requireWorkerLeaseForRoute };

// --- API-20 worker-status / lease ---
export async function upsertWorkerLease(db: DatabaseExecutor, roomId: string, input: WorkerStatusRequest): Promise<WorkerLeaseData> {
  const room = await db<{ status: Room["status"] }[]>`SELECT status FROM rooms WHERE id = ${roomId}::uuid LIMIT 1`;
  if (!room[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  const existing = await db<{ runId: string; leaseExpiresAt: Date }[]>`SELECT run_id AS "runId", lease_expires_at AS "leaseExpiresAt" FROM worker_leases WHERE room_id = ${roomId}::uuid FOR UPDATE`;
  if (existing[0] && existing[0].runId !== input.runId && existing[0].leaseExpiresAt.getTime() >= Date.now()) {
    throw new ApiProblem({ status: 409, code: "WORKER_LEASE_CONFLICT", message: "Another worker currently holds this room's lease." });
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 30_000);
  const cleanupDone = input.mediaCleanupCompleted === true;
  await db`INSERT INTO worker_leases (room_id, run_id, status, audio_status, video_status, meeting_agent_status, lease_expires_at, last_heartbeat_at, media_cleanup_targets, delete_media_room)
    VALUES (${roomId}::uuid, ${input.runId}::uuid, ${input.status}, ${input.audio}, ${input.video}, ${input.meetingAgent}, ${leaseExpiresAt}, ${now}, '[]'::jsonb, false)
    ON CONFLICT (room_id) DO UPDATE SET run_id = EXCLUDED.run_id, status = EXCLUDED.status, audio_status = EXCLUDED.audio_status,
      video_status = EXCLUDED.video_status, meeting_agent_status = EXCLUDED.meeting_agent_status,
      lease_expires_at = EXCLUDED.lease_expires_at, last_heartbeat_at = EXCLUDED.last_heartbeat_at,
      media_cleanup_targets = CASE WHEN ${cleanupDone} THEN '[]'::jsonb ELSE worker_leases.media_cleanup_targets END,
      delete_media_room = CASE WHEN ${cleanupDone} THEN false ELSE worker_leases.delete_media_room END`;
  return { runId: input.runId, leaseExpiresAt: leaseExpiresAt.toISOString(), observer: { status: input.status, audio: input.audio, video: input.video, meetingAgent: input.meetingAgent, lastHeartbeatAt: now.toISOString() } };
}

// --- API-21 context ---
export async function getWorkerContext(db: DatabaseExecutor, roomId: string, runId: string): Promise<WorkerContext> {
  await requireWorkerLease(db, roomId, runId);
  const roomRows = await db.unsafe<RoomRow[]>(`SELECT r.id, r.title, r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    r.media_epoch_at AS "mediaEpochAt", r.active_mediation_session_id AS "activeMediationSessionId",
    r.active_mediation_node_id AS "activeMediationNodeId", w.status AS "observerStatus", w.audio_status AS "audioStatus",
    w.video_status AS "videoStatus", w.meeting_agent_status AS "meetingAgentStatus", w.last_heartbeat_at AS "lastHeartbeatAt"
    FROM rooms r LEFT JOIN worker_leases w ON w.room_id = r.id WHERE r.id = $1::uuid LIMIT 1`, [roomId]);
  if (!roomRows[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  const mapRows = await db<{ mapVersion: number }[]>`SELECT map_version AS "mapVersion" FROM rooms WHERE id = ${roomId}::uuid`;
  const participants = await db<WorkerContext["participants"]>`SELECT id, livekit_identity AS "livekitIdentity",
    transcription_consent AS "transcriptionConsent", structured_sharing_consent AS "structuredSharingConsent",
    consent_revision AS "consentRevision", media_isolated AS "mediaIsolated"
    FROM participants WHERE room_id = ${roomId}::uuid AND status = 'active' ORDER BY joined_at, id`;
  const nodes = await db<NodeRow[]>`SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", topic, summary, status,
    contention_score AS "contentionScore", readiness_score AS "readinessScore", discussion_loop_count AS "discussionLoopCount",
    created_at AS "createdAt", updated_at AS "updatedAt" FROM mind_map_nodes WHERE room_id = ${roomId}::uuid ORDER BY created_at, id`;
  const participantStates = await db<StateRow[]>`SELECT s.id, s.node_id AS "nodeId", s.participant_id AS "participantId", s.position,
    s.supporting_reasons AS "supportingReasons", s.underlying_concerns AS "underlyingConcerns", s.emotion_intensity AS "emotionIntensity",
    s.view_of_others AS "viewOfOthers", s.acceptable_compromises AS "acceptableCompromises", s.updated_at AS "updatedAt"
    FROM participant_node_states s JOIN mind_map_nodes n ON n.id = s.node_id WHERE n.room_id = ${roomId}::uuid ORDER BY s.updated_at, s.id`;
  const pending = await db<SegmentRow[]>`SELECT id, room_id AS "roomId", participant_id AS "participantId", content,
    started_at_ms AS "startedAtMs", ended_at_ms AS "endedAtMs", is_final AS "isFinal", revision, stream_id::text AS "streamId",
    source_track_sid AS "sourceTrackSid", language, confidence, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM transcript_segments WHERE room_id = ${roomId}::uuid AND is_final AND processed_at IS NULL ORDER BY created_at, id LIMIT 100`;
  const hasMore = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM transcript_segments WHERE room_id = ${roomId}::uuid AND is_final AND processed_at IS NULL`;
  const isolation = await db<{ sessionId: string; targets: { participantId: string; livekitIdentity: string }[] }[]>`SELECT s.id AS "sessionId",
    jsonb_agg(jsonb_build_object('participantId', m.participant_id, 'livekitIdentity', p.livekit_identity)) AS "targets"
    FROM mediation_sessions s JOIN mediation_members m ON m.mediation_session_id = s.id
    JOIN participants p ON p.id = m.participant_id
    WHERE s.room_id = ${roomId}::uuid AND s.status = 'starting' AND m.isolated_at IS NULL GROUP BY s.id LIMIT 1`;
  const cleanup = await db<{ participantId: string; livekitIdentity: string }[]>`SELECT id AS "participantId", livekit_identity AS "livekitIdentity"
    FROM participants WHERE room_id = ${roomId}::uuid AND status = 'left' AND media_isolated = true ORDER BY left_at, id LIMIT 12`;
  const pendingIsolations = isolation[0] && isolation[0].targets?.length
    ? [{ sessionId: isolation[0].sessionId, targets: isolation[0].targets.map((target) => ({ ...target, revokeBeforeUnixSec: unixSec() })) }]
    : [];
  const mediaCleanupTargets = cleanup.map((target) => ({ participantId: target.participantId, livekitIdentity: target.livekitIdentity ?? "", revokeBeforeUnixSec: unixSec() }));
  return {
    room: roomDto(roomRows[0]), mapVersion: mapRows[0]?.mapVersion ?? 0,
    participants, nodes: nodes.map(nodeDto), participantStates: participantStates.map(stateDto),
    pendingTranscripts: pending.map(segmentDto), hasMorePendingTranscripts: hasMore[0].count > 100,
    pendingIsolations, mediaCleanupTargets, deleteMediaRoom: roomRows[0].status === "ended" && mediaCleanupTargets.length > 0,
  };
}

// --- API-22 transcript ingest ---
export async function ingestTranscript(db: DatabaseExecutor, roomId: string, input: TranscriptIngestRequest): Promise<TranscriptAcceptedData> {
  const participant = await db<{ id: string; transcriptionConsent: boolean; consentRevision: number; mediaIsolated: boolean }[]>`SELECT id,
    transcription_consent AS "transcriptionConsent", consent_revision AS "consentRevision", media_isolated AS "mediaIsolated"
    FROM participants WHERE id = ${input.participantIdentity}::uuid AND room_id = ${roomId}::uuid LIMIT 1`;
  if (!participant[0]) throw new ApiProblem({ status: 422, code: "TRACK_IDENTITY_MISMATCH", message: "The participant identity does not match a room member." });
  if (!participant[0].transcriptionConsent || participant[0].consentRevision > input.consentRevision) {
    throw new ApiProblem({ status: 409, code: "CONSENT_REVOKED", message: "Transcription consent is no longer valid for this segment." });
  }
  if (participant[0].mediaIsolated) throw new ApiProblem({ status: 409, code: "MEDIA_ISOLATED", message: "Media is isolated during mediation." });

  let duplicate = false;
  const existing = await db<{ revision: number; content: string }[]>`SELECT revision, content FROM transcript_segments WHERE id = ${input.segmentId}::uuid LIMIT 1`;
  if (existing[0]) {
    if (existing[0].revision > input.revision) throw new ApiProblem({ status: 409, code: "SEGMENT_REVISION_CONFLICT", message: "A newer revision of this segment already exists." });
    if (existing[0].revision === input.revision) {
      if (existing[0].content === input.content) duplicate = true;
      else throw new ApiProblem({ status: 409, code: "SEGMENT_REVISION_CONFLICT", message: "This segment revision conflicts with stored content." });
    }
  }
  if (!duplicate) {
    await db`INSERT INTO transcript_segments (id, room_id, participant_id, content, started_at_ms, ended_at_ms, is_final, revision, stream_id, source_track_sid, language, confidence, consent_revision, received_at)
      VALUES (${input.segmentId}::uuid, ${roomId}::uuid, ${participant[0].id}::uuid, ${input.content}, ${input.startedAtMs}, ${input.endedAtMs}, true,
        ${input.revision}, ${input.streamId}::uuid, ${input.trackSid}, ${input.language}, ${input.confidence}, ${input.consentRevision}, ${input.receivedAt}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, started_at_ms = EXCLUDED.started_at_ms, ended_at_ms = EXCLUDED.ended_at_ms,
        is_final = EXCLUDED.is_final, revision = EXCLUDED.revision, stream_id = EXCLUDED.stream_id, source_track_sid = EXCLUDED.source_track_sid,
        language = EXCLUDED.language, confidence = EXCLUDED.confidence, consent_revision = EXCLUDED.consent_revision, received_at = EXCLUDED.received_at`;
  }
  const segmentRows = await db<SegmentRow[]>`SELECT id, room_id AS "roomId", participant_id AS "participantId", content,
    started_at_ms AS "startedAtMs", ended_at_ms AS "endedAtMs", is_final AS "isFinal", revision, stream_id::text AS "streamId",
    source_track_sid AS "sourceTrackSid", language, confidence, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM transcript_segments WHERE id = ${input.segmentId}::uuid LIMIT 1`;
  return { segment: segmentDto(segmentRows[0]), duplicate, analysisRequired: !duplicate };
}

// --- API-24 meeting analysis ---
export async function submitMeetingAnalysis(db: DatabaseExecutor, roomId: string, input: MeetingAnalysisRequest): Promise<MeetingAnalysisData> {
  const mapRows = await db<{ mapVersion: number }[]>`SELECT map_version AS "mapVersion" FROM rooms WHERE id = ${roomId}::uuid LIMIT 1`;
  if (!mapRows[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  if (mapRows[0].mapVersion !== input.baseMapVersion) throw new ApiProblem({ status: 409, code: "MAP_VERSION_CONFLICT", message: "The map changed since this analysis started." });
  const prior = await db<{ responseBody: unknown }[]>`SELECT response_body AS "responseBody" FROM analysis_receipts WHERE room_id = ${roomId}::uuid AND analysis_id = ${input.analysisId}::uuid LIMIT 1`;
  if (prior[0]) return prior[0].responseBody as MeetingAnalysisData;

  const transcriptRows = await db<{ id: string; isFinal: boolean; processedAt: Date | null }[]>`SELECT id, is_final AS "isFinal", processed_at AS "processedAt"
    FROM transcript_segments WHERE room_id = ${roomId}::uuid AND id = ANY(${input.sourceTranscriptIds}::uuid[])`;
  if (transcriptRows.length !== input.sourceTranscriptIds.length || transcriptRows.some((row) => !row.isFinal || row.processedAt)) {
    throw new ApiProblem({ status: 422, code: "INVALID_EVIDENCE", message: "Source transcripts must be unprocessed final segments from this room." });
  }
  const participantRows = await db<{ id: string }[]>`SELECT id FROM participants WHERE room_id = ${roomId}::uuid`;
  const participantIds = new Set(participantRows.map((row) => row.id));

  const updatedNodeIds: string[] = [];
  for (const upsert of input.nodeUpserts) {
    if (upsert.participantStates.some((state) => !participantIds.has(state.participantId))) {
      throw new ApiProblem({ status: 422, code: "CROSS_ROOM_REFERENCE", message: "A participant state references a non-member." });
    }
    if (upsert.parentNodeId && upsert.parentNodeId === upsert.id) throw new ApiProblem({ status: 422, code: "TREE_CYCLE", message: "A node cannot be its own parent." });
    const status = upsert.contentionScore >= 0.72 ? "heated" : "normal";
    await db`INSERT INTO mind_map_nodes (id, room_id, parent_node_id, topic, summary, status, contention_score, discussion_loop_count)
      VALUES (${upsert.id}::uuid, ${roomId}::uuid, ${upsert.parentNodeId ?? null}::uuid, ${upsert.topic}, ${upsert.summary}, ${status}, ${upsert.contentionScore}, ${upsert.discussionLoopCount})
      ON CONFLICT (id) DO UPDATE SET parent_node_id = EXCLUDED.parent_node_id, topic = EXCLUDED.topic, summary = EXCLUDED.summary,
        contention_score = EXCLUDED.contention_score, discussion_loop_count = EXCLUDED.discussion_loop_count,
        status = CASE WHEN mind_map_nodes.status IN ('private_mediation', 'ready_to_resume') THEN mind_map_nodes.status ELSE EXCLUDED.status END`;
    updatedNodeIds.push(upsert.id);
    for (const state of upsert.participantStates) {
      await db`INSERT INTO participant_node_states (node_id, participant_id, position, supporting_reasons, underlying_concerns, emotion_intensity, view_of_others, acceptable_compromises)
        VALUES (${upsert.id}::uuid, ${state.participantId}::uuid, ${state.position}, ${db.json(state.supportingReasons)}, ${db.json(state.underlyingConcerns)},
          ${state.emotionIntensity}, ${db.json(state.viewOfOthers)}, ${db.json(state.acceptableCompromises)})
        ON CONFLICT (node_id, participant_id) DO UPDATE SET position = EXCLUDED.position, supporting_reasons = EXCLUDED.supporting_reasons,
          underlying_concerns = EXCLUDED.underlying_concerns, emotion_intensity = EXCLUDED.emotion_intensity,
          view_of_others = EXCLUDED.view_of_others, acceptable_compromises = EXCLUDED.acceptable_compromises`;
      for (const transcriptId of state.evidenceTranscriptIds) {
        if (!input.sourceTranscriptIds.includes(transcriptId)) continue;
        await db`INSERT INTO node_transcript_evidence (node_id, transcript_segment_id, analysis_id) VALUES (${upsert.id}::uuid, ${transcriptId}::uuid, ${input.analysisId}::uuid) ON CONFLICT DO NOTHING`;
      }
    }
  }
  await db`UPDATE transcript_segments SET processed_analysis_id = ${input.analysisId}::uuid, processed_at = clock_timestamp()
    WHERE room_id = ${roomId}::uuid AND id = ANY(${input.sourceTranscriptIds}::uuid[])`;
  const bumped = await db<{ mapVersion: number }[]>`UPDATE rooms SET map_version = map_version + 1 WHERE id = ${roomId}::uuid RETURNING map_version AS "mapVersion"`;
  const data: MeetingAnalysisData = { analysisId: input.analysisId, mapVersion: bumped[0].mapVersion, updatedNodeIds, processedTranscriptIds: input.sourceTranscriptIds, duplicate: false };
  await db`INSERT INTO analysis_receipts (room_id, analysis_id, base_map_version, result_map_version, response_body) VALUES (${roomId}::uuid, ${input.analysisId}::uuid, ${input.baseMapVersion}, ${data.mapVersion}, ${db.json(data)})`;
  await autoProposeHeatedNodes(db, roomId);
  return data;
}

async function autoProposeHeatedNodes(db: DatabaseExecutor, roomId: string): Promise<void> {
  const heated = await db<{ id: string; topic: string; summary: string | null }[]>`SELECT n.id, n.topic, n.summary
    FROM mind_map_nodes n
    JOIN node_transcript_evidence e ON e.node_id = n.id
    JOIN transcript_segments t ON t.id = e.transcript_segment_id
    WHERE n.room_id = ${roomId}::uuid AND n.contention_score >= 0.72 AND n.status = 'heated'
    GROUP BY n.id, n.topic, n.summary
    HAVING count(e.transcript_segment_id) >= 3 AND count(DISTINCT t.participant_id) >= 2
    ORDER BY n.updated_at DESC LIMIT 1`;
  if (!heated[0]) return;
  const open = await db<{ id: string }[]>`SELECT id FROM mediation_sessions WHERE room_id = ${roomId}::uuid AND status IN ('proposed', 'starting', 'active') LIMIT 1`;
  if (open[0]) return;
  const active = await db<{ id: string }[]>`SELECT id FROM participants WHERE room_id = ${roomId}::uuid AND status = 'active'`;
  if (active.length < 2) return;
  let sessionId: string;
  try {
    const inserted = await db<{ id: string }[]>`INSERT INTO mediation_sessions (room_id, node_id, status, trigger_reason, expires_at)
      VALUES (${roomId}::uuid, ${heated[0].id}::uuid, 'proposed', ${heated[0].summary ?? heated[0].topic}, clock_timestamp() + interval '120 seconds') RETURNING id`;
    sessionId = inserted[0].id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return;
    throw error;
  }
  for (const participant of active) {
    await db`INSERT INTO mediation_members (mediation_session_id, participant_id, entry_decision) VALUES (${sessionId}::uuid, ${participant.id}::uuid, 'pending')`;
  }
  await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: sessionId });
}

// --- API-25 isolation ack ---
export async function ackIsolation(db: DatabaseExecutor, roomId: string, runId: string, input: IsolationAckRequest): Promise<IsolationAckData> {
  const session = await db<{ id: string; status: string; nodeId: string }[]>`SELECT id, status, node_id AS "nodeId" FROM mediation_sessions
    WHERE id = ${input.sessionId}::uuid AND room_id = ${roomId}::uuid LIMIT 1`;
  if (!session[0]) throw new ApiProblem({ status: 404, code: "NOT_FOUND", message: "Mediation session not found." });
  if (session[0].status !== "starting") throw new ApiProblem({ status: 409, code: "SESSION_STATE_CONFLICT", message: "This session is not awaiting media isolation." });
  const members = await db<{ participantId: string }[]>`SELECT participant_id AS "participantId" FROM mediation_members WHERE mediation_session_id = ${input.sessionId}::uuid`;
  const memberIds = new Set(members.map((member) => member.participantId));
  for (const result of input.results) {
    if (!memberIds.has(result.participantId)) throw new ApiProblem({ status: 409, code: "ISOLATION_TARGET_MISMATCH", message: "An isolation target is not a session member." });
    if (result.succeeded) {
      await db`UPDATE mediation_members SET isolated_at = clock_timestamp() WHERE mediation_session_id = ${input.sessionId}::uuid AND participant_id = ${result.participantId}::uuid AND isolated_at IS NULL`;
      await db`INSERT INTO media_isolation_results (mediation_session_id, participant_id, run_id, succeeded, safe_error_code)
        VALUES (${input.sessionId}::uuid, ${result.participantId}::uuid, ${runId}::uuid, true, null)
        ON CONFLICT (mediation_session_id, participant_id) DO NOTHING`;
    } else {
      await db`INSERT INTO media_isolation_results (mediation_session_id, participant_id, run_id, succeeded, safe_error_code)
        VALUES (${input.sessionId}::uuid, ${result.participantId}::uuid, ${runId}::uuid, false, ${result.errorCode})
        ON CONFLICT (mediation_session_id, participant_id) DO UPDATE SET succeeded = false, safe_error_code = EXCLUDED.safe_error_code`;
    }
  }
  const pending = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM mediation_members WHERE mediation_session_id = ${input.sessionId}::uuid AND isolated_at IS NULL`;
  if (pending[0].count === 0) {
    await db`UPDATE mediation_sessions SET status = 'active', started_at = clock_timestamp() WHERE id = ${input.sessionId}::uuid`;
    await db`UPDATE mind_map_nodes SET status = 'private_mediation' WHERE id = ${session[0].nodeId}::uuid`;
    const nodeRows = await db<NodeRow[]>`SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", topic, summary, status,
      contention_score AS "contentionScore", readiness_score AS "readinessScore", discussion_loop_count AS "discussionLoopCount",
      created_at AS "createdAt", updated_at AS "updatedAt" FROM mind_map_nodes WHERE id = ${session[0].nodeId}::uuid LIMIT 1`;
    const stateRows = await db<StateRow[]>`SELECT id, node_id AS "nodeId", participant_id AS "participantId", position,
      supporting_reasons AS "supportingReasons", underlying_concerns AS "underlyingConcerns", emotion_intensity AS "emotionIntensity",
      view_of_others AS "viewOfOthers", acceptable_compromises AS "acceptableCompromises", updated_at AS "updatedAt"
      FROM participant_node_states WHERE node_id = ${session[0].nodeId}::uuid ORDER BY updated_at, id`;
    const memberStates = stateRows.filter((state) => memberIds.has(state.participantId)).map(publicStateDto);
    const tree = synthesizeConsensusTree(nodeDto(nodeRows[0]), memberStates, 1, new Date().toISOString());
    await db`UPDATE mediation_sessions SET consensus_tree = ${db.json(tree)}, consensus_tree_version = 1, consensus_tree_generated_at = clock_timestamp() WHERE id = ${input.sessionId}::uuid`;
    await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: input.sessionId });
  }
  const node = await db<NodeRow[]>`SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", topic, summary, status,
    contention_score AS "contentionScore", readiness_score AS "readinessScore", discussion_loop_count AS "discussionLoopCount",
    created_at AS "createdAt", updated_at AS "updatedAt" FROM mind_map_nodes WHERE id = ${session[0].nodeId}::uuid LIMIT 1`;
  const sessionRows = await db<{ id: string; roomId: string; nodeId: string; status: "proposed" | "starting" | "active" | "completed" | "cancelled"; triggerReason: string | null; sharedSummary: string | null; summaryVersion: number; createdAt: Date; expiresAt: Date | null; startedAt: Date | null; endedAt: Date | null; transitionError: string | null }[]>`SELECT id, room_id AS "roomId", node_id AS "nodeId", status, trigger_reason AS "triggerReason",
    shared_summary AS "sharedSummary", summary_version AS "summaryVersion", created_at AS "createdAt", expires_at AS "expiresAt",
    started_at AS "startedAt", ended_at AS "endedAt", transition_error AS "transitionError" FROM mediation_sessions WHERE id = ${input.sessionId}::uuid LIMIT 1`;
  const memberRows = await db<{ participantId: string; entryDecision: "pending" | "accept" | "decline"; resumeDecision: "pending" | "accept" | "wait"; acceptedSummaryVersion: number | null; isolatedAt: Date | null; updatedAt: Date }[]>`SELECT participant_id AS "participantId", entry_decision AS "entryDecision", resume_decision AS "resumeDecision",
    accepted_summary_version AS "acceptedSummaryVersion", isolated_at AS "isolatedAt", updated_at AS "updatedAt"
    FROM mediation_members WHERE mediation_session_id = ${input.sessionId}::uuid ORDER BY updated_at, participant_id`;
  const s = sessionRows[0];
  return {
    session: { ...s, createdAt: s.createdAt.toISOString(), expiresAt: iso(s.expiresAt), startedAt: iso(s.startedAt), endedAt: iso(s.endedAt),
      members: memberRows.map((member) => ({ ...member, isolatedAt: iso(member.isolatedAt), updatedAt: member.updatedAt.toISOString() })) },
    node: nodeDto(node[0]),
  };
}

export async function verifyAndRecordWebhook(db: DatabaseExecutor, rawBody: string, authorization: string | null): Promise<void> {
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!apiKey || !apiSecret || !authorization) throw new ApiProblem({ status: 401, code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature is missing." });
  let event: { id?: string; event?: string; room?: { name?: string } };
  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(rawBody, authorization) as typeof event;
  } catch {
    throw new ApiProblem({ status: 401, code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature is invalid." });
  }
  if (event.id) {
    await db`INSERT INTO livekit_webhook_receipts (event_id, event_type, room_name) VALUES (${event.id}, ${event.event ?? "unknown"}, ${event.room?.name ?? null})
      ON CONFLICT (event_id) DO NOTHING`;
  }
}

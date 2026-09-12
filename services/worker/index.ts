import "server-only";
import { getRecentAffect } from "../affect/index.ts";

import { WebhookReceiver } from "livekit-server-sdk";
import type {
  IsolationAckData, IsolationAckRequest, MeetingAnalysisData, MeetingAnalysisRequest,
  TranscriptAcceptedData, TranscriptIngestRequest, WorkerContext, WorkerLeaseData, WorkerStatusRequest,
} from "../../contracts/worker.ts";
import type { MindMapNode, ParticipantNodeState, PublicParticipantNodeState, Room, TranscriptSegment } from "../../contracts/rooms.ts";
import type { DatabaseExecutor, TransactionClient } from "../../lib/db/postgres.ts";
import { emitRoomEvent } from "../../lib/db/repositories/room-events.ts";
import { hashRequestBody } from "../../lib/server/idempotency.ts";
import { transcriptIngestRequestSchema, meetingAnalysisRequestSchema, isolationAckRequestSchema } from "../../contracts/worker.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { synthesizeConsensusTree } from "../../lib/agents/consensus.ts";

const iso = (value: Date | null) => (value ? value.toISOString() : null);
// Every control mutation locks the room before lease/session/participant rows.
// Callers must keep this lock through commit, including the lease check.
async function lockRoom(db: TransactionClient, roomId: string) {
  const rows = await db<{ status: Room["status"]; mapVersion: number }[]>`
    SELECT status, map_version AS "mapVersion" FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  return rows[0];
}
function conflict(code: string, message: string): never {
  throw new ApiProblem({ status: 409, code, message });
}
function invalid(code: string, message: string): never {
  throw new ApiProblem({ status: 422, code, message });
}
function assertMeeting(status: Room["status"]) {
  if (status !== "meeting") conflict(status === "ended" ? "ROOM_ENDED" : "MEDIA_ISOLATED", "The room does not accept public media analysis.");
}

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
  return { ...row, startedAtMs: row.startedAtMs === null ? null : Number(row.startedAtMs),
    endedAtMs: row.endedAtMs === null ? null : Number(row.endedAtMs),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function requireWorkerLease(db: TransactionClient, roomId: string, runId: string): Promise<void> {
  await lockRoom(db, roomId);
  const rows = await db<{ runId: string; valid: boolean }[]>`SELECT run_id AS "runId",
    lease_expires_at > clock_timestamp() AND status <> 'stopped' AS valid
    FROM worker_leases WHERE room_id = ${roomId}::uuid FOR UPDATE`;
  const lease = rows[0];
  if (!lease || lease.runId !== runId || !lease.valid) {
    throw new ApiProblem({ status: 409, code: "WORKER_LEASE_CONFLICT", message: "The worker lease is invalid or expired.", retryable: true });
  }
}

export { requireWorkerLease as requireWorkerLeaseForRoute };

// --- API-20 worker-status / lease ---
export async function upsertWorkerLease(db: TransactionClient, roomId: string, input: WorkerStatusRequest): Promise<WorkerLeaseData> {
  const room = await lockRoom(db, roomId);
  const existing = await db<{ runId: string; valid: boolean; targets: { participantId: string; revokeBeforeUnixSec: number }[]; deleteMediaRoom: boolean }[]>`
    SELECT run_id AS "runId", lease_expires_at > clock_timestamp() AND status <> 'stopped' AS valid,
      media_cleanup_targets AS targets, delete_media_room AS "deleteMediaRoom"
    FROM worker_leases WHERE room_id = ${roomId}::uuid FOR UPDATE`;
  if (existing[0] && existing[0].runId !== input.runId && existing[0].valid) {
    conflict("WORKER_LEASE_CONFLICT", "Another worker currently holds this room's lease.");
  }
  if (input.mediaCleanupCompleted) {
    // A completion acknowledges only the snapshot issued to this still-valid run.
    if (!existing[0]?.valid || existing[0].runId !== input.runId) {
      conflict("WORKER_LEASE_CONFLICT", "A current worker control snapshot is required.");
    }
    for (const target of existing[0].targets) {
      await db`UPDATE participants SET media_cleanup_pending = false,
        media_isolated = EXISTS (SELECT 1 FROM mediation_members m JOIN mediation_sessions s ON s.id=m.mediation_session_id
          WHERE m.participant_id=participants.id AND s.status IN ('starting','active'))
        WHERE id = ${target.participantId}::uuid AND room_id = ${roomId}::uuid
          AND media_cleanup_pending AND floor(extract(epoch FROM media_token_not_before)) = ${target.revokeBeforeUnixSec}`;
    }
    if (existing[0].deleteMediaRoom && room.status === "ended") {
      await db`UPDATE rooms SET media_cleanup_pending = false WHERE id = ${roomId}::uuid`;
    }
  }
  if (room.status === "ended" && input.status !== "stopped") {
    input = { ...input, status: "degraded", audio: "disabled", video: "disabled", meetingAgent: "disabled" };
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 30_000);
  const cleanupDone = input.mediaCleanupCompleted === true;
  await db`INSERT INTO worker_leases (room_id, run_id, status, audio_status, video_status, meeting_agent_status, lease_expires_at, last_heartbeat_at, media_cleanup_targets, delete_media_room)
    VALUES (${roomId}::uuid, ${input.runId}::uuid, ${input.status}, ${input.audio}, ${input.video}, ${input.meetingAgent}, ${leaseExpiresAt}, ${now}, '[]'::jsonb, false)
    ON CONFLICT (room_id) DO UPDATE SET run_id = EXCLUDED.run_id, status = EXCLUDED.status, audio_status = EXCLUDED.audio_status,
      video_status = EXCLUDED.video_status, meeting_agent_status = EXCLUDED.meeting_agent_status,
      lease_expires_at = EXCLUDED.lease_expires_at, last_heartbeat_at = EXCLUDED.last_heartbeat_at,
      media_cleanup_targets = CASE WHEN ${cleanupDone} OR worker_leases.run_id <> EXCLUDED.run_id THEN '[]'::jsonb ELSE worker_leases.media_cleanup_targets END,
      delete_media_room = CASE WHEN ${cleanupDone} OR worker_leases.run_id <> EXCLUDED.run_id THEN false ELSE worker_leases.delete_media_room END`;
  return { runId: input.runId, leaseExpiresAt: leaseExpiresAt.toISOString(), observer: { status: input.status, audio: input.audio, video: input.video, meetingAgent: input.meetingAgent, lastHeartbeatAt: now.toISOString() } };
}

// --- API-21 context ---
export async function getWorkerContext(db: TransactionClient, roomId: string, runId: string): Promise<WorkerContext> {
  await requireWorkerLease(db, roomId, runId);
  const roomRows = await db.unsafe<RoomRow[]>(`SELECT r.id, r.title, r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    r.media_epoch_at AS "mediaEpochAt", r.active_mediation_session_id AS "activeMediationSessionId",
    r.active_mediation_node_id AS "activeMediationNodeId", w.status AS "observerStatus", w.audio_status AS "audioStatus",
    w.video_status AS "videoStatus", w.meeting_agent_status AS "meetingAgentStatus", w.last_heartbeat_at AS "lastHeartbeatAt"
    FROM rooms r LEFT JOIN worker_leases w ON w.room_id = r.id WHERE r.id = $1::uuid LIMIT 1`, [roomId]);
  if (!roomRows[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  const mapRows = await db<{ mapVersion: number }[]>`SELECT map_version AS "mapVersion" FROM rooms WHERE id = ${roomId}::uuid`;
  const participants = await db<WorkerContext["participants"]>`SELECT id, livekit_identity AS "livekitIdentity",
    transcription_consent AS "transcriptionConsent", visual_affect_consent AS "visualAffectConsent",
    voice_affect_consent AS "voiceAffectConsent", structured_sharing_consent AS "structuredSharingConsent",
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
  const isolation = await db<{ sessionId: string; targets: { participantId: string; livekitIdentity: string; revokeBeforeUnixSec: number }[] }[]>`
    SELECT s.id AS "sessionId", jsonb_agg(jsonb_build_object('participantId', m.participant_id,
      'livekitIdentity', p.livekit_identity, 'revokeBeforeUnixSec', m.isolation_cutoff_unix_sec)) AS targets
    FROM mediation_sessions s JOIN mediation_members m ON m.mediation_session_id = s.id
    JOIN participants p ON p.id = m.participant_id AND p.room_id = s.room_id
    WHERE s.room_id = ${roomId}::uuid AND s.status = 'starting' AND m.isolated_at IS NULL
      AND m.isolation_cutoff_unix_sec IS NOT NULL GROUP BY s.id LIMIT 1`;
  const mediaCleanupTargets = await db<{ participantId: string; livekitIdentity: string; revokeBeforeUnixSec: number }[]>`
    SELECT id AS "participantId", livekit_identity AS "livekitIdentity",
      floor(extract(epoch FROM media_token_not_before))::bigint AS "revokeBeforeUnixSec"
    FROM participants WHERE room_id = ${roomId}::uuid AND media_cleanup_pending
      AND isfinite(media_token_not_before) AND livekit_identity IS NOT NULL ORDER BY id`;
  // postgres.js returns bigint as text by default; API cutoffs are JSON numbers.
  for (const target of mediaCleanupTargets) target.revokeBeforeUnixSec = Number(target.revokeBeforeUnixSec);
  const cleanup = await db<{ pending: boolean }[]>`SELECT media_cleanup_pending AS pending FROM rooms WHERE id = ${roomId}::uuid`;
  const pendingIsolations = isolation.map((plan) => ({ ...plan,
    targets: plan.targets.map((target) => ({ ...target, revokeBeforeUnixSec: Number(target.revokeBeforeUnixSec) })) }));
  const deleteMediaRoom = roomRows[0].status === "ended" && cleanup[0].pending;
  await db`UPDATE worker_leases SET media_cleanup_targets = ${db.json(mediaCleanupTargets)}, delete_media_room = ${deleteMediaRoom}
    WHERE room_id = ${roomId}::uuid AND run_id = ${runId}::uuid`;
  return {
    room: roomDto(roomRows[0]), mapVersion: mapRows[0]?.mapVersion ?? 0, recentAffectObservations: await getRecentAffect(db, roomId),
    participants, nodes: nodes.map(nodeDto), participantStates: participantStates.map(stateDto),
    pendingTranscripts: pending.map(segmentDto), hasMorePendingTranscripts: hasMore[0].count > 100,
    pendingIsolations, mediaCleanupTargets, deleteMediaRoom,
  };
}

// --- API-22 transcript ingest ---
export async function ingestTranscript(db: TransactionClient, roomId: string, input: TranscriptIngestRequest): Promise<TranscriptAcceptedData> {
  const parsed = transcriptIngestRequestSchema.safeParse(input);
  if (!parsed.success) invalid("INVALID_REQUEST", "Invalid transcript envelope.");
  input = parsed.data;
  const room = await lockRoom(db, roomId);
  assertMeeting(room.status);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.participantIdentity)
      || !/^TR_[A-Za-z0-9_-]+$/.test(input.trackSid)) {
    invalid("TRACK_IDENTITY_MISMATCH", "A valid participant and microphone track are required.");
  }
  if ((input.startedAtMs === null) !== (input.endedAtMs === null)
      || (input.startedAtMs !== null && input.endedAtMs! < input.startedAtMs)
      || (input.timeBasis === "unknown" && input.startedAtMs !== null)) {
    invalid("INVALID_REQUEST", "Transcript timestamps do not match their time basis.");
  }
  if (Date.parse(input.receivedAt) > Date.now() + 30_000) invalid("INVALID_REQUEST", "Transcript reception time is in the future.");
  const participant = await db<{ id: string; status: string; livekitIdentity: string | null; transcriptionConsent: boolean; consentRevision: number; mediaIsolated: boolean }[]>`
    SELECT id, status, livekit_identity AS "livekitIdentity", transcription_consent AS "transcriptionConsent",
      consent_revision AS "consentRevision", media_isolated AS "mediaIsolated"
    FROM participants WHERE id = ${input.participantIdentity}::uuid AND room_id = ${roomId}::uuid FOR UPDATE`;
  const member = participant[0];
  if (!member || member.status !== "active" || member.livekitIdentity !== input.participantIdentity) {
    invalid("TRACK_IDENTITY_MISMATCH", "The participant identity does not match an active room member.");
  }
  if (!member.transcriptionConsent || member.consentRevision !== input.consentRevision) {
    conflict("CONSENT_REVOKED", "Transcription consent is no longer valid for this segment.");
  }
  if (member.mediaIsolated) conflict("MEDIA_ISOLATED", "Media is isolated during mediation.");
  // The authenticated worker must derive identity and microphone SID from LiveKit,
  // never from packet content. The service additionally pins that binding per segment.
  const existing = await db<{ roomId: string; participantId: string; trackSid: string; streamId: string; revision: number; content: string;
    startedAtMs: string | null; endedAtMs: string | null; language: string | null; confidence: number | null;
    consentRevision: number; receivedAt: Date; timeBasis: string; isFinal: boolean; processedAt: Date | null }[]>`
    SELECT room_id AS "roomId", participant_id AS "participantId", source_track_sid AS "trackSid", stream_id::text AS "streamId",
      revision, content, started_at_ms AS "startedAtMs", ended_at_ms AS "endedAtMs", language, confidence,
      consent_revision AS "consentRevision", received_at AS "receivedAt", time_basis AS "timeBasis", is_final AS "isFinal", processed_at AS "processedAt"
    FROM transcript_segments WHERE id = ${input.segmentId}::uuid FOR UPDATE`;
  const previous = existing[0];
  let duplicate = false;
  if (previous) {
    if (previous.roomId !== roomId || previous.participantId !== member.id || previous.streamId !== input.streamId || previous.trackSid !== input.trackSid) {
      conflict("SEGMENT_REVISION_CONFLICT", "This segment belongs to another media stream.");
    }
    if (previous.revision > input.revision) conflict("SEGMENT_REVISION_CONFLICT", "A newer revision already exists.");
    if (previous.revision === input.revision) {
      duplicate = previous.content === input.content && previous.isFinal === input.isFinal
        && (previous.startedAtMs === null ? null : Number(previous.startedAtMs)) === input.startedAtMs
        && (previous.endedAtMs === null ? null : Number(previous.endedAtMs)) === input.endedAtMs
        && previous.language === input.language && previous.confidence === input.confidence
        && previous.consentRevision === input.consentRevision && previous.timeBasis === input.timeBasis
        && previous.receivedAt.getTime() === Date.parse(input.receivedAt);
      if (!duplicate) conflict("SEGMENT_REVISION_CONFLICT", "This segment revision conflicts with stored metadata.");
    }
  }
  if (!duplicate) {
    const written = await db<{ id: string }[]>`INSERT INTO transcript_segments (id, room_id, participant_id, content, started_at_ms, ended_at_ms, is_final,
      revision, stream_id, source_track_sid, language, confidence, consent_revision, received_at, time_basis)
      VALUES (${input.segmentId}::uuid, ${roomId}::uuid, ${member.id}::uuid, ${input.content}, ${input.startedAtMs}, ${input.endedAtMs}, true,
        ${input.revision}, ${input.streamId}::uuid, ${input.trackSid}, ${input.language}, ${input.confidence}, ${input.consentRevision}, ${input.receivedAt}::timestamptz, ${input.timeBasis})
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, started_at_ms = EXCLUDED.started_at_ms, ended_at_ms = EXCLUDED.ended_at_ms,
        is_final = true, revision = EXCLUDED.revision, language = EXCLUDED.language, confidence = EXCLUDED.confidence,
        consent_revision = EXCLUDED.consent_revision, received_at = EXCLUDED.received_at, time_basis = EXCLUDED.time_basis,
        processed_at = NULL, processed_analysis_id = NULL
      WHERE transcript_segments.room_id = EXCLUDED.room_id AND transcript_segments.participant_id = EXCLUDED.participant_id
        AND transcript_segments.stream_id = EXCLUDED.stream_id AND transcript_segments.source_track_sid = EXCLUDED.source_track_sid
        AND transcript_segments.revision < EXCLUDED.revision RETURNING id`;
    if (!written[0]) conflict("SEGMENT_REVISION_CONFLICT", "A conflicting segment was received concurrently.");
    await emitRoomEvent(db, roomId);
  }
  const segmentRows = await db<SegmentRow[]>`SELECT id, room_id AS "roomId", participant_id AS "participantId", content,
    started_at_ms AS "startedAtMs", ended_at_ms AS "endedAtMs", is_final AS "isFinal", revision, stream_id::text AS "streamId",
    source_track_sid AS "sourceTrackSid", language, confidence, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM transcript_segments WHERE id = ${input.segmentId}::uuid AND room_id = ${roomId}::uuid LIMIT 1`;
  return { segment: segmentDto(segmentRows[0]), duplicate, analysisRequired: !duplicate };
}

// --- API-24 meeting analysis ---
export async function submitMeetingAnalysis(db: TransactionClient, roomId: string, input: MeetingAnalysisRequest): Promise<MeetingAnalysisData> {
  const parsed = meetingAnalysisRequestSchema.safeParse(input);
  if (!parsed.success) invalid("INVALID_REQUEST", "Invalid analysis envelope.");
  input = parsed.data;
  const room = await lockRoom(db, roomId);
  const requestHash = hashRequestBody(input);
  const prior = await db<{ requestHash: string | null; responseBody: MeetingAnalysisData }[]>`
    SELECT request_hash AS "requestHash", response_body AS "responseBody" FROM analysis_receipts
    WHERE room_id = ${roomId}::uuid AND analysis_id = ${input.analysisId}::uuid`;
  if (prior[0]) {
    if (prior[0].requestHash !== requestHash) conflict("ANALYSIS_ID_CONFLICT", "This analysis ID belongs to another request.");
    return { ...prior[0].responseBody, duplicate: true };
  }
  assertMeeting(room.status);
  if (room.mapVersion !== input.baseMapVersion) conflict("MAP_VERSION_CONFLICT", "The map changed since this analysis started.");
  if (new Set(input.sourceTranscriptIds).size !== input.sourceTranscriptIds.length
      || new Set(input.nodeUpserts.map((node) => node.id)).size !== input.nodeUpserts.length) {
    invalid("INVALID_EVIDENCE", "Transcript and node identifiers must be unique.");
  }
  const transcriptRows = await db<{ id: string; participantId: string; isFinal: boolean; processedAt: Date | null; revision: number }[]>`
    SELECT id, participant_id AS "participantId", is_final AS "isFinal", processed_at AS "processedAt", revision
    FROM transcript_segments WHERE room_id = ${roomId}::uuid AND id = ANY(${input.sourceTranscriptIds}::uuid[]) FOR UPDATE`;
  if (transcriptRows.length !== input.sourceTranscriptIds.length || transcriptRows.some((row) => !row.isFinal || row.processedAt)) {
    invalid("INVALID_EVIDENCE", "Source transcripts must be unprocessed final segments from this room.");
  }
  if (input.sourceTranscriptRevisions && (Object.keys(input.sourceTranscriptRevisions).length !== transcriptRows.length ||
      transcriptRows.some(row => input.sourceTranscriptRevisions![row.id] !== row.revision))) {
    conflict("TRANSCRIPT_REVISION_CONFLICT", "A source transcript changed during analysis.");
  }
  const evidence = new Map(transcriptRows.map((row) => [row.id, row.participantId]));
  const participantRows = await db<{ id: string }[]>`SELECT id FROM participants WHERE room_id = ${roomId}::uuid`;
  const participantIds = new Set(participantRows.map((row) => row.id));
  const existingNodes = await db<{ id: string; roomId: string; parentNodeId: string | null; status: string }[]>`
    SELECT id, room_id AS "roomId", parent_node_id AS "parentNodeId", status FROM mind_map_nodes
    WHERE room_id = ${roomId}::uuid OR id = ANY(${input.nodeUpserts.map((node) => node.id)}::uuid[])`;
  const graph = new Map(existingNodes.filter((node) => node.roomId === roomId).map((node) => [node.id, node.parentNodeId]));
  const nodesById = new Map(existingNodes.map((node) => [node.id, node]));
  for (const node of input.nodeUpserts) {
    const old = nodesById.get(node.id);
    if (old && old.roomId !== roomId) invalid("CROSS_ROOM_REFERENCE", "A node belongs to another room.");
    if (old && ["private_mediation", "ready_to_resume"].includes(old.status)) {
      conflict("SESSION_STATE_CONFLICT", "Analysis cannot change a node in private mediation.");
    }
    graph.set(node.id, node.parentNodeId);
    if (new Set(node.participantStates.map((state) => state.participantId)).size !== node.participantStates.length) {
      invalid("INVALID_EVIDENCE", "A participant state can only appear once per node.");
    }
    for (const state of node.participantStates) {
      if (!participantIds.has(state.participantId) || state.viewOfOthers.some((view) => !participantIds.has(view.participantId))) {
        invalid("CROSS_ROOM_REFERENCE", "A participant reference is outside this room.");
      }
      if (!state.evidenceTranscriptIds.length || new Set(state.evidenceTranscriptIds).size !== state.evidenceTranscriptIds.length
          || state.evidenceTranscriptIds.some((id) => evidence.get(id) !== state.participantId)) {
        invalid("INVALID_EVIDENCE", "Each participant state requires that participant's own source transcripts.");
      }
      if (new Set(state.viewOfOthers.map((view) => view.participantId)).size !== state.viewOfOthers.length) {
        invalid("INVALID_EVIDENCE", "References to other participants must be unique.");
      }
    }
  }
  // Check the final graph before any writes, including cycles spanning several upserts.
  for (const [id, parent] of graph) {
    if (parent && !graph.has(parent)) invalid("CROSS_ROOM_REFERENCE", "A parent node is outside this room.");
    const visited = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null) {
      if (visited.has(cursor)) invalid("TREE_CYCLE", "The analysis would create a node cycle.");
      visited.add(cursor);
      cursor = graph.get(cursor) ?? null;
    }
  }
  // Parents inserted in this request must exist before their children.
  const ordered: typeof input.nodeUpserts = [];
  const remaining = new Map(input.nodeUpserts.map((node) => [node.id, node]));
  while (remaining.size) {
    for (const [id, node] of remaining) {
      if (node.parentNodeId && remaining.has(node.parentNodeId)) continue;
      ordered.push(node); remaining.delete(id);
    }
  }
  const updatedNodeIds: string[] = [];
  for (const upsert of ordered) {
    const status = upsert.contentionScore >= 0.72 ? "heated" : "normal";
    const written = await db<{ id: string }[]>`INSERT INTO mind_map_nodes (id, room_id, parent_node_id, topic, summary, status, contention_score, discussion_loop_count)
      VALUES (${upsert.id}::uuid, ${roomId}::uuid, ${upsert.parentNodeId ?? null}::uuid, ${upsert.topic}, ${upsert.summary}, ${status}, ${upsert.contentionScore}, ${upsert.discussionLoopCount})
      ON CONFLICT (id) DO UPDATE SET parent_node_id = EXCLUDED.parent_node_id, topic = EXCLUDED.topic, summary = EXCLUDED.summary,
        contention_score = EXCLUDED.contention_score, discussion_loop_count = EXCLUDED.discussion_loop_count,
        status = EXCLUDED.status WHERE mind_map_nodes.room_id = EXCLUDED.room_id RETURNING id`;
    if (!written[0]) invalid("CROSS_ROOM_REFERENCE", "A concurrent node belongs to another room.");
    updatedNodeIds.push(upsert.id);
    for (const state of upsert.participantStates) {
      await db`INSERT INTO participant_node_states (node_id, participant_id, position, supporting_reasons, underlying_concerns, emotion_intensity, view_of_others, acceptable_compromises)
        VALUES (${upsert.id}::uuid, ${state.participantId}::uuid, ${state.position}, ${db.json(state.supportingReasons)}, ${db.json(state.underlyingConcerns)},
          ${state.emotionIntensity}, ${db.json(state.viewOfOthers)}, ${db.json(state.acceptableCompromises)})
        ON CONFLICT (node_id, participant_id) DO UPDATE SET position = EXCLUDED.position, supporting_reasons = EXCLUDED.supporting_reasons,
          underlying_concerns = EXCLUDED.underlying_concerns, emotion_intensity = EXCLUDED.emotion_intensity,
          view_of_others = EXCLUDED.view_of_others, acceptable_compromises = EXCLUDED.acceptable_compromises`;
      for (const transcriptId of state.evidenceTranscriptIds) {
        await db`INSERT INTO node_transcript_evidence (node_id, transcript_segment_id, analysis_id) VALUES (${upsert.id}::uuid, ${transcriptId}::uuid, ${input.analysisId}::uuid) ON CONFLICT DO NOTHING`;
      }
    }
  }
  await db`UPDATE transcript_segments SET processed_analysis_id = ${input.analysisId}::uuid, processed_at = clock_timestamp()
    WHERE room_id = ${roomId}::uuid AND id = ANY(${input.sourceTranscriptIds}::uuid[])`;
  const bumped = await db<{ mapVersion: number }[]>`UPDATE rooms SET map_version = map_version + 1 WHERE id = ${roomId}::uuid RETURNING map_version AS "mapVersion"`;
  const data: MeetingAnalysisData = { analysisId: input.analysisId, mapVersion: bumped[0].mapVersion, updatedNodeIds, processedTranscriptIds: input.sourceTranscriptIds, duplicate: false };
  await db`INSERT INTO analysis_receipts (room_id, analysis_id, base_map_version, result_map_version, response_body, request_hash) VALUES (${roomId}::uuid, ${input.analysisId}::uuid, ${input.baseMapVersion}, ${data.mapVersion}, ${db.json(data)}, ${requestHash})`;
  await autoProposeHeatedNodes(db, roomId);
  await emitRoomEvent(db, roomId);
  return data;
}

async function autoProposeHeatedNodes(db: TransactionClient, roomId: string): Promise<void> {
  const heated = await db<{ id: string; topic: string; summary: string | null }[]>`SELECT n.id, n.topic, n.summary
    FROM mind_map_nodes n
    JOIN node_transcript_evidence e ON e.node_id = n.id
    JOIN transcript_segments t ON t.id = e.transcript_segment_id
    JOIN participants speaker ON speaker.id = t.participant_id AND speaker.room_id = n.room_id AND speaker.status = 'active'
    WHERE n.room_id = ${roomId}::uuid AND n.contention_score >= 0.72 AND n.status = 'heated'
      AND t.created_at > COALESCE((SELECT max(ended_at) FROM mediation_sessions WHERE node_id = n.id), '-infinity'::timestamptz)
    GROUP BY n.id, n.topic, n.summary
    HAVING count(e.transcript_segment_id) >= 3 AND count(DISTINCT t.participant_id) >= 2
    ORDER BY n.updated_at DESC LIMIT 1`;
  if (!heated[0]) return;
  const open = await db<{ id: string }[]>`SELECT id FROM mediation_sessions WHERE room_id = ${roomId}::uuid AND status IN ('proposed', 'starting', 'active') LIMIT 1`;
  if (open[0]) return;
  const active = await db<{ id: string; sharing: boolean }[]>`SELECT id, structured_sharing_consent AS sharing
    FROM participants WHERE room_id = ${roomId}::uuid AND status = 'active'`;
  if (active.length < 2 || active.some((participant) => !participant.sharing)) return;
  const inserted = await db<{ id: string }[]>`INSERT INTO mediation_sessions (room_id, node_id, status, trigger_reason, expires_at)
    VALUES (${roomId}::uuid, ${heated[0].id}::uuid, 'proposed', ${(heated[0].summary ?? heated[0].topic).slice(0, 1000)}, clock_timestamp() + interval '120 seconds')
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted[0]) return;
  const sessionId = inserted[0].id;
  for (const participant of active) {
    await db`INSERT INTO mediation_members (mediation_session_id, participant_id, entry_decision) VALUES (${sessionId}::uuid, ${participant.id}::uuid, 'pending')`;
  }
  await db`UPDATE rooms SET active_mediation_session_id=${sessionId}::uuid,active_mediation_node_id=${heated[0].id}::uuid WHERE id=${roomId}::uuid`;
  await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: sessionId });
}

// --- API-25 isolation ack ---
export async function ackIsolation(db: TransactionClient, roomId: string, runId: string, input: IsolationAckRequest): Promise<IsolationAckData> {
  const parsed = isolationAckRequestSchema.safeParse(input);
  if (!parsed.success) invalid("INVALID_REQUEST", "Invalid isolation acknowledgement.");
  input = parsed.data;
  const room = await lockRoom(db, roomId);
  await requireWorkerLease(db, roomId, runId);
  if (room.status !== "mediation") conflict("SESSION_STATE_CONFLICT", "This room is not awaiting mediation isolation.");
  const session = await db<{ id: string; status: string; nodeId: string }[]>`SELECT id, status, node_id AS "nodeId" FROM mediation_sessions
    WHERE id = ${input.sessionId}::uuid AND room_id = ${roomId}::uuid FOR UPDATE`;
  if (!session[0]) throw new ApiProblem({ status: 404, code: "NOT_FOUND", message: "Mediation session not found." });
  if (!["starting", "active"].includes(session[0].status)) conflict("SESSION_STATE_CONFLICT", "This session is not awaiting media isolation.");
  const members = await db<{ participantId: string; cutoff: string | null; isolatedAt: Date | null; mediaIsolated: boolean; status: string }[]>`
    SELECT m.participant_id AS "participantId", m.isolation_cutoff_unix_sec AS cutoff, m.isolated_at AS "isolatedAt",
      p.media_isolated AS "mediaIsolated", p.status FROM mediation_members m
    JOIN participants p ON p.id = m.participant_id AND p.room_id = ${roomId}::uuid
    WHERE m.mediation_session_id = ${input.sessionId}::uuid FOR UPDATE OF m, p`;
  const memberIds = new Set(members.map((member) => member.participantId));
  if (!members.length || new Set(input.results.map((result) => result.participantId)).size !== input.results.length) {
    conflict("ISOLATION_TARGET_MISMATCH", "Isolation targets must be unique session members.");
  }
  // Validate the entire batch first, preserving success monotonically across retries.
  for (const result of input.results) {
    const member = members.find((candidate) => candidate.participantId === result.participantId);
    if (!member || member.cutoff === null || Number(member.cutoff) !== result.revokeBeforeUnixSec
        || !member.mediaIsolated || member.status !== "active"
        || (result.succeeded ? result.errorCode !== null : result.errorCode === null)) {
      conflict("ISOLATION_TARGET_MISMATCH", "The acknowledgement does not match the saved isolation plan.");
    }
    if (session[0].status === "active" && (!member.isolatedAt || !result.succeeded)) {
      conflict("SESSION_STATE_CONFLICT", "Active isolation only accepts matching successful retries.");
    }
  }
  for (const result of input.results) {
    if (result.succeeded) {
      await db`UPDATE mediation_members SET isolated_at = COALESCE(isolated_at, clock_timestamp())
        WHERE mediation_session_id = ${input.sessionId}::uuid AND participant_id = ${result.participantId}::uuid`;
      await db`INSERT INTO media_isolation_results (mediation_session_id, participant_id, run_id, succeeded, safe_error_code)
        VALUES (${input.sessionId}::uuid, ${result.participantId}::uuid, ${runId}::uuid, true, null)
        ON CONFLICT (mediation_session_id, participant_id) DO UPDATE SET succeeded = true, safe_error_code = null, run_id = EXCLUDED.run_id`;
    } else {
      await db`INSERT INTO media_isolation_results (mediation_session_id, participant_id, run_id, succeeded, safe_error_code)
        VALUES (${input.sessionId}::uuid, ${result.participantId}::uuid, ${runId}::uuid, false, ${result.errorCode})
        ON CONFLICT (mediation_session_id, participant_id) DO UPDATE SET safe_error_code = EXCLUDED.safe_error_code, run_id = EXCLUDED.run_id
        WHERE NOT media_isolation_results.succeeded`;
    }
  }
  const pending = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM mediation_members WHERE mediation_session_id = ${input.sessionId}::uuid AND isolated_at IS NULL`;
  if (pending[0].count === 0 && session[0].status === "starting") {
    await db`UPDATE mediation_sessions SET status = 'active', started_at = clock_timestamp() WHERE id = ${input.sessionId}::uuid AND status = 'starting'`;
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

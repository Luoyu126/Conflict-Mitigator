import "server-only";

import type { LiveKitConnection } from "../../contracts/media";
import {
  CONSENT_NOTICE_VERSION,
  type ConsentPatch, type ConsentData, type CreateRoomData, type ExitData,
  type JoinData, type JoinRequest, type LobbyData, type MyParticipant,
  type Participant, type Room, type RoomData,
} from "../../contracts/rooms.ts";
import type { DatabaseExecutor } from "../../lib/db/postgres";
import { getDatabase, withTransaction } from "../../lib/db/postgres.ts";
import { emitRoomEvent } from "../../lib/db/repositories/room-events.ts";
import { requireRoomHost, requireRoomMember } from "../../lib/db/repositories/membership.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { createLiveKitAudioConnection } from "../../lib/integrations/livekit.ts";

type RoomRow = Omit<Room, "observer" | "createdAt" | "updatedAt" | "mediaEpochAt"> & {
  createdAt: Date; updatedAt: Date; mediaEpochAt: Date | null;
  observerStatus: Room["observer"]["status"] | null; audioStatus: Room["observer"]["audio"] | null;
  videoStatus: Room["observer"]["video"] | null; meetingAgentStatus: Room["observer"]["meetingAgent"] | null;
  lastHeartbeatAt: Date | null;
};
type ParticipantRow = Omit<Participant, "joinedAt" | "leftAt"> & {
  joinedAt: Date; leftAt: Date | null; transcriptionConsent: boolean;
  visualAffectConsent: boolean; voiceAffectConsent: boolean; structuredSharingConsent: boolean;
  consentRevision: number; consentNoticeVersion: typeof CONSENT_NOTICE_VERSION; mediaIsolated: boolean;
};
const roomProjection = `
  r.id, r.title, r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  r.media_epoch_at AS "mediaEpochAt", r.active_mediation_session_id AS "activeMediationSessionId",
  r.active_mediation_node_id AS "activeMediationNodeId", w.status AS "observerStatus",
  w.audio_status AS "audioStatus", w.video_status AS "videoStatus",
  w.meeting_agent_status AS "meetingAgentStatus", w.last_heartbeat_at AS "lastHeartbeatAt"`;

function iso(value: Date | null): string | null { return value ? value.toISOString() : null; }
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
function participantDto(row: ParticipantRow): Participant {
  return {
    id: row.id, roomId: row.roomId, displayName: row.displayName, role: row.role,
    status: row.status, livekitIdentity: row.livekitIdentity,
    joinedAt: row.joinedAt.toISOString(), leftAt: iso(row.leftAt),
  };
}
function myParticipantDto(row: ParticipantRow): MyParticipant {
  return {
    participant: participantDto(row),
    consents: { transcription: row.transcriptionConsent, visualAffect: row.visualAffectConsent, voiceAffect: row.voiceAffectConsent, structuredSharing: row.structuredSharingConsent },
    consentRevision: row.consentRevision, consentNoticeVersion: row.consentNoticeVersion,
  };
}
async function findRoom(db: DatabaseExecutor, roomId: string): Promise<RoomRow | null> {
  const rows = await db.unsafe<RoomRow[]>(`SELECT ${roomProjection} FROM rooms r
    LEFT JOIN worker_leases w ON w.room_id = r.id WHERE r.id = $1::uuid LIMIT 1`, [roomId]);
  return rows[0] ?? null;
}
async function requireRoom(db: DatabaseExecutor, roomId: string): Promise<RoomRow> {
  const row = await findRoom(db, roomId);
  if (!row) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  return row;
}
async function listParticipants(db: DatabaseExecutor, roomId: string): Promise<ParticipantRow[]> {
  return db<ParticipantRow[]>`
    SELECT id, room_id AS "roomId", display_name AS "displayName", role, status,
      livekit_identity AS "livekitIdentity", joined_at AS "joinedAt", left_at AS "leftAt",
      transcription_consent AS "transcriptionConsent", visual_affect_consent AS "visualAffectConsent", voice_affect_consent AS "voiceAffectConsent",
      structured_sharing_consent AS "structuredSharingConsent", consent_revision AS "consentRevision",
      consent_notice_version AS "consentNoticeVersion", media_isolated AS "mediaIsolated"
    FROM participants WHERE room_id = ${roomId}::uuid ORDER BY joined_at, id`;
}
async function participantForUser(db: DatabaseExecutor, roomId: string, authUserId: string): Promise<ParticipantRow | null> {
  const rows = await db<ParticipantRow[]>`
    SELECT id, room_id AS "roomId", display_name AS "displayName", role, status,
      livekit_identity AS "livekitIdentity", joined_at AS "joinedAt", left_at AS "leftAt",
      transcription_consent AS "transcriptionConsent", visual_affect_consent AS "visualAffectConsent", voice_affect_consent AS "voiceAffectConsent",
      structured_sharing_consent AS "structuredSharingConsent", consent_revision AS "consentRevision",
      consent_notice_version AS "consentNoticeVersion", media_isolated AS "mediaIsolated"
    FROM participants WHERE room_id = ${roomId}::uuid AND auth_user_id = ${authUserId}::uuid LIMIT 1`;
  return rows[0] ?? null;
}

export async function createRoom(db: DatabaseExecutor, authUserId: string, title: string): Promise<CreateRoomData> {
  const rows = await db<{ id: string }[]>`INSERT INTO rooms (title, created_by) VALUES (${title}, ${authUserId}::uuid) RETURNING id`;
  const room = await requireRoom(db, rows[0].id);
  return { room: roomDto(room), lobbyPath: `/room/${room.id}/lobby` };
}

export async function getLobby(roomId: string, authUserId: string): Promise<LobbyData> {
  const db = getDatabase();
  const rows = await db<{ roomId: string; title: string; status: LobbyData["status"]; participantCount: number; myParticipantId: string | null; mediaIsolated: boolean | null }[]>`
    SELECT r.id AS "roomId", r.title, r.status,
      (SELECT count(*)::int FROM participants p WHERE p.room_id = r.id AND p.status = 'active') AS "participantCount",
      me.id AS "myParticipantId", me.media_isolated AS "mediaIsolated"
    FROM rooms r LEFT JOIN participants me ON me.room_id = r.id AND me.auth_user_id = ${authUserId}::uuid
    WHERE r.id = ${roomId}::uuid LIMIT 1`;
  const row = rows[0];
  if (!row) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  return {
    roomId: row.roomId, title: row.title, status: row.status, participantCount: row.participantCount,
    canJoin: row.status !== "ended" && row.status !== "mediation" && row.mediaIsolated !== true && (row.myParticipantId !== null || row.participantCount < 12),
    myParticipantId: row.myParticipantId, consentNoticeVersion: CONSENT_NOTICE_VERSION,
  };
}

export async function getRoomState(roomId: string, authUserId: string): Promise<RoomData> {
  const db = getDatabase();
  await requireRoomMember(db, roomId, authUserId);
  const [room, participants, me] = await Promise.all([requireRoom(db, roomId), listParticipants(db, roomId), participantForUser(db, roomId, authUserId)]);
  if (!me) throw new Error("Authorized participant disappeared.");
  return { room: roomDto(room), participants: participants.map(participantDto), me: myParticipantDto(me) };
}

export type ConnectionIssuer = (input: { roomId: string; participantId: string; displayName: string }) => Promise<LiveKitConnection>;
async function issueConnection(issuer: ConnectionIssuer, roomId: string, participant: ParticipantRow): Promise<LiveKitConnection> {
  try { return await issuer({ roomId, participantId: participant.id, displayName: participant.displayName }); }
  catch { throw new ApiProblem({ status: 503, code: "LIVEKIT_UNAVAILABLE", message: "Media connection is temporarily unavailable.", retryable: true }); }
}

export async function joinRoom(
  db: DatabaseExecutor, roomId: string, authUserId: string, input: JoinRequest,
  issuer: ConnectionIssuer = createLiveKitAudioConnection,
): Promise<JoinData> {
  const locked = await db<{ status: Room["status"]; createdBy: string }[]>`
    SELECT status, created_by AS "createdBy" FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
  if (!locked[0]) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
  if (locked[0].status === "ended") throw new ApiProblem({ status: 409, code: "ROOM_ENDED", message: "The room has ended." });
  let participant = await participantForUser(db, roomId, authUserId);
  await assertMediaAllowed(db, roomId, participant?.id);
  if (participant?.mediaIsolated) throw new ApiProblem({ status: 409, code: "MEDIA_ISOLATED", message: "Media is isolated during mediation." });
  if (!participant || participant.status === "left") {
    const counts = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM participants WHERE room_id = ${roomId}::uuid AND status = 'active'`;
    if (counts[0].count >= 12) throw new ApiProblem({ status: 409, code: "ROOM_FULL", message: "The room is full." });
  }
  if (!participant) {
    const inserted = await db<{ id: string }[]>`
      INSERT INTO participants (room_id, auth_user_id, display_name, role, transcription_consent,
        visual_affect_consent, voice_affect_consent, structured_sharing_consent, consent_notice_version)
      VALUES (${roomId}::uuid, ${authUserId}::uuid, ${input.displayName},
        ${locked[0].createdBy === authUserId ? "host" : "participant"}, ${input.consents.transcription},
        ${input.consents.visualAffect}, ${input.consents.voiceAffect ?? false}, ${input.consents.structuredSharing}, ${CONSENT_NOTICE_VERSION}) RETURNING id`;
    await db`UPDATE participants SET livekit_identity = id::text WHERE id = ${inserted[0].id}::uuid`;
  } else {
    await db`
      UPDATE participants SET display_name = ${input.displayName}, status = 'active', left_at = NULL,
        transcription_consent = ${input.consents.transcription}, visual_affect_consent = ${input.consents.visualAffect},
        voice_affect_consent = ${input.consents.voiceAffect ?? false},
        structured_sharing_consent = ${input.consents.structuredSharing},
        consent_revision = consent_revision + CASE WHEN transcription_consent IS DISTINCT FROM ${input.consents.transcription}
          OR visual_affect_consent IS DISTINCT FROM ${input.consents.visualAffect}
          OR voice_affect_consent IS DISTINCT FROM ${input.consents.voiceAffect ?? false}
          OR structured_sharing_consent IS DISTINCT FROM ${input.consents.structuredSharing} THEN 1 ELSE 0 END
      WHERE id = ${participant.id}::uuid`;
  }
  await db`UPDATE rooms SET status = CASE WHEN status = 'lobby' THEN 'meeting' ELSE status END,
    media_epoch_at = COALESCE(media_epoch_at, clock_timestamp()) WHERE id = ${roomId}::uuid`;
  await emitRoomEvent(db, roomId);
  participant = await participantForUser(db, roomId, authUserId);
  if (!participant) throw new Error("Joined participant disappeared.");
  const livekit = await issueConnection(issuer, roomId, participant);
  const room = await requireRoom(db, roomId);
  return { room: roomDto(room), me: myParticipantDto(participant), livekit, navigationPath: `/room/${roomId}` };
}

export async function renewLiveKitToken(
  roomId: string, authUserId: string, issuer: ConnectionIssuer = createLiveKitAudioConnection,
): Promise<{ livekit: LiveKitConnection }> {
  return withTransaction(async (db) => {
  await lockRoom(db, roomId);
  const access = await requireRoomMember(db, roomId, authUserId, { active: true });
  const rooms = await db<{ status: Room["status"] }[]>`SELECT status FROM rooms WHERE id = ${roomId}::uuid`;
  if (rooms[0]?.status === "ended") throw new ApiProblem({ status: 409, code: "ROOM_ENDED", message: "The room has ended." });
  await assertMediaAllowed(db, roomId, access.id);
  if (access.mediaIsolated) throw new ApiProblem({ status: 409, code: "MEDIA_ISOLATED", message: "Media is isolated during mediation." });
  const cutoffs = await db<{ tokenNotBefore: Date | null }[]>`SELECT media_token_not_before AS "tokenNotBefore" FROM participants WHERE id = ${access.id}::uuid`;
  if (cutoffs[0]?.tokenNotBefore && cutoffs[0].tokenNotBefore > new Date()) {
    throw new ApiProblem({ status: 409, code: "TOKEN_NOT_YET_VALID", message: "Wait before requesting a replacement media token.", retryable: true, retryAfterMs: cutoffs[0].tokenNotBefore.getTime() - Date.now() });
  }
  const participant = await participantForUser(db, roomId, authUserId);
  if (!participant) throw new Error("Authorized participant disappeared.");
  return { livekit: await issueConnection(issuer, roomId, participant) };
  });
}

export async function updateConsents(db: DatabaseExecutor, roomId: string, authUserId: string, patch: ConsentPatch): Promise<ConsentData> {
  await lockRoom(db, roomId);
  await requireRoomMember(db, roomId, authUserId, { active: true });
  const current = await participantForUser(db, roomId, authUserId);
  if (!current) throw new Error("Authorized participant disappeared.");
  const transcription = patch.transcription ?? current.transcriptionConsent;
  const visual = patch.visualAffect ?? current.visualAffectConsent;
  const voice = patch.voiceAffect ?? current.voiceAffectConsent;
  const sharing = patch.structuredSharing ?? current.structuredSharingConsent;
  const changed = transcription !== current.transcriptionConsent || visual !== current.visualAffectConsent
    || voice !== current.voiceAffectConsent || sharing !== current.structuredSharingConsent;
  await db`UPDATE participants SET transcription_consent = ${transcription}, visual_affect_consent = ${visual},
    voice_affect_consent = ${voice}, structured_sharing_consent = ${sharing},
    consent_revision = consent_revision + ${changed ? 1 : 0} WHERE id = ${current.id}::uuid`;
  if (current.structuredSharingConsent && !sharing) await closeOpenSession(db, roomId, current.id, "CONSENT_WITHDRAWN");
  if (changed) await emitRoomEvent(db, roomId);
  const updated = await participantForUser(db, roomId, authUserId);
  if (!updated) throw new Error("Updated participant disappeared.");
  return { me: myParticipantDto(updated) };
}

export async function leaveRoom(db: DatabaseExecutor, roomId: string, authUserId: string): Promise<ExitData> {
  await lockRoom(db, roomId);
  const participant = await requireRoomMember(db, roomId, authUserId);
  await closeOpenSession(db, roomId, participant.id, "PARTICIPANT_LEFT");
  const cutoff = new Date((Math.ceil(Date.now() / 1000) + 1) * 1000);
  await db`UPDATE participants SET status = 'left', left_at = COALESCE(left_at, clock_timestamp()),
    media_isolated = true, media_cleanup_pending = true,
    media_token_not_before = GREATEST(media_token_not_before, ${cutoff}) WHERE id = ${participant.id}::uuid`;
  await emitRoomEvent(db, roomId);
  const room = await requireRoom(db, roomId);
  return { roomId, roomStatus: room.status, participantStatus: "left", mediaCleanup: "pending", navigationPath: "/" };
}

export async function endRoom(db: DatabaseExecutor, roomId: string, authUserId: string): Promise<ExitData> {
  await lockRoom(db, roomId);
  await requireRoomHost(db, roomId, authUserId);
  await closeOpenSession(db, roomId, null, "ROOM_ENDED");
  const cutoff = new Date((Math.ceil(Date.now() / 1000) + 1) * 1000);
  await db`UPDATE rooms SET status = 'ended', media_cleanup_pending = true,
    active_mediation_session_id = NULL, active_mediation_node_id = NULL WHERE id = ${roomId}::uuid`;
  await db`UPDATE participants SET status = 'left', left_at = COALESCE(left_at, clock_timestamp()),
    media_isolated = true, media_cleanup_pending = true,
    media_token_not_before = GREATEST(media_token_not_before, ${cutoff}) WHERE room_id = ${roomId}::uuid`;
  await emitRoomEvent(db, roomId);
  return { roomId, roomStatus: "ended", participantStatus: "left", mediaCleanup: "pending", navigationPath: "/" };
}

async function lockRoom(db: DatabaseExecutor, roomId: string) {
  const rows = await db`SELECT id FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
  if (!rows.length) throw new ApiProblem({ status: 404, code: "ROOM_NOT_FOUND", message: "Room not found." });
}

async function assertMediaAllowed(db: DatabaseExecutor, roomId: string, participantId?: string) {
  const sessions = await db`SELECT status FROM mediation_sessions WHERE room_id = ${roomId}::uuid
    AND status IN ('proposed','starting','active')`;
  if (sessions.some(s => s.status !== "proposed") || (!participantId && sessions.length)) {
    throw new ApiProblem({ status: 409, code: "MEDIA_ISOLATED", message: "Wait for the current mediation round before joining public media." });
  }
  if (!participantId) return;
  const rows = await db<{ pending: boolean; cutoff: Date | null }[]>`SELECT media_cleanup_pending AS pending,
    media_token_not_before AS cutoff FROM participants WHERE id = ${participantId}::uuid`;
  if (rows[0]?.pending || (rows[0]?.cutoff && rows[0].cutoff > new Date())) {
    throw new ApiProblem({ status: 409, code: "TOKEN_NOT_YET_VALID", message: "Media cleanup is still in progress.", retryable: true, retryAfterMs: 1000 });
  }
}

async function closeOpenSession(db: DatabaseExecutor, roomId: string, participantId: string | null, reason: string) {
  const sessions = await db<{ id: string; node_id: string; status: string }[]>`SELECT s.id,s.node_id,s.status
    FROM mediation_sessions s WHERE s.room_id = ${roomId}::uuid AND s.status IN ('proposed','starting','active')
    AND (${participantId}::uuid IS NULL OR EXISTS (SELECT 1 FROM mediation_members m
      WHERE m.mediation_session_id = s.id AND m.participant_id = ${participantId}::uuid)) FOR UPDATE`;
  for (const session of sessions) {
    await db`UPDATE mediation_sessions SET status='cancelled',ended_at=clock_timestamp(),transition_error=${reason} WHERE id=${session.id}::uuid`;
    if (session.status !== "proposed") {
      await db`UPDATE participants p SET media_cleanup_pending=true, media_isolated=true,
        media_token_not_before=GREATEST(media_token_not_before, to_timestamp(ceil(extract(epoch from clock_timestamp()))+1))
        FROM mediation_members m WHERE m.mediation_session_id=${session.id}::uuid AND p.id=m.participant_id`;
    }
    await db`UPDATE mind_map_nodes SET status='normal',readiness_score=NULL WHERE id=${session.node_id}::uuid`;
    await db`UPDATE rooms SET status=CASE WHEN status='ended' THEN 'ended' ELSE 'meeting' END,
      active_mediation_session_id=NULL,active_mediation_node_id=NULL WHERE id=${roomId}::uuid`;
    await emitRoomEvent(db, roomId, "room.mediation.changed", { mediationSessionId: session.id });
  }
}

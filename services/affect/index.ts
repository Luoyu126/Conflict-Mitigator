import "server-only";
import type { AffectIngest, AffectObservation, MyAffectData } from "../../contracts/affect.ts";
import { affectIngestSchema } from "../../contracts/affect.ts";
import { getDatabase, type TransactionClient } from "../../lib/db/postgres.ts";
import { requireRoomMember } from "../../lib/db/repositories/membership.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { hashRequestBody, type JsonValue } from "../../lib/server/idempotency.ts";

type ObservationRow = Omit<AffectObservation, "receivedAt" | "expiresAt"> & { receivedAt: Date; expiresAt: Date };
const projection = `a.id,a.room_id AS "roomId",a.participant_id AS "participantId",a.source,
  a.track_sid AS "trackSid",a.stream_id AS "streamId",a.consent_revision AS "consentRevision",
  a.sampled_at_ms::float8 AS "sampledAtMs",a.received_at AS "receivedAt",a.expires_at AS "expiresAt",a.result`;
const dto = (r: ObservationRow): AffectObservation => ({ ...r, receivedAt: r.receivedAt.toISOString(), expiresAt: r.expiresAt.toISOString() });

/** Caller must hold the room/Worker lease lock in this same transaction. */
export async function ingestAffect(db: TransactionClient, roomId: string, input: AffectIngest) {
  const parsed = affectIngestSchema.safeParse(input);
  if (!parsed.success || input.metadata.roomId !== roomId) throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "Invalid observation." });
  const body = parsed.data;
  const m = body.metadata;
  const participants = await db`SELECT p.*,r.status AS room_status,r.media_epoch_at
    FROM participants p JOIN rooms r ON r.id=p.room_id
    WHERE p.room_id=${roomId}::uuid AND p.livekit_identity=${m.participantIdentity} FOR UPDATE OF p`;
  const p = participants[0];
  if (!p || p.status !== "active" || p.room_status !== "meeting" || p.media_isolated || p.media_cleanup_pending ||
      p.consent_revision !== m.consentRevision || !(body.source === "visual" ? p.visual_affect_consent : p.voice_affect_consent)) {
    throw new ApiProblem({ status: 409, code: "CONSENT_REVOKED", message: "This observation is no longer authorized." });
  }
  const hash = hashRequestBody(body as unknown as JsonValue);
  const prior = await db`SELECT room_id,participant_id,request_hash FROM affect_observations WHERE id=${m.observationId}::uuid`;
  if (prior.length) {
    if (prior[0].room_id !== roomId || prior[0].participant_id !== p.id || prior[0].request_hash !== hash)
      throw new ApiProblem({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Observation ID already used." });
    return { observationId: m.observationId, duplicate: true, nodeId: null };
  }
  const epoch = p.media_epoch_at as Date | null;
  if (m.sampledAtMs !== null && (!epoch || m.sampledAtMs > Date.now() - epoch.getTime() + 1_000 || m.sampledAtMs < Date.now() - epoch.getTime() - 30_000))
    throw new ApiProblem({ status: 422, code: "INVALID_TIMESTAMP", message: "Observation is outside the current processing window." });
  const inserted = await db`INSERT INTO affect_observations(id,room_id,participant_id,source,track_sid,stream_id,consent_revision,sampled_at_ms,request_hash,result)
    VALUES (${m.observationId}::uuid,${roomId}::uuid,${p.id}::uuid,${body.source},${m.trackSid},${m.streamId}::uuid,
      ${m.consentRevision},${m.sampledAtMs},${hash},${db.json(body.result)}) ON CONFLICT DO NOTHING`;
  if (!inserted.count) throw new ApiProblem({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Observation ID already used." });
  return { observationId: m.observationId, duplicate: false, nodeId: null };
}

export async function getMyAffect(roomId: string, authUserId: string): Promise<MyAffectData> {
  const db = getDatabase();
  const me = await requireRoomMember(db, roomId, authUserId, { active: true });
  const rows = await db.unsafe<ObservationRow[]>(`SELECT ${projection} FROM affect_observations a
    JOIN participants p ON p.id=a.participant_id JOIN rooms r ON r.id=a.room_id
    WHERE a.room_id=$1::uuid AND a.participant_id=$2::uuid AND a.expires_at>clock_timestamp()
      AND a.consent_revision=p.consent_revision AND p.status='active' AND NOT p.media_isolated
      AND NOT p.media_cleanup_pending AND r.status='meeting'
      AND ((a.source='visual' AND p.visual_affect_consent) OR (a.source='voice' AND p.voice_affect_consent))
      AND a.id IN (SELECT id FROM (SELECT id,row_number() OVER (PARTITION BY source ORDER BY received_at DESC,id DESC) AS n
        FROM affect_observations WHERE participant_id=$2::uuid AND room_id=$1::uuid) ranked WHERE n<=24)
    ORDER BY a.received_at DESC,a.id DESC`, [roomId, me.id]);
  return { observations: rows.map(dto) };
}

export async function getRecentAffect(db: TransactionClient, roomId: string): Promise<AffectObservation[]> {
  const rows = await db.unsafe<ObservationRow[]>(`SELECT ${projection} FROM affect_observations a
    JOIN participants p ON p.id=a.participant_id JOIN rooms r ON r.id=a.room_id
    WHERE a.room_id=$1::uuid AND a.received_at>clock_timestamp()-interval '6 seconds'
      AND a.expires_at>clock_timestamp() AND a.sampled_at_ms IS NOT NULL AND r.media_epoch_at IS NOT NULL
      AND r.media_epoch_at+a.sampled_at_ms*interval '1 millisecond'>clock_timestamp()-interval '6 seconds'
      AND a.consent_revision=p.consent_revision AND p.status='active' AND NOT p.media_isolated
      AND NOT p.media_cleanup_pending AND r.status='meeting'
      AND ((a.source='visual' AND p.visual_affect_consent) OR (a.source='voice' AND p.voice_affect_consent))
    ORDER BY a.received_at DESC LIMIT 96`, [roomId]);
  return rows.map(dto);
}

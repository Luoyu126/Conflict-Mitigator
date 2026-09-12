import "server-only";

import type { DatabaseExecutor } from "../postgres";
import { ApiProblem } from "../../server/errors.ts";

export type ParticipantAccess = {
  id: string;
  roomId: string;
  authUserId: string;
  displayName: string;
  role: "host" | "participant";
  status: "active" | "left";
  consentRevision: number;
  transcriptionConsent: boolean;
  visualAffectConsent: boolean;
  voiceAffectConsent: boolean;
  structuredSharingConsent: boolean;
  mediaIsolated: boolean;
};

export async function findParticipantForUser(
  db: DatabaseExecutor,
  roomId: string,
  authUserId: string,
): Promise<ParticipantAccess | null> {
  const rows = await db<ParticipantAccess[]>`
    SELECT
      id,
      room_id AS "roomId",
      auth_user_id AS "authUserId",
      display_name AS "displayName",
      role,
      status,
      consent_revision AS "consentRevision",
      transcription_consent AS "transcriptionConsent",
      visual_affect_consent AS "visualAffectConsent",
      voice_affect_consent AS "voiceAffectConsent",
      structured_sharing_consent AS "structuredSharingConsent",
      media_isolated AS "mediaIsolated"
    FROM participants
    WHERE room_id = ${roomId}::uuid
      AND auth_user_id = ${authUserId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function requireRoomMember(
  db: DatabaseExecutor,
  roomId: string,
  authUserId: string,
  options: { active?: boolean } = {},
): Promise<ParticipantAccess> {
  const participant = await findParticipantForUser(db, roomId, authUserId);
  if (!participant || (options.active && participant.status !== "active")) {
    throw new ApiProblem({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have access to this room.",
    });
  }
  return participant;
}

export async function requireRoomHost(
  db: DatabaseExecutor,
  roomId: string,
  authUserId: string,
): Promise<ParticipantAccess> {
  const participant = await requireRoomMember(db, roomId, authUserId, { active: true });
  if (participant.role !== "host") {
    throw new ApiProblem({
      status: 403,
      code: "FORBIDDEN",
      message: "Only the room host can perform this action.",
    });
  }
  return participant;
}

import { transcriptPacketSchema } from "../../contracts/transcript-packet.ts";
import type { TranscriptIngestRequest } from "../../contracts/worker.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validated request body for API-22 (docs/api/internal-api.md). */

export type TranscriptIngestInput = {
  roomId: string;
  /** LiveKit participant identity == persisted participants.id. */
  senderIdentity: string;
  /** Mic track SID observed by the worker via track_subscribed. */
  trackSid: string;
  receivedAt: string;
  /** The JSON-decoded browser data packet. */
  payload: unknown;
};

export type TranscriptIngestResult =
  | { ok: true; request: TranscriptIngestRequest }
  | { ok: false; reason: string };

/**
 * Validates a browser final-transcript packet against its LiveKit sender identity
 * and maps it to the API-22 body. Rejection reasons are generic and never include
 * transcript content. Authorization, consent revision, media isolation, and
 * monotonic revision are enforced server-side by API-22, not here.
 */
export function normalizeTranscriptIngestion(input: TranscriptIngestInput): TranscriptIngestResult {
  if (!UUID.test(input.senderIdentity)) {
    return { ok: false, reason: "sender identity is not a persisted participant UUID" };
  }
  if (!UUID.test(input.roomId)) {
    return { ok: false, reason: "room id is not a UUID" };
  }
  const trackSid = input.trackSid?.trim();
  if (!trackSid) {
    return { ok: false, reason: "microphone track SID is missing" };
  }
  const parsed = transcriptPacketSchema.safeParse(input.payload);
  if (!parsed.success) {
    return { ok: false, reason: "transcript packet is invalid" };
  }
  const packet = parsed.data;
  return {
    ok: true,
    request: {
      segmentId: packet.segmentId,
      participantIdentity: input.senderIdentity,
      trackSid,
      streamId: packet.streamId,
      content: packet.content,
      isFinal: true,
      revision: packet.revision,
      startedAtMs: packet.startedAtMs,
      endedAtMs: packet.endedAtMs,
      language: packet.language,
      confidence: packet.confidence,
      receivedAt: input.receivedAt,
      timeBasis: "unknown",
      consentRevision: packet.consentRevision,
    },
  };
}

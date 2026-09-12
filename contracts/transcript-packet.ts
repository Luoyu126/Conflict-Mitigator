import { z } from "zod";

/** Reserved LiveKit data topic for browser-confirmed final transcripts. */
export const TRANSCRIPT_DATA_TOPIC = "cm.transcript.final.v1" as const;

/**
 * Browser-final speech-recognition envelope published over LiveKit reliable
 * data. It deliberately carries no participant identity: the worker trusts the
 * LiveKit sender identity (== participants.id), never a field in the payload.
 * Interim results are never published or persisted.
 */
export const transcriptPacketSchema = z.object({
  segmentId: z.string().uuid(),
  streamId: z.string().uuid(),
  revision: z.number().int().min(1),
  content: z.string().trim().min(1).max(8000),
  startedAtMs: z.number().int().min(0).nullable(),
  endedAtMs: z.number().int().min(0).nullable(),
  language: z.string().trim().min(1).max(35).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  consentRevision: z.number().int().min(1),
  recognizedAt: z.string().datetime(),
}).strict();

export type TranscriptPacket = z.infer<typeof transcriptPacketSchema>;

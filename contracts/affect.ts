import { z } from "zod";

export const AFFECT_FRESH_MS = 6_000;
export const affectSourceSchema = z.enum(["visual", "voice"]);
export const vadSchema = z.object({
  valence: z.number().min(-1).max(1), arousal: z.number().min(0).max(1),
  dominance: z.number().min(-1).max(1), mappingVersion: z.string().min(1).max(100),
}).strict();
export const affectResultSchema = z.object({
  observationId: z.string().uuid(), status: z.enum(["ok", "unavailable"]),
  intensity: z.number().min(0).max(1).nullable(), confidence: z.number().min(0).max(1).nullable(),
  faceCount: z.number().int().min(0).optional(),
  reason: z.enum(["no_face", "multiple_faces", "low_quality", "model_unavailable", "consent_revoked"]).nullable(),
  model: z.object({ provider: z.string().min(1).max(100), name: z.string().min(1).max(100), version: z.string().max(100).nullable() }).strict(),
  inferenceMs: z.number().int().min(0),
  scores: z.array(z.object({ name: z.string().min(1).max(80), score: z.number().min(0).max(100) }).strict()).max(48).default([]),
  vad: vadSchema.nullable().default(null),
}).strict().superRefine((r, ctx) => {
  if (r.status === "unavailable" && (r.intensity !== null || r.confidence !== null || r.reason === null || r.scores.length || r.vad))
    ctx.addIssue({ code: "custom", message: "Unavailable observations cannot include scores." });
  if (r.status === "ok" && r.reason !== null) ctx.addIssue({ code: "custom", message: "Valid observations cannot include an unavailable reason." });
  if (new Set(r.scores.map(s => s.name)).size !== r.scores.length) ctx.addIssue({ code: "custom", message: "Duplicate score names." });
});
export const observationMetadataSchema = z.object({
  observationId: z.string().uuid(), roomId: z.string().uuid(), participantIdentity: z.string().uuid(),
  trackSid: z.string().regex(/^TR_[A-Za-z0-9_-]+$/), streamId: z.string().uuid(),
  sampledAtMs: z.number().int().min(0).nullable(), consentRevision: z.number().int().min(1),
  sdkTimestampUs: z.string().regex(/^\d+$/).nullable().optional(),
  width: z.number().int().min(1).max(640).optional(), height: z.number().int().min(1).max(640).optional(),
  rotationApplied: z.literal(true).optional(),
}).strict();
export const frameMetadataSchema = observationMetadataSchema.extend({
  sampledAtMs: z.number().int().min(0), sdkTimestampUs: z.string().regex(/^\d+$/).nullable(),
  width: z.number().int().min(1).max(640), height: z.number().int().min(1).max(640), rotationApplied: z.literal(true),
});
export const affectIngestSchema = z.object({
  source: affectSourceSchema.default("visual"), metadata: observationMetadataSchema, result: affectResultSchema,
}).strict().superRefine((v, ctx) => {
  if (v.result.observationId !== v.metadata.observationId) ctx.addIssue({ code: "custom", message: "Observation IDs must match." });
  if (v.source === "visual" && (!frameMetadataSchema.safeParse(v.metadata).success ||
      (v.result.status === "ok" && (v.result.faceCount !== 1 || v.result.intensity === null))))
    ctx.addIssue({ code: "custom", message: "Invalid camera observation." });
  if (v.source === "voice" && v.result.scores.some(s => s.score > 1)) ctx.addIssue({ code: "custom", message: "Invalid voice score." });
});
export type AffectResult = z.infer<typeof affectResultSchema>;
export type AffectIngest = z.infer<typeof affectIngestSchema>;
export type FrameMetadata = z.infer<typeof frameMetadataSchema>;
export type AffectObservation = {
  id: string; roomId: string; participantId: string; source: "visual" | "voice";
  trackSid: string; streamId: string; consentRevision: number; sampledAtMs: number | null;
  receivedAt: string; expiresAt: string; result: AffectResult;
};
export type MyAffectData = { observations: AffectObservation[] };

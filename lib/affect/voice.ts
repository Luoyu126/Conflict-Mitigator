import type { AffectResult } from "../../contracts/affect.ts";
import { projectVoiceVad, VOICE_VAD_VERSION, type EmotionScore } from "./voice-vad.ts";

export type VoiceAffectResult = Omit<AffectResult, "observationId">;
const MODEL = { provider: "Hume", name: "EVI prosody", version: null } as const;

/** Hume does not report a trustworthy per-observation inference latency. */
export function unavailableVoiceAffect(reason: "low_quality" | "model_unavailable" = "model_unavailable"): VoiceAffectResult {
  return { status: "unavailable", intensity: null, confidence: null, reason, model: MODEL,
    inferenceMs: null, scores: [], vad: null };
}

/** Only complete spoken user messages contribute scores. Provider text and IDs are discarded. */
export function parseVoiceAffect(value: unknown): VoiceAffectResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "user_message" || event.from_text !== false || event.interim === true) return null;
  const models = event.models;
  const prosody = models && typeof models === "object" ? (models as Record<string, unknown>).prosody : null;
  const raw = prosody && typeof prosody === "object" ? (prosody as Record<string, unknown>).scores : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailableVoiceAffect("low_quality");
  const scores: EmotionScore[] = [];
  for (const [name, score] of Object.entries(raw)) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return unavailableVoiceAffect("low_quality");
    scores.push({ name, score });
  }
  const point = projectVoiceVad(scores);
  if (!point) return unavailableVoiceAffect("low_quality");
  return {
    status: "ok", intensity: point.intensity, confidence: null, reason: null, model: MODEL,
    inferenceMs: null, scores: scores.sort((a, b) => b.score - a.score),
    vad: { valence: point.v, arousal: point.a, dominance: point.d, mappingVersion: VOICE_VAD_VERSION },
  };
}

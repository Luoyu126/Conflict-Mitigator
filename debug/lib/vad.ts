import type { FaceResult } from "./face-emotion";

export type Vad = { v: number; a: number; d: number };
export const VAD_VERSION = "facepp-vad-experiment-v1";
export const VAD_FRESH_MS = 6000;
export const VAD_TRAIL_MS = 30000;
export const VAD_WEIGHTS = { v: .15, a: .70, d: .15 } as const;
// Product-design anchors for exploration, NOT measured VAD or validated psychological norms.
// Neutral is the chosen origin. Surprise has no assumed positive/negative valence.
export const VAD_ANCHORS: Record<string, Vad> = {
  anger: { v: -.8, a: .9, d: .6 },
  disgust: { v: -.7, a: .5, d: .3 },
  fear: { v: -.8, a: .9, d: -.7 },
  happiness: { v: .9, a: .7, d: .4 },
  neutral: { v: 0, a: 0, d: 0 },
  sadness: { v: -.7, a: .2, d: -.5 },
  surprise: { v: 0, a: .8, d: 0 },
};
export function vadIntensity(point: Vad): number {
  return Math.sqrt(VAD_WEIGHTS.v * point.v ** 2 + VAD_WEIGHTS.a * point.a ** 2 + VAD_WEIGHTS.d * point.d ** 2);
}
export function projectVad(result: FaceResult): (Vad & { intensity: number }) | null {
  if (result.status !== "ok" || result.faceCount !== 1 || result.scores.length !== 7) return null;
  const names = new Set(result.scores.map((s) => s.name));
  if (names.size !== 7 || result.scores.some((s) => !Object.hasOwn(VAD_ANCHORS, s.name)
    || !Number.isFinite(s.score) || s.score < 0 || s.score > 100)) return null;
  const sum = result.scores.reduce((n, s) => n + s.score, 0);
  if (sum <= 0) return null;
  const point: Vad = { v: 0, a: 0, d: 0 };
  for (const { name, score } of result.scores) {
    const anchor = VAD_ANCHORS[name];
    point.v += anchor.v * score / sum;
    point.a += anchor.a * score / sum;
    point.d += anchor.d * score / sum;
  }
  return { ...point, intensity: vadIntensity(point) };
}
export type VadSample = Vad & { at: number };
export function appendVadTrail(trail: VadSample[], point: Vad | null, at: number): VadSample[] {
  if (!point) return [];
  const recent = trail.length && at - trail[trail.length - 1].at <= VAD_FRESH_MS
    ? trail.filter((sample) => at - sample.at <= VAD_TRAIL_MS) : [];
  return [...recent, { v: point.v, a: point.a, d: point.d, at }].slice(-24);
}

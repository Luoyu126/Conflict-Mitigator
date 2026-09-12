import type { EmotionScore } from "./emotions";

export type Vad = { v: number; a: number; d: number };
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
export const VOICE_VAD_VERSION = "hume-vad-experiment-v1";
// Exploratory design anchors, not Hume measurements or a trained dimensional model.
// Shared categories keep the camera anchors so both plots use the same convention.
export const VOICE_VAD_ANCHORS: Record<string, Vad> = {
  Admiration: { v: .7, a: .4, d: .1 }, Adoration: { v: .8, a: .4, d: -.1 },
  "Aesthetic Appreciation": { v: .7, a: .3, d: .1 }, Amusement: { v: .8, a: .6, d: .3 },
  Anger: VAD_ANCHORS.anger, Anxiety: { v: -.6, a: .7, d: -.5 },
  Awe: { v: .5, a: .7, d: -.4 }, Awkwardness: { v: -.4, a: .4, d: -.4 },
  Boredom: { v: -.3, a: .1, d: -.2 }, Calmness: VAD_ANCHORS.neutral,
  Concentration: { v: .1, a: .4, d: .5 }, Confusion: { v: -.3, a: .5, d: -.4 },
  Contemplation: { v: .1, a: .2, d: .2 }, Contempt: { v: -.7, a: .4, d: .6 },
  Contentment: { v: .7, a: .1, d: .3 }, Craving: { v: .1, a: .7, d: -.3 },
  Desire: { v: .4, a: .6, d: .1 }, Determination: { v: .3, a: .7, d: .8 },
  Disappointment: { v: -.6, a: .3, d: -.4 }, Disgust: VAD_ANCHORS.disgust,
  Distress: { v: -.8, a: .8, d: -.7 }, Doubt: { v: -.3, a: .3, d: -.4 },
  Ecstasy: { v: 1, a: 1, d: .4 }, Embarrassment: { v: -.5, a: .6, d: -.5 },
  "Empathic Pain": { v: -.6, a: .5, d: -.4 }, Entrancement: { v: .6, a: .4, d: -.2 },
  Envy: { v: -.6, a: .6, d: -.2 }, Excitement: { v: .8, a: .9, d: .5 },
  Fear: VAD_ANCHORS.fear, Guilt: { v: -.6, a: .4, d: -.5 },
  Horror: { v: -.9, a: 1, d: -.8 }, Interest: { v: .5, a: .5, d: .2 },
  Joy: VAD_ANCHORS.happiness, Love: { v: .9, a: .5, d: .2 },
  Nostalgia: { v: .2, a: .3, d: -.1 }, Pain: { v: -.8, a: .7, d: -.6 },
  Pride: { v: .7, a: .6, d: .8 }, Realization: { v: .3, a: .6, d: .4 },
  Relief: { v: .7, a: .2, d: .3 }, Romance: { v: .8, a: .5, d: .1 },
  Sadness: VAD_ANCHORS.sadness, Satisfaction: { v: .8, a: .3, d: .5 },
  Shame: { v: -.7, a: .5, d: -.7 }, "Surprise (negative)": { v: -.6, a: .8, d: -.3 },
  "Surprise (positive)": { v: .6, a: .8, d: .2 }, Sympathy: { v: .2, a: .3, d: -.1 },
  Tiredness: { v: -.2, a: .05, d: -.3 }, Triumph: { v: .9, a: .9, d: .9 },
};

export function projectVoiceVad(scores: EmotionScore[]): (Vad & { intensity: number }) | null {
  if (scores.length !== 48 || new Set(scores.map(s => s.name)).size !== 48
    || scores.some(s => !Object.hasOwn(VOICE_VAD_ANCHORS, s.name) || !Number.isFinite(s.score) || s.score < 0 || s.score > 1)) return null;
  const sum = scores.reduce((total, s) => total + s.score, 0);
  if (sum <= 0) return null;
  const point = { v: 0, a: 0, d: 0 };
  for (const { name, score } of scores) {
    const anchor = VOICE_VAD_ANCHORS[name];
    point.v += anchor.v * score / sum;
    point.a += anchor.a * score / sum;
    point.d += anchor.d * score / sum;
  }
  return { ...point, intensity: vadIntensity(point) };
}
export function vadIntensity(point: Vad): number {
  return Math.sqrt(VAD_WEIGHTS.v * point.v ** 2 + VAD_WEIGHTS.a * point.a ** 2 + VAD_WEIGHTS.d * point.d ** 2);
}
export type VadSample = Vad & { at: number };
export function appendVadTrail(trail: VadSample[], point: Vad | null, at: number): VadSample[] {
  if (!point) return [];
  const recent = trail.length && at - trail[trail.length - 1].at <= VAD_FRESH_MS
    ? trail.filter((sample) => at - sample.at <= VAD_TRAIL_MS) : [];
  return [...recent, { v: point.v, a: point.a, d: point.d, at }].slice(-24);
}

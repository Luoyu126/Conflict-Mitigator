/** Experimental display coordinates copied from the camera feature branch.
 * These product-design anchors are not calibrated affect measurements. Never use
 * the projection directly as contentionScore or average it with another modality.
 */
export const VISUAL_VAD_VERSION = "facepp-vad-experiment-v1";
export const VISUAL_VAD_WEIGHTS = { valence: .15, arousal: .70, dominance: .15 } as const;
export type VisualPoint = { valence: number; arousal: number; dominance: number };
export const VISUAL_VAD_ANCHORS: Readonly<Record<string, VisualPoint>> = {
  anger: { valence: -.8, arousal: .9, dominance: .6 },
  disgust: { valence: -.7, arousal: .5, dominance: .3 },
  fear: { valence: -.8, arousal: .9, dominance: -.7 },
  happiness: { valence: .9, arousal: .7, dominance: .4 },
  neutral: { valence: 0, arousal: 0, dominance: 0 },
  sadness: { valence: -.7, arousal: .2, dominance: -.5 },
  surprise: { valence: 0, arousal: .8, dominance: 0 },
};

export function projectVisualVad(scores: readonly { name: string; score: number }[]) {
  if (scores.length !== 7 || new Set(scores.map((score) => score.name)).size !== 7
      || scores.some(({ name, score }) => !Object.hasOwn(VISUAL_VAD_ANCHORS, name)
        || !Number.isFinite(score) || score < 0 || score > 100)) return null;
  const total = scores.reduce((sum, value) => sum + value.score, 0);
  if (total <= 0) return null;
  const point: VisualPoint = { valence: 0, arousal: 0, dominance: 0 };
  for (const { name, score } of scores) {
    const anchor = VISUAL_VAD_ANCHORS[name];
    point.valence += anchor.valence * score / total;
    point.arousal += anchor.arousal * score / total;
    point.dominance += anchor.dominance * score / total;
  }
  const intensity = Math.sqrt(VISUAL_VAD_WEIGHTS.valence * point.valence ** 2
    + VISUAL_VAD_WEIGHTS.arousal * point.arousal ** 2 + VISUAL_VAD_WEIGHTS.dominance * point.dominance ** 2);
  return { vad: { ...point, mappingVersion: VISUAL_VAD_VERSION }, intensity };
}

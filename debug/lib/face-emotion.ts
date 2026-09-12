export const emotionNames = {
  anger: "愤怒", disgust: "厌恶", fear: "恐惧", happiness: "快乐",
  neutral: "中性", sadness: "悲伤", surprise: "惊讶",
} as const;
export type FaceResult = {
  status: "ok" | "unavailable";
  reason: "no_face" | "multiple_faces" | "low_quality" | "model_unavailable" | null;
  faceCount: number;
  scores: { name: string; label: string; score: number }[];
};
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
export function parseFaceResult(value: unknown): FaceResult {
  const faces = object(value).faces;
  if (!Array.isArray(faces)) throw new Error("Invalid response");
  const base: FaceResult = { status: "unavailable", reason: "model_unavailable", faceCount: faces.length, scores: [] };
  if (!faces.length) return { ...base, reason: "no_face" };
  if (faces.length !== 1) return { ...base, reason: "multiple_faces" };
  const attributes = object(object(faces[0]).attributes);
  const blur = object(object(attributes.blur).blurness);
  // Face++ facequality is for identity comparison, not emotion confidence.
  if (typeof blur.value === "number" && typeof blur.threshold === "number" && blur.value > blur.threshold) {
    return { ...base, reason: "low_quality" };
  }
  const emotion = object(attributes.emotion);
  const scores = Object.entries(emotionNames).map(([name, label]) => ({ name, label, score: emotion[name] }));
  if (!scores.every((s) => typeof s.score === "number" && Number.isFinite(s.score) && s.score >= 0 && s.score <= 100)) return base;
  return { ...base, status: "ok", reason: null, scores: (scores as FaceResult["scores"]).sort((a, b) => b.score - a.score) };
}

// Read JPEG frame dimensions without decoding or persisting the image.
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i++] !== 0xff) return null;
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xda || marker === 0xd9) return null;
    const size = bytes[i] * 256 + bytes[i + 1];
    if (size < 2 || i + size > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) return null;
      return { height: bytes[i + 3] * 256 + bytes[i + 4], width: bytes[i + 5] * 256 + bytes[i + 6] };
    }
    i += size;
  }
  return null;
}

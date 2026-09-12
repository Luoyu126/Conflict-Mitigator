import "server-only";

import sharp from "sharp";
import { frameMetadataSchema, type FrameMetadata } from "../../contracts/affect.ts";
import { ApiProblem } from "../server/errors.ts";

export const MAX_FACE_JPEG_BYTES = 512 * 1024;
export const MAX_FACE_DIMENSION = 640;
export const FACE_EMOTION_NAMES = ["anger", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"] as const;
export type ParsedFace = {
  status: "ok" | "unavailable";
  reason: "no_face" | "multiple_faces" | "low_quality" | "model_unavailable" | null;
  faceCount: number;
  scores: { name: string; score: number }[];
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Whitelist derived fields; Face++ face_token/image_id/landmarks never escape. */
export function parseFaceResult(value: unknown): ParsedFace {
  const faces = object(value).faces;
  const base: ParsedFace = { status: "unavailable", reason: "model_unavailable", faceCount: Array.isArray(faces) ? faces.length : 0, scores: [] };
  if (!Array.isArray(faces) || object(value).error_message) return base;
  if (faces.length === 0) return { ...base, reason: "no_face" };
  if (faces.length !== 1) return { ...base, reason: "multiple_faces" };
  const attributes = object(object(faces[0]).attributes);
  const blur = object(object(attributes.blur).blurness);
  // Blur is a quality gate, never a confidence estimate. facequality is an
  // identity-comparison score and must not be repurposed as emotion confidence.
  if (typeof blur.value !== "number" || !Number.isFinite(blur.value)
      || typeof blur.threshold !== "number" || !Number.isFinite(blur.threshold)) return base;
  if (blur.value > blur.threshold) return { ...base, reason: "low_quality" };
  const emotion = object(attributes.emotion);
  const scores = FACE_EMOTION_NAMES.map((name) => ({ name, score: emotion[name] }));
  if (scores.some(({ score }) => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100)) return base;
  const valid = scores as ParsedFace["scores"];
  if (valid.every(({ score }) => score === 0)) return base;
  return { status: "ok", reason: null, faceCount: 1, scores: valid.sort((a, b) => b.score - a.score) };
}

export function invalidFrame(message = "A valid, rotation-corrected JPEG frame is required."): never {
  throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message });
}

/** Fully decode a bounded JPEG, verify geometry, and strip EXIF/other metadata.
 * Buffers are transient memory only; no filesystem/image URL access is used.
 */
export async function validateFaceFrame(jpeg: Uint8Array, metadata: FrameMetadata, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!frameMetadataSchema.safeParse(metadata).success) invalidFrame("Frame metadata does not match the inference contract.");
  if (jpeg.byteLength > MAX_FACE_JPEG_BYTES) throw new ApiProblem({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "The JPEG frame exceeds 512 KiB." });
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) invalidFrame();
  const decoder = sharp(jpeg, { failOn: "warning", limitInputPixels: MAX_FACE_DIMENSION ** 2, sequentialRead: true });
  try {
    const image = await decoder.metadata();
    if (image.format !== "jpeg" || image.width !== metadata.width || image.height !== metadata.height
        || Math.max(image.width, image.height) > MAX_FACE_DIMENSION || (image.orientation !== undefined && image.orientation !== 1)) {
      invalidFrame("Decoded JPEG dimensions or rotation do not match metadata.");
    }
    // toBuffer forces entropy decoding too; a header-only/truncated JPEG fails.
    const frame = await decoder.jpeg({ quality: 80 }).toBuffer();
    signal?.throwIfAborted();
    if (frame.length > MAX_FACE_JPEG_BYTES) throw new ApiProblem({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "The decoded JPEG exceeds the frame limit." });
    return frame;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof ApiProblem) throw error;
    invalidFrame();
  } finally { decoder.destroy(); }
}

/** Bound the bytes as they arrive, including bodies without Content-Length. */
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new ApiProblem({ status: 400, code: "INVALID_REQUEST", message: "A request body is required." });
  signal?.throwIfAborted();
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ApiProblem({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "The body exceeds its allowed size." });
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel(); reader.releaseLock();
  }
}

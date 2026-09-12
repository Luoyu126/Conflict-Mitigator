import "server-only";

import { type AffectResult, type FrameMetadata } from "../../contracts/affect.ts";
import { parseFaceResult, readBoundedBody, validateFaceFrame } from "../affect/face.ts";
import { projectVisualVad } from "../affect/visual-vad.ts";

/** Server-only configuration: FACEPLUSPLUS_API_KEY, FACEPLUSPLUS_API_SECRET,
 * FACEPLUSPLUS_REGION=us|cn (default us, matching the provider account region).
 * No NEXT_PUBLIC values or local credential-file fallback are read. Camera JPEGs
 * are sent to Face++ Detect; this application stores neither frames nor provider
 * identity tokens. Provider-side retention is governed by the provider terms.
 */
const PROVIDER_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;
let activeRequests = 0;
const model = { provider: "Face++", name: "Detect emotion", version: "v3" } as const;

export async function analyzeFaceFrame(
  jpeg: Uint8Array, metadata: FrameMetadata,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<AffectResult> {
  const started = performance.now();
  const unavailable = (): AffectResult => ({ observationId: metadata.observationId, status: "unavailable", reason: "model_unavailable",
    intensity: null, confidence: null, faceCount: 0, scores: [], vad: null, model, inferenceMs: Math.max(0, Math.round(performance.now() - started)) });
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
  // Invalid input is a caller error; it must never reach the provider.
  const frame = await validateFaceFrame(jpeg, metadata, signal);
  const key = process.env.FACEPLUSPLUS_API_KEY?.trim();
  const secret = process.env.FACEPLUSPLUS_API_SECRET?.trim();
  const region = process.env.FACEPLUSPLUS_REGION?.trim() || "us";
  if (!key || !secret || !["us", "cn"].includes(region) || activeRequests >= MAX_CONCURRENT_REQUESTS) return unavailable();
  activeRequests++;
  try {
    signal.throwIfAborted();
    const form = new FormData();
    form.set("api_key", key); form.set("api_secret", secret);
    form.set("return_attributes", "emotion,blur");
    form.set("image_file", new Blob([Uint8Array.from(frame)], { type: "image/jpeg" }), "frame.jpg");
    const response = await (options.fetch ?? fetch)(`https://api-${region}.faceplusplus.com/facepp/v3/detect`, {
      method: "POST", body: form, cache: "no-store", redirect: "error", signal,
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return unavailable(); }
    const payload = await readBoundedBody(response.body, MAX_PROVIDER_RESPONSE_BYTES, signal);
    const data = parseFaceResult(JSON.parse(new TextDecoder().decode(payload)));
    const base = unavailable();
    if (data.status !== "ok") return { ...base, reason: data.reason ?? "model_unavailable", faceCount: data.faceCount };
    const projection = projectVisualVad(data.scores);
    if (!projection) return base;
    // confidence intentionally remains null; VAD is labeled experimental.
    signal.throwIfAborted();
    return { ...base, status: "ok", reason: null, faceCount: 1, scores: data.scores, ...projection };
  } catch {
    // Never return provider error strings, credentials, face tokens, or image IDs.
    return unavailable();
  } finally { activeRequests--; }
}

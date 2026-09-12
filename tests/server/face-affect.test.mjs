import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { affectResultSchema } from "../../contracts/affect.ts";
import { parseFaceResult, validateFaceFrame, readBoundedBody, MAX_FACE_JPEG_BYTES } from "../../lib/affect/face.ts";
import { projectVisualVad, VISUAL_VAD_VERSION } from "../../lib/affect/visual-vad.ts";
import { analyzeFaceFrame } from "../../lib/integrations/faceplus.ts";
import { POST } from "../../app/internal/v1/affect/frames/route.ts";

test.describe("camera inference adapter", () => {
const envNames = ["FACEPLUSPLUS_API_KEY", "FACEPLUSPLUS_API_SECRET", "FACEPLUSPLUS_REGION", "INFERENCE_SERVICE_TOKEN"];
const originalEnvironment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
let jpeg;
const metadata = () => ({ observationId: randomUUID(), roomId: randomUUID(), participantIdentity: randomUUID(),
  trackSid: "TR_camera_test", streamId: randomUUID(), sampledAtMs: 1000, sdkTimestampUs: "1234000",
  consentRevision: 1, width: 64, height: 48, rotationApplied: true });
const emotion = { anger: 80, disgust: 5, fear: 2, happiness: 3, neutral: 4, sadness: 5, surprise: 1 };
function faceResponse(extra = {}) {
  return { image_id: "provider-image-secret", faces: [{ face_token: "provider-face-secret",
    attributes: { emotion, blur: { blurness: { value: 5, threshold: 80 } } } }], ...extra };
}
const unavailable = (result, reason = "model_unavailable") => {
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, reason);
  assert.equal(result.intensity, null);
  assert.equal(result.confidence, null);
  assert.deepEqual(result.scores, []);
  assert.equal(result.vad, null);
  assert.equal(affectResultSchema.safeParse(result).success, true);
};
function upload(meta = metadata(), frame = jpeg, extra = {}) {
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
  form.set("frame", new Blob([frame], { type: "image/jpeg" }), "frame.jpg");
  return new Request("http://inference.local/internal/v1/affect/frames", {
    method: "POST", headers: { Authorization: "Bearer inference-test-only" }, body: form, ...extra,
  });
}

test.before(async () => {
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 100, b: 180 } } }).jpeg().toBuffer();
});
test.beforeEach(() => {
  process.env.FACEPLUSPLUS_API_KEY = "camera-test-key";
  process.env.FACEPLUSPLUS_API_SECRET = "camera-test-secret";
  process.env.FACEPLUSPLUS_REGION = "us";
  process.env.INFERENCE_SERVICE_TOKEN = "inference-test-only";
  globalThis.fetch = async () => { throw new Error("Unexpected network call in camera regression test"); };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
});

test("Face++ parser preserves seven score values and drops provider identifiers", () => {
  const result = parseFaceResult(faceResponse());
  assert.equal(result.status, "ok");
  assert.equal(result.faceCount, 1);
  assert.equal(result.scores.length, 7);
  assert.deepEqual(result.scores[0], { name: "anger", score: 80 });
  assert.doesNotMatch(JSON.stringify(result), /provider-image-secret|provider-face-secret|face_token|image_id/);
});

test("no face, multiple faces, blur, missing or invalid scores never become calm observations", () => {
  assert.equal(parseFaceResult({ faces: [] }).reason, "no_face");
  assert.equal(parseFaceResult({ faces: [{}, {}] }).reason, "multiple_faces");
  const blurred = faceResponse();
  blurred.faces[0].attributes.blur.blurness.value = 99;
  assert.equal(parseFaceResult(blurred).reason, "low_quality");
  for (const value of [NaN, Infinity, -1, 101, "80", undefined]) {
    const response = faceResponse();
    response.faces[0].attributes.emotion = { ...emotion, anger: value };
    assert.equal(parseFaceResult(response).reason, "model_unavailable");
  }
  assert.equal(parseFaceResult({}).reason, "model_unavailable");
  assert.equal(parseFaceResult(faceResponse({ error_message: "AUTHENTICATION_ERROR: secret" })).reason, "model_unavailable");
});

test("visual VAD uses the original experimental anchors and does not infer from missing scores", () => {
  const scores = Object.keys(emotion).map((name) => ({ name, score: name === "anger" ? 100 : 0 }));
  const projected = projectVisualVad(scores);
  assert.deepEqual(projected.vad, { valence: -.8, arousal: .9, dominance: .6, mappingVersion: VISUAL_VAD_VERSION });
  assert.equal(projected.intensity, Math.sqrt(.15 * .8 ** 2 + .7 * .9 ** 2 + .15 * .6 ** 2));
  assert.equal(projectVisualVad(scores.slice(1)), null);
  assert.equal(projectVisualVad(scores.map((score) => ({ ...score, score: 0 }))), null);
  assert.equal(projectVisualVad([...scores.slice(1), scores[1]]), null);
});

test("JPEG validation fully decodes bytes, requires matching dimensions, and strips EXIF", async () => {
  const withExif = await sharp(jpeg).withMetadata({ orientation: 1 }).jpeg().toBuffer();
  const stripped = await validateFaceFrame(withExif, metadata());
  const decoded = await sharp(stripped).metadata();
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 48);
  assert.equal(decoded.exif, undefined);
  assert.equal(decoded.orientation, undefined);
  await assert.rejects(validateFaceFrame(jpeg, { ...metadata(), width: 63 }), { code: "VALIDATION_ERROR" });
  await assert.rejects(validateFaceFrame(jpeg.subarray(0, Math.floor(jpeg.length / 2)), metadata()), { code: "VALIDATION_ERROR" });
  const rotated = await sharp(jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await assert.rejects(validateFaceFrame(rotated, metadata()), { code: "VALIDATION_ERROR" });
  await assert.rejects(validateFaceFrame(new Uint8Array(MAX_FACE_JPEG_BYTES + 1), metadata()), { code: "PAYLOAD_TOO_LARGE" });
  const png = await sharp(jpeg).png().toBuffer();
  await assert.rejects(validateFaceFrame(png, metadata()), { code: "VALIDATION_ERROR" });
});

test("provider adapter sends a JPEG with only requested attributes and returns a whitelisted result", async () => {
  const meta = metadata();
  const result = await analyzeFaceFrame(jpeg, meta, { fetch: async (url, options) => {
    assert.equal(url, "https://api-us.faceplusplus.com/facepp/v3/detect");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.body.get("api_key"), "camera-test-key");
    assert.equal(options.body.get("api_secret"), "camera-test-secret");
    assert.equal(options.body.get("return_attributes"), "emotion,blur");
    assert.equal(options.body.get("image_file").type, "image/jpeg");
    assert.deepEqual([...options.body.keys()].sort(), ["api_key", "api_secret", "image_file", "return_attributes"]);
    return Response.json(faceResponse());
  } });
  assert.equal(affectResultSchema.safeParse(result).success, true);
  assert.equal(result.observationId, meta.observationId);
  assert.equal(result.status, "ok");
  assert.equal(result.faceCount, 1);
  assert.equal(result.confidence, null);
  assert.equal(result.vad.mappingVersion, VISUAL_VAD_VERSION);
  assert.doesNotMatch(JSON.stringify(result), /camera-test-key|camera-test-secret|provider-image-secret|provider-face-secret/);
});

test("provider outages, excessive responses and malformed JSON yield unavailable without raw error details", async () => {
  const responses = [
    () => new Response("AUTHENTICATION_ERROR: camera-test-secret", { status: 401 }),
    () => new Response("CONCURRENCY_LIMIT_EXCEEDED", { status: 429 }),
    () => new Response("{broken json"),
    () => new Response(" ".repeat(256 * 1024 + 1)),
    () => Response.json(faceResponse({ error_message: "AUTHENTICATION_ERROR: camera-test-secret" })),
  ];
  for (const reply of responses) {
    const result = await analyzeFaceFrame(jpeg, metadata(), { fetch: async () => reply() });
    unavailable(result);
    assert.doesNotMatch(JSON.stringify(result), /camera-test-secret|AUTHENTICATION_ERROR|CONCURRENCY_LIMIT_EXCEEDED/);
  }
  unavailable(await analyzeFaceFrame(jpeg, metadata(), { fetch: async () => { throw new Error("private network details"); } }));
});

test("provider unavailable configuration never makes a network request", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(faceResponse()); };
  delete process.env.FACEPLUSPLUS_API_SECRET;
  unavailable(await analyzeFaceFrame(jpeg, metadata(), { fetch }));
  process.env.FACEPLUSPLUS_API_SECRET = "camera-test-secret";
  process.env.FACEPLUSPLUS_REGION = "https://attacker.invalid";
  unavailable(await analyzeFaceFrame(jpeg, metadata(), { fetch }));
  assert.equal(calls, 0);
});

test("aborted provider responses cannot publish valid scores", async () => {
  const controller = new AbortController();
  const result = await analyzeFaceFrame(jpeg, metadata(), { signal: controller.signal, fetch: async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    controller.abort();
    return Response.json(faceResponse());
  } });
  unavailable(result);
});

test("bounded stream reading cancels oversized and aborted inputs without waiting for EOF", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(body, 9), { code: "PAYLOAD_TOO_LARGE" });
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const waiting = readBoundedBody(new ReadableStream({}), 10, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("API-27 requires inference authentication before reading the body", async () => {
  let bodyRead = false;
  const response = await POST({ headers: new Headers({ Authorization: "Bearer wrong-token" }),
    get body() { bodyRead = true; throw new Error("Authentication must happen first"); } });
  assert.equal(response.status, 401);
  assert.equal(bodyRead, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("API-27 accepts strict multipart parts and emits the standard private response envelope", async () => {
  globalThis.fetch = async () => Response.json(faceResponse());
  const meta = metadata();
  const response = await POST(upload(meta));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.observationId, meta.observationId);
  assert.equal(body.data.confidence, null);
  assert.ok(body.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(body), /face_token|image_id|camera-test-key|camera-test-secret/);
});

test("API-27 rejects extra/duplicate parts, plain metadata text, invalid JPEGs and oversized streaming bodies", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(faceResponse()); };
  const plain = new FormData();
  plain.set("metadata", JSON.stringify(metadata()));
  plain.set("frame", new Blob([jpeg], { type: "image/jpeg" }), "frame.jpg");
  const badText = await POST(new Request("http://inference.local/internal/v1/affect/frames", {
    method: "POST", headers: { Authorization: "Bearer inference-test-only" }, body: plain,
  }));
  assert.equal(badText.status, 422);
  const duplicate = await upload().formData();
  duplicate.append("frame", new Blob([jpeg], { type: "image/jpeg" }), "another.jpg");
  const badDuplicate = await POST(new Request("http://inference.local/internal/v1/affect/frames", {
    method: "POST", headers: { Authorization: "Bearer inference-test-only" }, body: duplicate,
  }));
  assert.equal(badDuplicate.status, 422);
  assert.equal((await POST(upload(metadata(), new Uint8Array([0xff, 0xd8, 0, 0])))).status, 422);
  const enormous = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600 * 1024)); } });
  const oversized = await POST(new Request("http://inference.local/internal/v1/affect/frames", {
    method: "POST", headers: { Authorization: "Bearer inference-test-only", "Content-Type": "multipart/form-data; boundary=bound" },
    body: enormous, duplex: "half",
  }));
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

});

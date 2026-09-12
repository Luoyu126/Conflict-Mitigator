import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHumeStream } from "../../lib/integrations/hume.ts";
import { parseVoiceAffect } from "../../lib/affect/voice.ts";
import { projectVoiceVad, VOICE_VAD_ANCHORS, VOICE_VAD_VERSION } from "../../lib/affect/voice-vad.ts";
import { affectResultSchema } from "../../contracts/affect.ts";

const weights = (values = { Anger: 1 }) => Object.fromEntries(Object.keys(VOICE_VAD_ANCHORS).map(name => [name, values[name] ?? 0]));
const event = scores => ({ type: "user_message", from_text: false, interim: false, models: { prosody: { scores } },
  message: { content: "PRIVATE PROVIDER TRANSCRIPT" }, chat_id: "PRIVATE_PROVIDER_ID" });
class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent = [];
  terminated = 0;
  send(value) { this.sent.push(JSON.parse(value)); }
  terminate() { this.terminated++; this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
function setup(deps = {}) {
  const socket = new Socket(), controller = new AbortController(), results = [], errors = [], calls = [];
  const stream = createHumeStream({ sampleRate: 24_000, signal: controller.signal,
    onResult: value => results.push(value), onError: error => errors.push(error.message),
  }, { config: { apiKey: "offline-test-key", configId: "offline-config" },
    createSocket: (url, options) => { calls.push({ url, options }); return socket; }, ...deps });
  const ready = () => { socket.open(); socket.receive({ type: "chat_metadata", chat_id: "provider-session" }); };
  return { socket, controller, results, errors, calls, stream, ready };
}

test("final voice events preserve 48 raw scores and experimental VAD without text or false latency", () => {
  const result = parseVoiceAffect(event(weights()));
  assert.equal(result.status, "ok");
  assert.equal(result.scores.length, 48);
  assert.equal(result.confidence, null);
  assert.equal(result.inferenceMs, null);
  assert.equal(result.vad.mappingVersion, VOICE_VAD_VERSION);
  assert.equal(result.vad.valence, -.8);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|chat_id|content|participant|faceCount/);
  assert.equal(affectResultSchema.safeParse({ ...result, observationId: "00000000-0000-4000-8000-000000000001" }).success, true);
});

test("interim, text and assistant messages never produce observations", () => {
  for (const value of [{ ...event(weights()), interim: true }, { ...event(weights()), from_text: true },
    { type: "assistant_message", models: event(weights()).models }, { type: "audio_output" }, null]) {
    assert.equal(parseVoiceAffect(value), null);
  }
});

test("missing, all-zero, invalid or unexpected scores produce unknown instead of calm", () => {
  for (const scores of [undefined, {}, weights({}), { ...weights(), Anger: 2 }, { ...weights(), Anger: NaN },
    { ...weights(), Joy: "0.2" }, { ...weights(), unknown: .1 }]) {
    const result = parseVoiceAffect(event(scores));
    assert.equal(result.status, "unavailable"); assert.equal(result.intensity, null);
    assert.equal(result.vad, null); assert.deepEqual(result.scores, []);
  }
  const good = Object.entries(weights()).map(([name, score]) => ({ name, score }));
  assert.equal(projectVoiceVad(good.map(() => good[0])), null);
  assert.equal(projectVoiceVad(good.slice(1)), null);
});

test("voice normalization retains score scale independence and bounded coordinates", () => {
  const toList = v => Object.entries(weights(v)).map(([name, score]) => ({ name, score }));
  const a = projectVoiceVad(toList({ Joy: .5, Calmness: .5 }));
  const b = projectVoiceVad(toList({ Joy: .1, Calmness: .1 }));
  for (const key of ["v", "a", "d", "intensity"]) assert.ok(Math.abs(a[key] - b[key]) < 1e-12);
  assert.equal(projectVoiceVad(toList({ Calmness: 1 })).intensity, 0);
});

test("provider receives configured mono little-endian PCM only after readiness", t => {
  const f = setup(); t.after(f.stream.close);
  assert.equal(f.stream.write(new Int16Array([1])), false); assert.equal(f.socket.sent.length, 0);
  f.ready();
  assert.deepEqual(f.socket.sent[0], { type: "session_settings", audio: { encoding: "linear16", sample_rate: 24000, channels: 1 } });
  const bytes = new Int16Array([-32768, -1, 0, 32767]);
  assert.equal(f.stream.write(bytes), true);
  assert.equal(Buffer.from(f.socket.sent[1].data, "base64").toString("hex"), "0080ffff0000ff7f");
  assert.ok(f.calls[0].url.startsWith("wss://api.hume.ai/v0/evi/chat?"));
  assert.equal(f.calls[0].options.headers["X-Hume-Api-Key"], "offline-test-key");
  assert.ok(!f.calls[0].url.includes("offline-test-key"));
  f.socket.receive(event(weights()));
  assert.equal(f.results.length, 1);
  f.socket.receive({ type: "assistant_message", message: { content: "do not expose" } });
  f.socket.receive({ type: "audio_output", data: "do not play" });
  assert.equal(f.results.length, 1);
});

test("abort closes the upstream immediately and ignores every late event", () => {
  const f = setup(); f.ready(); f.controller.abort();
  assert.equal(f.socket.terminated, 1);
  assert.equal(f.stream.write(new Int16Array([1])), false);
  f.socket.receive(event(weights())); f.socket.emit("error", new Error("provider detail"));
  f.stream.close(); assert.equal(f.socket.terminated, 1);
  assert.deepEqual(f.results, []); assert.deepEqual(f.errors, []);
});

test("pre-aborted and unconfigured streams never contact provider", () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const stream = createHumeStream({ sampleRate: 24000, signal: controller.signal, onResult() {} },
    { createSocket() { called = true; throw new Error("must not connect"); } });
  assert.equal(called, false); assert.equal(stream.write(new Int16Array([1])), false);
  const f = setup({ config: { apiKey: "" } });
  assert.equal(f.calls.length, 0); assert.equal(f.results[0].status, "unavailable");
  assert.equal(f.errors.length, 1);
});

test("network backlog and input-rate overflow terminate once without retaining queued PCM", () => {
  for (const mode of ["backlog", "rate"]) {
    const f = setup(); f.ready();
    if (mode === "backlog") f.socket.bufferedAmount = 256001;
    else for (let i = 0; i < 3; i++) assert.equal(f.stream.write(new Int16Array(24000)), true);
    assert.equal(f.stream.write(new Int16Array(mode === "backlog" ? 1 : 24000)), false);
    assert.equal(f.socket.terminated, 1); assert.equal(f.errors.length, 1);
    assert.equal(f.results.length, 1); assert.equal(f.results[0].reason, "model_unavailable");
  }
});

test("provider failures are sanitized and never emit raw error body or credentials", () => {
  for (const mode of ["error", "invalid", "close", "provider_error"]) {
    const f = setup(); f.ready();
    if (mode === "error") f.socket.emit("error", new Error("offline-test-key secret transcript"));
    if (mode === "invalid") f.socket.emit("message", Buffer.from("secret invalid response"));
    if (mode === "close") f.socket.emit("close");
    if (mode === "provider_error") f.socket.receive({ type: "error", message: "private diagnostic" });
    assert.equal(f.results.length, 1); assert.equal(f.errors.length, 1);
    assert.doesNotMatch(JSON.stringify([f.errors, f.results]), /offline-test-key|secret|private diagnostic/);
  }
});

test("readiness, input idle and maximum stream duration have bounded cleanup", async () => {
  for (const mode of ["readyTimeoutMs", "idleTimeoutMs", "maxDurationMs"]) {
    const f = setup({ [mode]: 10 });
    if (mode !== "readyTimeoutMs") f.ready();
    await delay(25);
    assert.equal(f.socket.terminated, 1, mode);
    assert.equal(f.results.length, 1, mode);
    assert.equal(f.errors.length, 1, mode);
    assert.equal(f.stream.write(new Int16Array([1])), false);
  }
});

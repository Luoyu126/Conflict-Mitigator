import test from "node:test";
import assert from "node:assert/strict";
import { TokenVerifier, TrackSource } from "livekit-server-sdk";
import { validateJoin, isLocalRequest, issueDebugToken } from "../lib/token.ts";
import { summarizeAudioReport, summarizeVideoReport } from "../lib/stats.ts";

test("debug input cannot choose an identity, grants, or arbitrary room namespace", () => {
  assert.deepEqual(validateJoin({ room: " test-1 ", name: " Alice " }), { room: "test-1", name: "Alice" });
  for (const input of [null, [], {}, { room: "../real", name: "A" }, { room: "x", name: " " }, { room: "x", name: "A", identity: "host" }]) {
    assert.equal(validateJoin(input), null);
  }
});

test("token endpoint allows only loopback, same-origin browser requests", () => {
  const request = (host, origin) => new Request(`http://${host}/api/token`, { headers: { host, origin } });
  assert.equal(isLocalRequest(request("localhost:3001", "http://localhost:3001")), true);
  assert.equal(isLocalRequest(request("localhost:3001", "https://example.com")), false);
  assert.equal(isLocalRequest(request("192.168.1.2:3001", "http://192.168.1.2:3001")), false);
  assert.equal(isLocalRequest(new Request("http://localhost:3001/api/token")), false);
  assert.equal(isLocalRequest(new Request("http://localhost:3001/api/token", {
    headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" },
  })), true);
  assert.equal(isLocalRequest(request("localhost:3001", "http://localhost:3002")), false);
});

test("temporary tokens are camera-and-microphone-only, room-bound and unique", async () => {
  const config = { url: "wss://example.livekit.cloud", key: "test-key", secret: "test-secret-only-not-a-real-credential" };
  const first = await issueDebugToken({ room: "trial", name: "Alice" }, config);
  const second = await issueDebugToken({ room: "trial", name: "Alice" }, config);
  const claims = await new TokenVerifier(config.key, config.secret).verify(first.participantToken);
  assert.equal(claims.sub, first.identity);
  assert.notEqual(first.identity, second.identity);
  assert.equal(claims.video.room, "debug-audio-trial");
  assert.deepEqual(claims.video.canPublishSources, ["microphone", "camera"]);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.ok(claims.exp - claims.nbf <= 600);
  assert.equal(TrackSource.MICROPHONE, 2);
  await assert.rejects(issueDebugToken({ room: "trial", name: "Alice" }, { ...config, url: "http://example.com" }));
});

test("audio stats preserve missing values and convert seconds to milliseconds", () => {
  assert.deepEqual(summarizeAudioReport([]), {});
  const receive = summarizeAudioReport([
    { type: "inbound-rtp", kind: "audio", jitter: .012, packetsLost: 3, jitterBufferDelay: 2, jitterBufferEmittedCount: 100, codecId: "codec" },
    { type: "codec", id: "codec", mimeType: "audio/opus" },
  ]);
  assert.equal(receive.jitterMs, 12);
  assert.equal(receive.bufferMeanMs, 20);
  assert.equal(receive.rttMs, undefined);
  assert.equal(receive.codec, "audio/opus");
  const send = summarizeAudioReport([
    { type: "outbound-rtp", kind: "audio", remoteId: "remote" },
    { type: "remote-inbound-rtp", id: "remote", roundTripTime: .08 },
  ]);
  assert.equal(send.rttMs, 80);
  assert.equal(send.jitterMs, undefined);
});

test("video stats keep simulcast layers separate and preserve missing decode values", () => {
  const rows = summarizeVideoReport([
    { type: "outbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, remoteId: "r" },
    { type: "outbound-rtp", kind: "video", frameWidth: 640, frameHeight: 360 },
    { type: "remote-inbound-rtp", id: "r", roundTripTime: .04 },
    { type: "inbound-rtp", kind: "audio" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].width, 1280);
  assert.equal(rows[0].rttMs, 40);
  assert.equal(rows[1].fps, undefined);
  assert.equal(rows[0].decodeMeanMs, undefined);
  const [receive] = summarizeVideoReport([{ type: "inbound-rtp", kind: "video", totalDecodeTime: .2, framesDecoded: 100, jitterBufferDelay: 3, jitterBufferEmittedCount: 100 }]);
  assert.equal(receive.decodeMeanMs, 2);
  assert.equal(receive.bufferMeanMs, 30);
  assert.deepEqual(summarizeVideoReport([]), []);
});

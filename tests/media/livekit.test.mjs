import test from "node:test";
import assert from "node:assert/strict";
import { TokenVerifier } from "livekit-server-sdk";
import { createLiveKitAudioConnection, readLiveKitConfig } from "../../lib/integrations/livekit.ts";

const config = {
  serverUrl: "wss://example.livekit.cloud",
  apiKey: "unit-test-key",
  apiSecret: "unit-test-secret-not-a-real-credential",
};
const input = {
  roomId: "1a946068-46e2-47ea-b827-915c51fca64a",
  participantId: "7c2f9d9c-6139-4a90-b9d5-286e33da374a",
  displayName: " Alice ",
};

test("audio connection matches API DTO, stable identity and signed expiration", async () => {
  const result = await createLiveKitAudioConnection(input, config);
  const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(result.participantToken);
  assert.deepEqual(Object.keys(result).sort(), ["serverUrl", "participantToken", "roomName", "participantIdentity", "expiresAt"].sort());
  assert.equal(result.roomName, `cm_${input.roomId}`);
  assert.equal(result.participantIdentity, input.participantId);
  assert.equal(claims.sub, input.participantId);
  assert.equal(claims.name, "Alice");
  assert.equal(claims.video.room, result.roomName);
  assert.equal(result.expiresAt, new Date(claims.exp * 1000).toISOString());
  assert.equal(claims.exp - claims.nbf, 600);
  const retry = await createLiveKitAudioConnection(input, config);
  assert.equal(retry.participantIdentity, result.participantIdentity);
  assert.equal(retry.roomName, result.roomName);
});

test("signer restricts publishing to microphone, never accepting external grants", async () => {
  const result = await createLiveKitAudioConnection({
    ...input, ttlSeconds: 120, roomName: "wrong-room", identity: "admin",
    grants: { roomAdmin: true, canPublishSources: ["camera"] },
  }, config);
  const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(result.participantToken);
  assert.deepEqual(claims.video.canPublishSources, ["microphone"]);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublishData, true);
  assert.equal(claims.video.canUpdateOwnMetadata, false);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.equal(claims.video.room, `cm_${input.roomId}`);
  assert.equal(claims.sub, input.participantId);
  assert.equal(claims.exp - claims.nbf, 120);
});

test("invalid persisted IDs, names, lifetime and server configuration are rejected", async () => {
  for (const change of [
    { roomId: "debug-audio-test" }, { participantId: "arbitrary-name" },
    { displayName: " " }, { displayName: "x".repeat(41) },
    { ttlSeconds: 0 }, { ttlSeconds: -1 }, { ttlSeconds: 1.5 },
  ]) await assert.rejects(createLiveKitAudioConnection({ ...input, ...change }, config));
  for (const change of [
    { serverUrl: "http://example.com" }, { serverUrl: "wss://user:password@example.com" },
    { serverUrl: "wss://example.com?secret=hidden" }, { apiKey: "" }, { apiSecret: " " },
  ]) await assert.rejects(createLiveKitAudioConnection(input, { ...config, ...change }));
});

test("environment loading stays server-side and configuration errors omit values", (context) => {
  const keys = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
  const previous = keys.map((key) => process.env[key]);
  context.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
  keys.forEach((key) => delete process.env[key]);
  assert.throws(readLiveKitConfig, /configuration is missing/);
  process.env.LIVEKIT_URL = config.serverUrl;
  process.env.LIVEKIT_API_KEY = config.apiKey;
  process.env.LIVEKIT_API_SECRET = config.apiSecret;
  assert.equal(readLiveKitConfig().serverUrl, "wss://example.livekit.cloud/");
  process.env.LIVEKIT_URL = "https://secret-value.invalid";
  assert.throws(readLiveKitConfig, (error) => error.message === "Invalid LiveKit server URL.");
});

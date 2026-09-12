import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createObserverToken, createNativeMedia, createMediaAdmin } from "../../worker/native-media.ts";
import { VideoFrame, VideoBufferType, dispose } from "@livekit/rtc-node";

test("native RTC bindings and production adapters import without contacting providers", () => {
  assert.equal(typeof createNativeMedia, "function"); assert.equal(typeof createMediaAdmin, "function");
  const frame = new VideoFrame(new Uint8Array(3 * 2 * 3), 3, 2, VideoBufferType.RGB24);
  assert.equal(frame.width, 3); assert.equal(frame.height, 2);
});

test("observer token is room-bound, hidden, subscribe-only and has no data-publish permission", async () => {
  const roomId = randomUUID(), runId = randomUUID();
  const token = await createObserverToken(roomId, runId, { serverUrl: "wss://offline.invalid", apiKey: "offline-key", apiSecret: "offline-secret-with-more-than-thirty-two-characters" });
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.equal(payload.sub, `observer_${runId}`); assert.equal(payload.video.room, `cm_${roomId}`);
  assert.equal(payload.video.hidden, true); assert.equal(payload.video.canSubscribe, true);
  assert.equal(payload.video.canPublish, false); assert.equal(payload.video.canPublishData, false);
  assert.equal(payload.video.canUpdateOwnMetadata, false); assert.notEqual(payload.video.roomAdmin, true);
});

test.after(async () => { await dispose(); });

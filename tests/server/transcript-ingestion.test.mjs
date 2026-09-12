import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeTranscriptIngestion } from "../../lib/worker/transcript-ingestion.ts";

const senderIdentity = randomUUID();
const roomId = randomUUID();
const validPacket = {
  segmentId: randomUUID(),
  streamId: randomUUID(),
  revision: 1,
  content: "  Keep the map.  ",
  startedAtMs: null,
  endedAtMs: null,
  language: "en-US",
  confidence: null,
  consentRevision: 2,
  recognizedAt: "2026-09-12T17:00:00.000Z",
};

test("normalizes a valid final packet into the API-22 request using sender identity", () => {
  const result = normalizeTranscriptIngestion({
    roomId, senderIdentity, trackSid: "TR_audio_1",
    receivedAt: "2026-09-12T17:00:01.000Z", payload: validPacket,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.participantIdentity, senderIdentity);
  assert.equal(result.request.trackSid, "TR_audio_1");
  assert.equal(result.request.isFinal, true);
  assert.equal(result.request.timeBasis, "unknown");
  assert.equal(result.request.content, "Keep the map.");
  assert.equal(result.request.consentRevision, 2);
  assert.equal(result.request.streamId, validPacket.streamId);
});

test("rejects a non-UUID sender identity without echoing content", () => {
  const result = normalizeTranscriptIngestion({
    roomId, senderIdentity: "not-a-uuid", trackSid: "TR_audio_1",
    receivedAt: "2026-09-12T17:00:01.000Z", payload: validPacket,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(result.reason, /Keep the map/);
});

test("rejects malformed packets and never leaks transcript text", () => {
  const missingSegment = { ...validPacket };
  delete missingSegment.segmentId;
  const result = normalizeTranscriptIngestion({
    roomId, senderIdentity, trackSid: "TR_audio_1",
    receivedAt: "2026-09-12T17:00:01.000Z", payload: missingSegment,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(result.reason, /Keep the map/);
});

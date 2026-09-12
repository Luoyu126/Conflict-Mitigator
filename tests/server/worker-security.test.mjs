import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDatabase, withTransaction, closeDatabase } from "../../lib/db/postgres.ts";
import {
  upsertWorkerLease, requireWorkerLeaseForRoute, getWorkerContext,
  ingestTranscript, submitMeetingAnalysis, ackIsolation,
} from "../../services/worker/index.ts";

const dbTest = (name, fn) => test(name, { skip: !process.env.DATABASE_URL }, fn);
const rooms = [];
const tx = withTransaction;
const code = (expected) => (error) => error?.code === expected;
const workerStatus = (runId, extra = {}) => ({ runId, status: "ready", audio: "ready", video: "disabled", meetingAgent: "ready", ...extra });

async function fixture() {
  const db = getDatabase();
  const roomId = randomUUID();
  const participantId = randomUUID();
  const runId = randomUUID();
  await db`INSERT INTO rooms (id, title, created_by, status) VALUES (${roomId}::uuid, 'Worker security regression', ${randomUUID()}::uuid, 'meeting')`;
  rooms.push(roomId);
  await db`INSERT INTO participants (id, room_id, auth_user_id, display_name, livekit_identity,
      transcription_consent, structured_sharing_consent)
    VALUES (${participantId}::uuid, ${roomId}::uuid, ${randomUUID()}::uuid, 'Member', ${participantId}, true, true)`;
  await tx((db) => upsertWorkerLease(db, roomId, workerStatus(runId)));
  return { roomId, participantId, runId };
}
function transcript(f, extra = {}) {
  return { segmentId: randomUUID(), participantIdentity: f.participantId, trackSid: "TR_microphone", streamId: randomUUID(),
    content: "A public proposal", isFinal: true, revision: 1, startedAtMs: null, endedAtMs: null, language: "en", confidence: null,
    receivedAt: new Date().toISOString(), timeBasis: "unknown", consentRevision: 1, ...extra };
}
const ingest = (f, body) => tx(async (db) => {
  await requireWorkerLeaseForRoute(db, f.roomId, f.runId);
  return ingestTranscript(db, f.roomId, body);
});
function analysis(f, segment, extra = {}) {
  return { analysisId: randomUUID(), baseMapVersion: 0, sourceTranscriptIds: [segment.segmentId], nodeUpserts: [{
    id: randomUUID(), parentNodeId: null, topic: "Public topic", summary: null, contentionScore: .2, discussionLoopCount: 0,
    participantStates: [{ participantId: f.participantId, position: "A public proposal", supportingReasons: [], underlyingConcerns: [],
      acceptableCompromises: [], emotionIntensity: null, viewOfOthers: [], evidenceTranscriptIds: [segment.segmentId] }],
  }], ...extra };
}
const analyze = (f, body) => tx(async (db) => {
  await requireWorkerLeaseForRoute(db, f.roomId, f.runId);
  return submitMeetingAnalysis(db, f.roomId, body);
});

dbTest("lease registration serializes contenders even when the lease row does not exist", async () => {
  const f = await fixture();
  await getDatabase()`DELETE FROM worker_leases WHERE room_id = ${f.roomId}::uuid`;
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map((runId) => tx((db) => upsertWorkerLease(db, f.roomId, workerStatus(runId)))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "WORKER_LEASE_CONFLICT");
});

dbTest("expired and replaced runs cannot mutate transcripts", async () => {
  const f = await fixture();
  await getDatabase()`UPDATE worker_leases SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE room_id = ${f.roomId}::uuid`;
  await assert.rejects(ingest(f, transcript(f)), code("WORKER_LEASE_CONFLICT"));
  await tx((db) => upsertWorkerLease(db, f.roomId, workerStatus(randomUUID())));
  await assert.rejects(ingest(f, transcript(f)), code("WORKER_LEASE_CONFLICT"));
});

dbTest("ingestion rejects cross-room IDs, changed stream bindings, future consent versions, and nonfinal input", async () => {
  const a = await fixture();
  const b = await fixture();
  const segment = transcript(a, { startedAtMs: 100, endedAtMs: 250, timeBasis: "receiver_estimate" });
  await ingest(a, segment);
  await assert.rejects(ingest(b, { ...segment, participantIdentity: b.participantId }), code("SEGMENT_REVISION_CONFLICT"));
  await assert.rejects(ingest(a, { ...segment, trackSid: "TR_other", revision: 2 }), code("SEGMENT_REVISION_CONFLICT"));
  await assert.rejects(ingest(a, transcript(a, { consentRevision: 2 })), code("CONSENT_REVOKED"));
  await assert.rejects(ingest(a, transcript(a, { isFinal: false })), code("INVALID_REQUEST"));
  await assert.rejects(ingest(a, { ...segment, confidence: .5 }), code("SEGMENT_REVISION_CONFLICT"));
  const replay = await ingest(a, segment);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.segment.startedAtMs, 100);
  assert.equal(replay.segment.endedAtMs, 250);
  const stored = await getDatabase()`SELECT room_id, participant_id, content FROM transcript_segments WHERE id = ${segment.segmentId}::uuid`;
  assert.deepEqual(stored[0], { room_id: a.roomId, participant_id: a.participantId, content: segment.content });
});

dbTest("public ingest is blocked for inactive members and ended rooms", async () => {
  const f = await fixture();
  await getDatabase()`UPDATE participants SET status = 'left' WHERE id = ${f.participantId}::uuid`;
  await assert.rejects(ingest(f, transcript(f)), code("TRACK_IDENTITY_MISMATCH"));
  await getDatabase()`UPDATE participants SET status = 'active' WHERE id = ${f.participantId}::uuid`;
  await getDatabase()`UPDATE rooms SET status = 'ended' WHERE id = ${f.roomId}::uuid`;
  await assert.rejects(ingest(f, transcript(f)), code("ROOM_ENDED"));
});

dbTest("analysis retries return the receipt; changed bodies conflict; revised finals reenter pending input", async () => {
  const f = await fixture();
  const segment = transcript(f);
  await ingest(f, segment);
  const request = analysis(f, segment);
  const first = await analyze(f, request);
  const repeat = await analyze(f, request);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.mapVersion, first.mapVersion);
  await assert.rejects(analyze(f, { ...request, nodeUpserts: [] }), code("ANALYSIS_ID_CONFLICT"));
  await ingest(f, { ...segment, content: "A revised proposal", revision: 2 });
  const context = await tx((db) => getWorkerContext(db, f.roomId, f.runId));
  assert.equal(context.pendingTranscripts.find((item) => item.id === segment.segmentId)?.revision, 2);
  const receiptCount = await getDatabase()`SELECT count(*)::int AS count FROM analysis_receipts WHERE room_id = ${f.roomId}::uuid`;
  assert.equal(receiptCount[0].count, 1);
});

dbTest("analysis validates room ownership, all evidence, and the final graph before committing any node", async () => {
  const f = await fixture();
  const other = await fixture();
  const segment = transcript(f);
  await ingest(f, segment);
  const foreignId = randomUUID();
  await getDatabase()`INSERT INTO mind_map_nodes (id, room_id, topic) VALUES (${foreignId}::uuid, ${other.roomId}::uuid, 'Foreign')`;
  const request = analysis(f, segment);
  const node = request.nodeUpserts[0];
  await assert.rejects(analyze(f, { ...request, nodeUpserts: [node, { ...node, id: foreignId }] }), code("CROSS_ROOM_REFERENCE"));
  const counts = await getDatabase()`SELECT count(*)::int AS count FROM mind_map_nodes WHERE room_id = ${f.roomId}::uuid`;
  assert.equal(counts[0].count, 0);
  await assert.rejects(analyze(f, { ...request, nodeUpserts: [{ ...node, parentNodeId: foreignId }] }), code("CROSS_ROOM_REFERENCE"));
  const secondId = randomUUID();
  await assert.rejects(analyze(f, { ...request, nodeUpserts: [{ ...node, parentNodeId: secondId }, { ...node, id: secondId, parentNodeId: node.id }] }), code("TREE_CYCLE"));
  const someone = randomUUID();
  await getDatabase()`INSERT INTO participants (id, room_id, auth_user_id, display_name) VALUES (${someone}::uuid, ${f.roomId}::uuid, ${randomUUID()}::uuid, 'Another member')`;
  await assert.rejects(analyze(f, { ...request, nodeUpserts: [{ ...node, participantStates: [{ ...node.participantStates[0], participantId: someone }] }] }), code("INVALID_EVIDENCE"));
});

dbTest("concurrent analyses consume a map version only once", async () => {
  const f = await fixture();
  const segment = transcript(f);
  await ingest(f, segment);
  const results = await Promise.allSettled([analysis(f, segment), analysis(f, segment)].map((request) => analyze(f, request)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "MAP_VERSION_CONFLICT");
});

async function isolationFixture() {
  const f = await fixture();
  const db = getDatabase();
  const nodeId = randomUUID();
  const sessionId = randomUUID();
  const cutoff = Math.floor(Date.now() / 1000);
  await db`INSERT INTO mind_map_nodes (id, room_id, topic, status) VALUES (${nodeId}::uuid, ${f.roomId}::uuid, 'Isolated topic', 'heated')`;
  await db`INSERT INTO mediation_sessions (id, room_id, node_id, status) VALUES (${sessionId}::uuid, ${f.roomId}::uuid, ${nodeId}::uuid, 'starting')`;
  await db`INSERT INTO mediation_members (mediation_session_id, participant_id, entry_decision, isolation_cutoff_unix_sec)
    VALUES (${sessionId}::uuid, ${f.participantId}::uuid, 'accept', ${cutoff})`;
  await db`UPDATE participants SET media_isolated = true, media_token_not_before = to_timestamp(${cutoff}) WHERE id = ${f.participantId}::uuid`;
  await db`UPDATE rooms SET status = 'mediation', active_mediation_session_id = ${sessionId}::uuid, active_mediation_node_id = ${nodeId}::uuid WHERE id = ${f.roomId}::uuid`;
  return { ...f, nodeId, sessionId, cutoff };
}
const acknowledge = (f, extra = {}) => tx((db) => ackIsolation(db, f.roomId, f.runId, {
  sessionId: f.sessionId, results: [{ participantId: f.participantId, revokeBeforeUnixSec: f.cutoff, succeeded: true, errorCode: null, ...extra }],
}));

dbTest("isolation accepts only persisted cutoffs, recovers from failed acknowledgements, and replays success monotonically", async () => {
  const f = await isolationFixture();
  const context = await tx((db) => getWorkerContext(db, f.roomId, f.runId));
  assert.equal(context.pendingIsolations[0].targets[0].revokeBeforeUnixSec, f.cutoff);
  await assert.rejects(acknowledge(f, { revokeBeforeUnixSec: f.cutoff + 1 }), code("ISOLATION_TARGET_MISMATCH"));
  const failed = await acknowledge(f, { succeeded: false, errorCode: "LIVEKIT_UNAVAILABLE" });
  assert.equal(failed.session.status, "starting");
  assert.equal((await acknowledge(f)).session.status, "active");
  assert.equal((await acknowledge(f)).session.status, "active");
  const receipt = await getDatabase()`SELECT succeeded, safe_error_code FROM media_isolation_results WHERE mediation_session_id = ${f.sessionId}::uuid`;
  assert.equal(receipt[0].succeeded, true);
  assert.equal(receipt[0].safe_error_code, null);
});

dbTest("cancelled isolation cannot be reactivated by a late success", async () => {
  const f = await isolationFixture();
  await getDatabase()`UPDATE mediation_sessions SET status = 'cancelled' WHERE id = ${f.sessionId}::uuid`;
  await assert.rejects(acknowledge(f), code("SESSION_STATE_CONFLICT"));
  const state = await getDatabase()`SELECT status FROM mediation_sessions WHERE id = ${f.sessionId}::uuid`;
  assert.equal(state[0].status, "cancelled");
});

dbTest("cleanup acknowledges issued targets without clearing newer cleanup or unrelated participants", async () => {
  const f = await fixture();
  const cutoff = Math.floor(Date.now() / 1000);
  const db = getDatabase();
  await db`UPDATE participants SET status = 'left', media_cleanup_pending = true, media_token_not_before = to_timestamp(${cutoff}) WHERE id = ${f.participantId}::uuid`;
  const first = await tx((db) => getWorkerContext(db, f.roomId, f.runId));
  assert.equal(first.mediaCleanupTargets.length, 1);
  await db`UPDATE participants SET media_token_not_before = to_timestamp(${cutoff + 1}) WHERE id = ${f.participantId}::uuid`;
  await tx((db) => upsertWorkerLease(db, f.roomId, workerStatus(f.runId, { mediaCleanupCompleted: true })));
  const pending = await db`SELECT media_cleanup_pending FROM participants WHERE id = ${f.participantId}::uuid`;
  assert.equal(pending[0].media_cleanup_pending, true);
  await tx((db) => getWorkerContext(db, f.roomId, f.runId));
  await tx((db) => upsertWorkerLease(db, f.roomId, workerStatus(f.runId, { mediaCleanupCompleted: true })));
  assert.equal((await tx((db) => getWorkerContext(db, f.roomId, f.runId))).mediaCleanupTargets.length, 0);
  await db`UPDATE rooms SET status = 'ended', media_cleanup_pending = true WHERE id = ${f.roomId}::uuid`;
  const ended = await tx((db) => getWorkerContext(db, f.roomId, f.runId));
  assert.equal(ended.deleteMediaRoom, true, "room deletion is independent of remaining participant targets");
  await tx((db) => upsertWorkerLease(db, f.roomId, workerStatus(f.runId, { mediaCleanupCompleted: true })));
  assert.equal((await tx((db) => getWorkerContext(db, f.roomId, f.runId))).deleteMediaRoom, false);
});

test.after(async () => {
  if (process.env.DATABASE_URL && rooms.length) {
    const db = getDatabase();
    await db`UPDATE rooms SET active_mediation_session_id = NULL, active_mediation_node_id = NULL WHERE id = ANY(${rooms}::uuid[])`;
    await db`DELETE FROM rooms WHERE id = ANY(${rooms}::uuid[])`;
  }
  await closeDatabase();
});

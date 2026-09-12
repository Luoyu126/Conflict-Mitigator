import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase, withTransaction } from "../../lib/db/postgres.ts";
import { proposeMediation, recordEntryDecision, getMediationMe, listPrivateMessages, sendPrivateMessage, recordResumeDecision } from "../../services/mediation/index.ts";
import { ackIsolation, upsertWorkerLease, getWorkerContext, ingestTranscript, submitMeetingAnalysis } from "../../services/worker/index.ts";

const hostUserId = randomUUID();
const guest1UserId = randomUUID();
const guest2UserId = randomUUID();
let roomId = randomUUID();
let nodeId = randomUUID();
let p1 = randomUUID();
let p2 = randomUUID();
let p3 = randomUUID();
let sessionId = null;

const agent = async () => ({
  reply: "I hear you. Let's find the shared concern.",
  structured: { position: "Reduce scope", supportingReasons: [], underlyingConcerns: ["Reliability"], acceptableCompromises: ["Simplify"] },
});

test("full mediation lifecycle: propose → isolate → chat → resume", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  await db`INSERT INTO rooms (id, title, created_by) VALUES (${roomId}::uuid, 'Lifecycle', ${hostUserId}::uuid)`;
  await db`INSERT INTO participants (id, room_id, auth_user_id, display_name, role, livekit_identity, transcription_consent, structured_sharing_consent) VALUES
    (${p1}::uuid, ${roomId}::uuid, ${hostUserId}::uuid, 'Host', 'host', ${p1}::text, true, true),
    (${p2}::uuid, ${roomId}::uuid, ${guest1UserId}::uuid, 'Guest1', 'participant', ${p2}::text, true, true),
    (${p3}::uuid, ${roomId}::uuid, ${guest2UserId}::uuid, 'Guest2', 'participant', ${p3}::text, true, true)`;
  await db`INSERT INTO mind_map_nodes (id, room_id, topic, status, contention_score) VALUES (${nodeId}::uuid, ${roomId}::uuid, 'Scope', 'heated', 0.8)`;

  const proposed = await withTransaction((tx) => proposeMediation(tx, roomId, nodeId, hostUserId, [p1, p2, p3], "Demo"));
  sessionId = proposed.session.id;
  assert.equal(proposed.session.status, "proposed");
  assert.equal(proposed.session.members.find((m) => m.participantId === p1)?.entryDecision, "accept");
  assert.equal(proposed.session.members.find((m) => m.participantId === p2)?.entryDecision, "pending");

  await withTransaction((tx) => recordEntryDecision(tx, roomId, sessionId, guest1UserId, "accept"));
  const last = await withTransaction((tx) => recordEntryDecision(tx, roomId, sessionId, guest2UserId, "accept"));
  assert.equal(last.triggeredStarting, true);
  assert.equal(last.session.session.status, "starting");
  assert.equal(last.session.roomStatus, "mediation");

  const ack = await withTransaction((tx) => ackIsolation(tx, roomId, randomUUID(), { sessionId: sessionId, results: [
    { participantId: p1, revokeBeforeUnixSec: 123, succeeded: true, errorCode: null },
    { participantId: p2, revokeBeforeUnixSec: 123, succeeded: true, errorCode: null },
    { participantId: p3, revokeBeforeUnixSec: 123, succeeded: true, errorCode: null },
  ] }));
  assert.equal(ack.session.status, "active");
  assert.equal(ack.node.status, "private_mediation");

  const sent = await sendPrivateMessage(roomId, sessionId, hostUserId, randomUUID(), "I am worried the camera crashes.", agent);
  assert.equal(sent.status, 201);
  assert.equal(sent.data.consensusTreeVersion, 2);
  assert.equal(sent.data.selfState.underlyingConcerns[0], "Reliability");

  const me = await getMediationMe(roomId, sessionId, hostUserId);
  assert.equal(me.chatAllowed, true);
  assert.equal(me.consensusTree?.version, 2);

  const messages = await listPrivateMessages(roomId, sessionId, hostUserId, { limit: 10 });
  assert.equal(messages.items.length, 2);
  assert.equal(messages.items[0].role, "user");
  assert.equal(messages.items[1].role, "assistant");

  // Remaining members share so the node becomes ready_to_resume with a summary.
  await sendPrivateMessage(roomId, sessionId, guest1UserId, randomUUID(), "Reliability matters.", agent);
  await sendPrivateMessage(roomId, sessionId, guest2UserId, randomUUID(), "Keep the map stable.", agent);

  const resumed = await withTransaction((tx) => recordResumeDecision(tx, roomId, sessionId, hostUserId, "accept", 1));
  assert.equal(resumed.session.status, "active");
  await withTransaction((tx) => recordResumeDecision(tx, roomId, sessionId, guest1UserId, "accept", 1));
  const done = await withTransaction((tx) => recordResumeDecision(tx, roomId, sessionId, guest2UserId, "accept", 1));
  assert.equal(done.session.status, "completed");
  assert.equal(done.node.status, "normal");
  assert.equal(done.roomStatus, "meeting");
});

test("decline cancels the proposal and restores meeting state", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  const room2 = randomUUID();
  const node2 = randomUUID();
  const p4 = randomUUID();
  const p5 = randomUUID();
  const host2 = randomUUID();
  await db`INSERT INTO rooms (id, title, created_by) VALUES (${room2}::uuid, 'Cancel', ${host2}::uuid)`;
  await db`INSERT INTO participants (id, room_id, auth_user_id, display_name, role, livekit_identity, transcription_consent, structured_sharing_consent) VALUES
    (${p4}::uuid, ${room2}::uuid, ${host2}::uuid, 'H', 'host', ${p4}::text, true, true),
    (${p5}::uuid, ${room2}::uuid, ${randomUUID()}::uuid, 'G', 'participant', ${p5}::text, true, true)`;
  await db`INSERT INTO mind_map_nodes (id, room_id, topic, status, contention_score) VALUES (${node2}::uuid, ${room2}::uuid, 'Scope', 'heated', 0.8)`;
  const proposed = await withTransaction((tx) => proposeMediation(tx, room2, node2, host2, [p4, p5]));
  const declined = await withTransaction((tx) => recordEntryDecision(tx, room2, proposed.session.id, host2, "decline"));
  assert.equal(declined.session.session.status, "cancelled");
  assert.equal(declined.session.roomStatus, "meeting");
});

test("worker lease, context, transcript ingest and analysis auto-propose", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  const roomId2 = randomUUID();
  const runId = randomUUID();
  const pA = randomUUID();
  const pB = randomUUID();
  await db`INSERT INTO rooms (id, title, created_by) VALUES (${roomId2}::uuid, 'Worker', ${runId}::uuid)`;
  await db`INSERT INTO participants (id, room_id, auth_user_id, display_name, role, livekit_identity, transcription_consent, structured_sharing_consent) VALUES
    (${pA}::uuid, ${roomId2}::uuid, ${randomUUID()}::uuid, 'A', 'host', ${pA}::text, true, true),
    (${pB}::uuid, ${roomId2}::uuid, ${randomUUID()}::uuid, 'B', 'participant', ${pB}::text, true, true)`;

  const lease = await withTransaction((tx) => upsertWorkerLease(tx, roomId2, { runId, status: "ready", audio: "ready", video: "disabled", meetingAgent: "ready" }));
  assert.equal(lease.runId, runId);
  assert.equal(lease.observer.status, "ready");

  const context = await withTransaction((tx) => getWorkerContext(tx, roomId2, runId));
  assert.equal(context.participants.length, 2);

  const t1 = randomUUID();
  const t2 = randomUUID();
  const t3 = randomUUID();
  const base = {
    isFinal: true, revision: 1, streamId: randomUUID(), trackSid: "TR_audio", startedAtMs: null, endedAtMs: null,
    language: "en", confidence: null, receivedAt: "2026-09-12T14:00:00.000Z", timeBasis: "unknown", consentRevision: 1,
  };
  await withTransaction((tx) => ingestTranscript(tx, roomId2, { segmentId: t1, participantIdentity: pA, content: "Cut the camera.", ...base }));
  await withTransaction((tx) => ingestTranscript(tx, roomId2, { segmentId: t2, participantIdentity: pB, content: "Keep the map.", ...base }));
  await withTransaction((tx) => ingestTranscript(tx, roomId2, { segmentId: t3, participantIdentity: pA, content: "The camera crashes.", ...base }));
  const dup = await withTransaction((tx) => ingestTranscript(tx, roomId2, { segmentId: t1, participantIdentity: pA, content: "Cut the camera.", ...base }));
  assert.equal(dup.duplicate, true);

  const node2 = randomUUID();
  const analysis = await withTransaction((tx) => submitMeetingAnalysis(tx, roomId2, {
    analysisId: randomUUID(), baseMapVersion: 0, sourceTranscriptIds: [t1, t2, t3],
    nodeUpserts: [{
      id: node2, parentNodeId: null, topic: "Cut the camera?", summary: null, contentionScore: 0.82, discussionLoopCount: 2,
      participantStates: [
        { participantId: pA, position: "Cut it", supportingReasons: [], underlyingConcerns: ["Crash"], emotionIntensity: null, viewOfOthers: [], acceptableCompromises: [], evidenceTranscriptIds: [t1, t3] },
        { participantId: pB, position: "Keep the map", supportingReasons: [], underlyingConcerns: ["Clarity"], emotionIntensity: null, viewOfOthers: [], acceptableCompromises: [], evidenceTranscriptIds: [t2] },
      ],
    }],
  }));
  assert.equal(analysis.duplicate, false);
  assert.ok(analysis.mapVersion >= 1);

  const auto = await db`SELECT id FROM mediation_sessions WHERE room_id = ${roomId2}::uuid AND status = 'proposed' LIMIT 1`;
  assert.equal(auto.length, 1, "analysis should auto-propose a mediation session");
  const members = await db`SELECT count(*)::int AS count FROM mediation_members WHERE mediation_session_id = ${auto[0].id}::uuid`;
  assert.equal(members[0].count, 2, "auto proposal should freeze all active participants");
});

test.after(async () => {
  if (process.env.DATABASE_URL) {
    const db = getDatabase();
    await db`DELETE FROM rooms WHERE id IN (${roomId}::uuid) OR created_by = ${hostUserId}::uuid OR created_by = ${guest1UserId}::uuid OR created_by = ${guest2UserId}::uuid`;
  }
  await closeDatabase();
});

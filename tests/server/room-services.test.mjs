import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase, withTransaction } from "../../lib/db/postgres.ts";
import { createRoom, endRoom, getLobby, getRoomState, joinRoom, leaveRoom, updateConsents } from "../../services/rooms/index.ts";
import { listTranscripts } from "../../services/transcripts/index.ts";
import { getMindMap, getNode } from "../../services/mind-map/index.ts";
import { resolveMediation } from "../../services/mediation/index.ts";

const hostUserId = randomUUID();
const guestUserId = randomUUID();
let roomId;
let hostId;
let guestId;
let nodeId;
let sessionId;
const fakeIssuer = async ({ roomId: room, participantId }) => ({
  serverUrl: "wss://local.test/", participantToken: "local-token", roomName: `cm_${room}`,
  participantIdentity: participantId, expiresAt: new Date(Date.now() + 600_000).toISOString(),
});

test("room lifecycle creates, joins, projects state, and emits invalidations", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  const created = await withTransaction((tx) => createRoom(tx, hostUserId, "Planning"));
  roomId = created.room.id;
  assert.equal(created.room.status, "lobby");
  assert.equal(created.room.activeMediationNodeId, null);
  assert.equal(created.lobbyPath, `/rooms/${roomId}/lobby`);
  const lobby = await getLobby(roomId, guestUserId);
  assert.equal(lobby.participantCount, 0);
  assert.equal(lobby.canJoin, true);

  const host = await withTransaction((tx) => joinRoom(tx, roomId, hostUserId, {
    displayName: "Host", consents: { transcription: true, visualAffect: false, structuredSharing: true },
    consentNoticeVersion: "cm-privacy-v1",
  }, fakeIssuer));
  hostId = host.me.participant.id;
  assert.equal(host.me.participant.role, "host");
  assert.equal(host.room.status, "meeting");
  assert.equal(host.livekit.participantIdentity, hostId);

  const guest = await withTransaction((tx) => joinRoom(tx, roomId, guestUserId, {
    displayName: "Guest", consents: { transcription: true, visualAffect: false, structuredSharing: true },
    consentNoticeVersion: "cm-privacy-v1",
  }, fakeIssuer));
  guestId = guest.me.participant.id;
  assert.equal(guest.me.participant.role, "participant");
  const state = await getRoomState(roomId, hostUserId);
  assert.equal(state.participants.length, 2);
  assert.equal(state.room.observer.status, "idle");
  const events = await db`SELECT event_type, payload FROM room_events WHERE room_id = ${roomId}::uuid ORDER BY occurred_at`;
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].payload, {});
});

test("consent revisions change only on material updates", { skip: !process.env.DATABASE_URL }, async () => {
  const first = await withTransaction((tx) => updateConsents(tx, roomId, hostUserId, { transcription: true }));
  assert.equal(first.me.consentRevision, 1);
  const changed = await withTransaction((tx) => updateConsents(tx, roomId, hostUserId, { transcription: false }));
  assert.equal(changed.me.consentRevision, 2);
  assert.equal(changed.me.consents.transcription, false);
});

test("transcripts paginate oldest-to-newest with opaque cursors", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  for (let index = 0; index < 3; index += 1) {
    await db`INSERT INTO transcript_segments (room_id, participant_id, content, is_final, stream_id, source_track_sid, created_at)
      VALUES (${roomId}::uuid, ${hostId}::uuid, ${`Segment ${index}`}, true, ${randomUUID()}::uuid, ${`TR_${index}`},
        clock_timestamp() + ${index} * interval '1 second')`;
  }
  const latest = await listTranscripts(roomId, hostUserId, { limit: 2 });
  assert.deepEqual(latest.items.map((item) => item.content), ["Segment 1", "Segment 2"]);
  assert.equal(latest.pageInfo.hasMore, true);
  const older = await listTranscripts(roomId, hostUserId, { limit: 2, before: latest.pageInfo.nextBeforeCursor });
  assert.deepEqual(older.items.map((item) => item.content), ["Segment 0"]);
  assert.equal(older.pageInfo.hasMore, false);
});

test("mind map and mediation resolution preserve public/private boundaries", { skip: !process.env.DATABASE_URL }, async () => {
  const db = getDatabase();
  nodeId = randomUUID();
  sessionId = randomUUID();
  await db`INSERT INTO mind_map_nodes (id, room_id, topic, contention_score) VALUES (${nodeId}::uuid, ${roomId}::uuid, 'Scope', 0.8)`;
  await db`INSERT INTO participant_node_states (node_id, participant_id, position, supporting_reasons, underlying_concerns,
    emotion_intensity, view_of_others, acceptable_compromises)
    VALUES (${nodeId}::uuid, ${hostId}::uuid, 'Ship small', ${db.json(["Time"])}, ${db.json(["Risk"])}, 0.7,
      ${db.json([{ participantId: guestId, interpretation: "Wants polish" }])}, ${db.json(["One flow"])})`;
  await withTransaction(async (tx) => {
    await tx`INSERT INTO mediation_sessions (id, room_id, node_id, status, expires_at)
      VALUES (${sessionId}::uuid, ${roomId}::uuid, ${nodeId}::uuid, 'proposed', now() + interval '2 minutes')`;
    await tx`INSERT INTO mediation_members (mediation_session_id, participant_id) VALUES
      (${sessionId}::uuid, ${hostId}::uuid), (${sessionId}::uuid, ${guestId}::uuid)`;
    await tx`UPDATE rooms SET status = 'mediation', active_mediation_session_id = ${sessionId}::uuid,
      active_mediation_node_id = ${nodeId}::uuid WHERE id = ${roomId}::uuid`;
  });
  const map = await getMindMap(roomId, hostUserId);
  assert.equal(map.nodes[0].id, nodeId);
  assert.equal("emotionIntensity" in map.participantStates[0], false);
  assert.equal("viewOfOthers" in map.participantStates[0], false);
  const detail = await getNode(roomId, nodeId, hostUserId);
  assert.equal(detail.selfState.emotionIntensity, 0.7);
  assert.equal(detail.activeMediationSessionId, sessionId);
  const resolution = await resolveMediation(roomId, nodeId, guestUserId);
  assert.equal(resolution.session.id, sessionId);
  assert.equal(resolution.session.members.length, 2);
  assert.equal(resolution.isMember, true);
  const room = await getRoomState(roomId, hostUserId);
  assert.equal(room.room.activeMediationNodeId, nodeId);
});

test("leaving and host end create truthful pending media cleanup state", { skip: !process.env.DATABASE_URL }, async () => {
  const guestExit = await withTransaction((tx) => leaveRoom(tx, roomId, guestUserId));
  assert.equal(guestExit.participantStatus, "left");
  assert.equal(guestExit.mediaCleanup, "pending");
  const ended = await withTransaction((tx) => endRoom(tx, roomId, hostUserId));
  assert.equal(ended.roomStatus, "ended");
  const state = await getRoomState(roomId, hostUserId);
  assert.equal(state.participants.every((participant) => participant.status === "left"), true);
});

test.after(async () => {
  if (roomId && process.env.DATABASE_URL) await getDatabase()`DELETE FROM rooms WHERE id = ${roomId}::uuid`;
  await closeDatabase();
});

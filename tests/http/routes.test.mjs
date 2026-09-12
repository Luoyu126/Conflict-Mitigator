import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHttpHarness } from "./harness.mjs";

const consents = { transcription: true, visualAffect: true, voiceAffect: true, structuredSharing: true };
function ok(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.payload.requestId, /^[0-9a-f-]{36}$/i);
  assert.ok(Object.hasOwn(response.payload, "data"));
  return response.payload.data;
}
function denied(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.payload.error.code, code);
  assert.equal(Object.hasOwn(response.payload, "data"), false);
}

test.describe("real HTTP route integration with local auth", { timeout: 180_000 }, () => {
  let h;
  test.before(async () => { h = await createHttpHarness(); });
  test.after(async () => { await h?.cleanup(); });
  async function room() {
    const created = ok(await h.request("/api/rooms", { method: "POST", as: "owner", body: { title: "HTTP migration fixture" }, idempotencyKey: randomUUID() }), 201);
    h.roomIds.push(created.room.id);
    return created.room.id;
  }
  async function join(roomId, as = "owner", idempotencyKey = randomUUID()) {
    const body = { displayName: as, consents, consentNoticeVersion: "cm-privacy-v1" };
    const response = await h.request(`/api/rooms/${roomId}/join`, { method: "POST", as, body, idempotencyKey });
    return { ...ok(response), requestBody: body, idempotencyKey };
  }

  test("missing and invalid browser credentials are rejected by actual route auth", async () => {
    denied(await h.request("/api/rooms", { method: "POST", body: { title: "Unauthorized" }, idempotencyKey: randomUUID() }), 401, "UNAUTHENTICATED");
    denied(await h.request("/api/rooms", { method: "POST", token: "invalid-test-bearer", body: { title: "Unauthorized" }, idempotencyKey: randomUUID() }), 401, "UNAUTHENTICATED");
  });

  test("create retries are idempotent and conflicting bodies cannot reuse a key", async () => {
    const idempotencyKey = randomUUID();
    const command = { method: "POST", as: "owner", body: { title: "Idempotent HTTP room" }, idempotencyKey };
    const first = ok(await h.request("/api/rooms", command), 201);
    h.roomIds.push(first.room.id);
    const repeat = await h.request("/api/rooms", command);
    assert.equal(ok(repeat, 201).room.id, first.room.id);
    assert.equal(repeat.headers.get("idempotency-replayed"), "true");
    denied(await h.request("/api/rooms", { ...command, body: { title: "Different title" } }), 409, "IDEMPOTENCY_CONFLICT");
    const rows = await h.db`SELECT count(*)::int AS n FROM rooms WHERE id=${first.room.id}::uuid`;
    assert.equal(rows[0].n, 1);
  });

  test("authenticated lobby, join, room, consent and leave follow the real API contract", async () => {
    const roomId = await room();
    const lobby = ok(await h.request(`/api/rooms/${roomId}/lobby`, { as: "guest" }));
    assert.equal(lobby.status, "lobby"); assert.equal(lobby.canJoin, true);
    assert.equal(lobby.participantCount, 0);
    const owner = await join(roomId);
    const guest = await join(roomId, "guest");
    assert.equal(owner.room.status, "meeting");
    assert.equal(owner.me.participant.role, "host");
    assert.equal(guest.me.participant.role, "participant");
    assert.equal(owner.livekit.participantIdentity, owner.me.participant.id);
    const claims = JSON.parse(Buffer.from(owner.livekit.participantToken.split(".")[1], "base64url"));
    assert.equal(claims.sub, owner.me.participant.id);
    assert.equal(claims.video.room, `cm_${roomId}`);
    assert.equal(claims.video.roomAdmin, undefined);
    const state = ok(await h.request(`/api/rooms/${roomId}`, { as: "guest" }));
    assert.equal(state.participants.length, 2);
    assert.equal(state.me.participant.id, guest.me.participant.id);
    assert.equal(JSON.stringify(state.participants).includes("consents"), false);
    const updated = ok(await h.request(`/api/rooms/${roomId}/me/consents`, { method: "PATCH", as: "owner", body: { voiceAffect: false }, idempotencyKey: randomUUID() }));
    assert.equal(updated.me.consentRevision, 2);
    assert.equal(updated.me.consents.voiceAffect, false);
    assert.equal(updated.me.consents.visualAffect, true);
    const left = ok(await h.request(`/api/rooms/${roomId}/leave`, { method: "POST", as: "owner", body: {}, idempotencyKey: randomUUID() }), 202);
    assert.equal(left.participantStatus, "left"); assert.equal(left.mediaCleanup, "pending");
    const rejoin = await h.request(`/api/rooms/${roomId}/join`, { method: "POST", as: "owner", body: owner.requestBody, idempotencyKey: owner.idempotencyKey });
    denied(rejoin, 403, "FORBIDDEN");
    assert.ok(h.authRequests > 0, "Supabase auth HTTP was actually exercised");
  });

  test("outsiders cannot read room data or another participant's private messages", async () => {
    const roomId = await room();
    const owner = await join(roomId);
    const guest = await join(roomId, "guest");
    denied(await h.request(`/api/rooms/${roomId}`, { as: "outsider" }), 403, "FORBIDDEN");
    const nodeId = randomUUID(), sessionId = randomUUID();
    await h.db`INSERT INTO mind_map_nodes (id,room_id,topic,status) VALUES (${nodeId}::uuid,${roomId}::uuid,'Private HTTP fixture','private_mediation')`;
    await h.db`INSERT INTO mediation_sessions (id,room_id,node_id,status) VALUES (${sessionId}::uuid,${roomId}::uuid,${nodeId}::uuid,'active')`;
    for (const person of [owner, guest]) await h.db`INSERT INTO mediation_members (mediation_session_id,participant_id,entry_decision)
      VALUES (${sessionId}::uuid,${person.me.participant.id}::uuid,'accept')`;
    await h.db`INSERT INTO private_messages (mediation_session_id,participant_id,role,content,client_message_id)
      VALUES (${sessionId}::uuid,${owner.me.participant.id}::uuid,'user','Synthetic owner-only message',${randomUUID()}::uuid)`;
    const route = `/api/rooms/${roomId}/mediations/${sessionId}/me/messages`;
    const mine = ok(await h.request(route, { as: "owner" }));
    assert.equal(mine.items[0].content, "Synthetic owner-only message");
    const theirs = ok(await h.request(`${route}?participantId=${owner.me.participant.id}`, { as: "guest" }));
    assert.deepEqual(theirs.items, []);
    denied(await h.request(route, { as: "outsider" }), 403, "FORBIDDEN");
  });

  test("internal HTTP endpoints require service auth and the current Worker lease", async () => {
    const roomId = await room();
    const route = `/api/internal/rooms/${roomId}/context`;
    denied(await h.request(route), 401, "UNAUTHENTICATED");
    denied(await h.request(route, { as: "owner", runId: randomUUID() }), 401, "UNAUTHENTICATED");
    denied(await h.request(route, { token: h.workerToken, runId: randomUUID() }), 409, "WORKER_LEASE_CONFLICT");
    denied(await h.request("/internal/v1/affect/frames", { method: "POST", body: {} }), 401, "UNAUTHENTICATED");
  });

  test("HTTP affect ingestion is owner-only and rejects late results after withdrawal", async () => {
    const roomId = await room();
    const owner = await join(roomId);
    await join(roomId, "guest");
    const runId = randomUUID();
    const worker = { token: h.workerToken, runId };
    const lease = () => h.request(`/api/internal/rooms/${roomId}/worker-status`, { method: "POST", token: h.workerToken,
      body: { runId, status: "ready", audio: "ready", video: "ready", meetingAgent: "disabled" } });
    ok(await lease());
    ok(await h.request(`/api/internal/rooms/${roomId}/context`, worker));
    const observationId = randomUUID();
    const observation = { source: "voice", metadata: {
      observationId, roomId, participantIdentity: owner.me.participant.id, trackSid: "TR_http_microphone", streamId: randomUUID(),
      sampledAtMs: Math.max(0, Date.now() - Date.parse(owner.room.mediaEpochAt)), consentRevision: owner.me.consentRevision,
    }, result: { observationId, status: "ok", intensity: null, confidence: null, reason: null,
      model: { provider: "HTTP fake", name: "Synthetic voice model", version: null }, inferenceMs: null,
      scores: [{ name: "Joy", score: .7 }], vad: null } };
    const ingestRoute = `/api/internal/rooms/${roomId}/affect-observations`;
    ok(await h.request(ingestRoute, { ...worker, method: "POST", body: observation }), 201);
    assert.equal(ok(await h.request(ingestRoute, { ...worker, method: "POST", body: observation })).duplicate, true);
    const mine = ok(await h.request(`/api/rooms/${roomId}/me/affect`, { as: "owner" }));
    assert.equal(mine.observations[0].id, observationId);
    assert.deepEqual(ok(await h.request(`/api/rooms/${roomId}/me/affect`, { as: "guest" })).observations, []);
    denied(await h.request(`/api/rooms/${roomId}/me/affect`, { as: "outsider" }), 403, "FORBIDDEN");
    ok(await h.request(`/api/rooms/${roomId}/me/consents`, { as: "owner", method: "PATCH", body: { voiceAffect: false }, idempotencyKey: randomUUID() }));
    assert.deepEqual(ok(await h.request(`/api/rooms/${roomId}/me/affect`, { as: "owner" })).observations, []);
    ok(await lease());
    denied(await h.request(ingestRoute, { ...worker, method: "POST", body: observation }), 409, "CONSENT_REVOKED");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDatabase, withTransaction, closeDatabase } from "../../lib/db/postgres.ts";
import { proposeMediation, recordEntryDecision, cancelMediation, sendPrivateMessage, listPrivateMessages, getMediationMe, recordResumeDecision } from "../../services/mediation/index.ts";
import { validatePrivateOutput } from "../../lib/agents/mediation-agent.ts";
import { synthesizeConsensusTree } from "../../lib/agents/consensus.ts";

const database = { skip: !process.env.DATABASE_URL };
const roomIds = [];
const output = (readyToResume = false) => ({ reply: "Let's consider your priorities.", readyToResume,
  structured: { position: "A smaller scope", supportingReasons: [], underlyingConcerns: ["Reliability"], acceptableCompromises: [] },
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(status = "active") {
  const db = getDatabase();
  const roomId = randomUUID(), nodeId = randomUUID(), sessionId = randomUUID();
  const users = [randomUUID(), randomUUID()], participants = [randomUUID(), randomUUID()];
  roomIds.push(roomId);
  await withTransaction(async tx => {
    await tx`INSERT INTO rooms (id,title,created_by,status) VALUES (${roomId},'Security fixture',${users[0]},${status === 'proposed' ? 'meeting' : 'mediation'})`;
    for (let i = 0; i < 2; i++) await tx`INSERT INTO participants (id,room_id,auth_user_id,display_name,role,livekit_identity,transcription_consent,structured_sharing_consent)
      VALUES (${participants[i]},${roomId},${users[i]},${`Person ${i}`},${i ? 'participant' : 'host'},${participants[i]},true,true)`;
    await tx`INSERT INTO mind_map_nodes (id,room_id,topic,status) VALUES (${nodeId},${roomId},'Scope',${status === 'proposed' ? 'heated' : 'private_mediation'})`;
    await tx`INSERT INTO mediation_sessions (id,room_id,node_id,status,expires_at) VALUES (${sessionId},${roomId},${nodeId},${status},clock_timestamp()+interval '120 seconds')`;
    for (const participant of participants) await tx`INSERT INTO mediation_members (mediation_session_id,participant_id) VALUES (${sessionId},${participant})`;
    await tx`UPDATE rooms SET active_mediation_session_id=${sessionId},active_mediation_node_id=${nodeId} WHERE id=${roomId}`;
  });
  return { db, roomId, nodeId, sessionId, users, participants };
}

test("schema validation rejects private text copied into shared output and extra fields", () => {
  const input = { nodeTopic: "Scope", selfState: null, others: [], history: [], userMessage: "My confidential concern is the exact private sentence." };
  const copied = output(); copied.structured.position = input.userMessage;
  assert.throws(() => validatePrivateOutput(copied, input), /privacy/);
  const extra = output(); extra.structured.emotion = 0.9;
  assert.throws(() => validatePrivateOutput(extra, input), /validation/);
  assert.equal(validatePrivateOutput(output(), input).readyToResume, false);
});

test("consensus retains IDs and labels deductions honestly across versions", () => {
  const node = { id: randomUUID(), topic: "Scope" };
  const states = [0, 1].map(i => ({ participantId: `p${i}`, position: "Reduce scope", underlyingConcerns: ["Reliability", "Reliability"] }));
  const first = synthesizeConsensusTree(node, states, 1, "one");
  const second = synthesizeConsensusTree(node, states, 2, "two");
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.edges, second.edges);
  assert.equal(first.nodes.find(n => n.kind === "inferred_common_ground").epistemicStatus, "llm_inferred");
  const onlyOne = synthesizeConsensusTree(node, [states[0]], 1, "one");
  assert.equal(onlyOne.nodes.some(n => n.kind === "inferred_common_ground"), false);
});

test("proposal publishes discoverable room pointers and nonmember host can cancel", database, async () => {
  const f = await fixture("proposed");
  await f.db`UPDATE rooms SET active_mediation_session_id=NULL,active_mediation_node_id=NULL WHERE id=${f.roomId}`;
  await f.db`DELETE FROM mediation_sessions WHERE id=${f.sessionId}`;
  const proposed = await withTransaction(tx => proposeMediation(tx, f.roomId, f.nodeId, f.users[0], f.participants));
  const room = (await f.db`SELECT active_mediation_session_id,active_mediation_node_id FROM rooms WHERE id=${f.roomId}`)[0];
  assert.equal(room.active_mediation_session_id, proposed.session.id);
  assert.equal(room.active_mediation_node_id, f.nodeId);
  await f.db`DELETE FROM mediation_members WHERE mediation_session_id=${proposed.session.id} AND participant_id=${f.participants[0]}`;
  const cancelled = await withTransaction(tx => cancelMediation(tx, f.roomId, proposed.session.id, f.users[0]));
  assert.equal(cancelled.session.status, "cancelled");
});

test("concurrent entry decisions advance exactly once with fixed cutoff", database, async () => {
  const f = await fixture("proposed");
  const results = await Promise.all(f.users.map(user => withTransaction(tx => recordEntryDecision(tx, f.roomId, f.sessionId, user, "accept"))));
  assert.equal(results.filter(r => r.triggeredStarting).length, 1);
  const rows = await f.db`SELECT isolation_cutoff_unix_sec FROM mediation_members WHERE mediation_session_id=${f.sessionId}`;
  assert.ok(rows[0].isolation_cutoff_unix_sec);
  assert.equal(String(rows[0].isolation_cutoff_unix_sec), String(rows[1].isolation_cutoff_unix_sec));
});

test("expired proposal cancellation commits instead of rolling back an error", database, async () => {
  const f = await fixture("proposed");
  await f.db`UPDATE mediation_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.sessionId}`;
  const result = await withTransaction(tx => recordEntryDecision(tx, f.roomId, f.sessionId, f.users[0], "accept"));
  assert.equal(result.expired, true);
  assert.equal((await f.db`SELECT status FROM mediation_sessions WHERE id=${f.sessionId}`)[0].status, "cancelled");
  assert.equal((await f.db`SELECT active_mediation_session_id FROM rooms WHERE id=${f.roomId}`)[0].active_mediation_session_id, null);
});

test("pending chat replays without another model and atomically saves one owner-only reply", database, async () => {
  const f = await fixture(); const started = deferred(), generation = deferred(); let calls = 0;
  const clientId = randomUUID();
  const agent = async input => { calls++; assert.equal(input.history.length, 0); started.resolve(); return generation.promise; };
  const first = sendPrivateMessage(f.roomId, f.sessionId, f.users[0], clientId, "I want to reduce scope.", agent);
  await started.promise;
  const duplicate = await sendPrivateMessage(f.roomId, f.sessionId, f.users[0], clientId, "I want to reduce scope.", agent);
  assert.equal(duplicate.status, 202); assert.equal(calls, 1);
  generation.resolve(output()); const done = await first;
  assert.equal(done.status, 201); assert.equal(done.data.assistantMessage.replyStatus, null);
  assert.equal((await sendPrivateMessage(f.roomId, f.sessionId, f.users[0], clientId, "I want to reduce scope.", agent)).status, 200);
  await assert.rejects(sendPrivateMessage(f.roomId, f.sessionId, f.users[0], clientId, "Changed content", agent), e => e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await listPrivateMessages(f.roomId, f.sessionId, f.users[1], { limit: 20 })).items.length, 0);
  assert.equal(calls, 1);
});

test("cancellation while model runs prevents late private and shared persistence", database, async () => {
  const f = await fixture(); const started = deferred(), generation = deferred();
  const pending = sendPrivateMessage(f.roomId, f.sessionId, f.users[0], randomUUID(), "I am concerned about delivery.", async () => { started.resolve(); return generation.promise; });
  const rejected = assert.rejects(pending, e => e.code === "SESSION_NOT_ACTIVE");
  await started.promise;
  await withTransaction(tx => cancelMediation(tx, f.roomId, f.sessionId, f.users[0]));
  generation.resolve(output(true)); await rejected;
  assert.equal((await f.db`SELECT id FROM private_messages WHERE mediation_session_id=${f.sessionId} AND role='assistant'`).length, 0);
  assert.equal((await f.db`SELECT id FROM participant_node_states WHERE node_id=${f.nodeId}`).length, 0);
});

test("consent revision fences in-flight extraction and timeout aborts supplier", database, async () => {
  const f = await fixture(); const started = deferred(), generation = deferred();
  const pending = sendPrivateMessage(f.roomId, f.sessionId, f.users[0], randomUUID(), "I am concerned about quality.", async () => { started.resolve(); return generation.promise; });
  const rejected = assert.rejects(pending, e => e.code === "SESSION_STATE_CONFLICT");
  await started.promise;
  await f.db`UPDATE participants SET consent_revision=consent_revision+1 WHERE id=${f.participants[0]}`;
  generation.resolve(output()); await rejected;
  let signal;
  await assert.rejects(sendPrivateMessage(f.roomId, f.sessionId, f.users[0], randomUUID(), "Please help clarify priorities.", async (_input, given) => {
    signal = given; return new Promise((_, reject) => given.addEventListener("abort", () => reject(given.reason), { once: true }));
  }, { timeoutMs: 20 }), e => e.code === "MODEL_TIMEOUT");
  assert.equal(signal.aborted, true);
});

test("expired messages are excluded from owner API and subsequent model history", database, async () => {
  const f = await fixture();
  await f.db`INSERT INTO private_messages (mediation_session_id,participant_id,role,content,client_message_id,reply_status,created_at,expires_at)
    VALUES (${f.sessionId},${f.participants[0]},'user','Expired secret',${randomUUID()},'failed',now()-interval '25 hours',now()-interval '1 hour')`;
  assert.equal((await listPrivateMessages(f.roomId, f.sessionId, f.users[0], { limit: 20 })).items.length, 0);
  await sendPrivateMessage(f.roomId, f.sessionId, f.users[0], randomUUID(), "Discuss scope", async input => { assert.equal(input.history.length, 0); return output(); });
});

test("concurrent owner extractions preserve both states and monotonic tree versions", database, async () => {
  const f = await fixture();
  const barrier = deferred(); let entered = 0;
  const agent = async () => { if (++entered === 2) barrier.resolve(); await barrier.promise; return output(true); };
  const results = await Promise.all(f.users.map(user => sendPrivateMessage(f.roomId, f.sessionId, user, randomUUID(), "I would like to continue the meeting.", agent)));
  assert.deepEqual(results.map(r => r.data.consensusTreeVersion).sort(), [1, 2]);
  assert.equal((await f.db`SELECT id FROM participant_node_states WHERE node_id=${f.nodeId}`).length, 2);
  assert.equal((await getMediationMe(f.roomId, f.sessionId, f.users[0])).canAcceptResume, true);
});

test("all members assessed readiness and fresh unanimous votes are required", database, async () => {
  const f = await fixture();
  await sendPrivateMessage(f.roomId, f.sessionId, f.users[0], randomUUID(), "I would like to return now.", async () => output(true));
  assert.equal((await getMediationMe(f.roomId, f.sessionId, f.users[0])).canAcceptResume, false);
  await sendPrivateMessage(f.roomId, f.sessionId, f.users[1], randomUUID(), "I am also ready to return.", async () => output(true));
  let me = await getMediationMe(f.roomId, f.sessionId, f.users[0]); assert.equal(me.canAcceptResume, true);
  const oldVersion = me.session.summaryVersion;
  await withTransaction(tx => recordResumeDecision(tx, f.roomId, f.sessionId, f.users[0], "accept", oldVersion));
  await sendPrivateMessage(f.roomId, f.sessionId, f.users[1], randomUUID(), "One clarification before returning.", async () => output(true));
  me = await getMediationMe(f.roomId, f.sessionId, f.users[0]);
  assert.ok(me.session.summaryVersion > oldVersion);
  assert.equal(me.session.members.every(m => m.resumeDecision === "pending"), true);
  await assert.rejects(withTransaction(tx => recordResumeDecision(tx, f.roomId, f.sessionId, f.users[0], "accept", oldVersion)), e => e.code === "SUMMARY_VERSION_CONFLICT");
  await Promise.all(f.users.map(user => withTransaction(tx => recordResumeDecision(tx, f.roomId, f.sessionId, user, "accept", me.session.summaryVersion))));
  assert.equal((await f.db`SELECT status FROM mediation_sessions WHERE id=${f.sessionId}`)[0].status, "completed");
});

test.after(async () => {
  if (roomIds.length) for (const roomId of roomIds) await getDatabase()`DELETE FROM rooms WHERE id=${roomId}`;
  await closeDatabase();
});

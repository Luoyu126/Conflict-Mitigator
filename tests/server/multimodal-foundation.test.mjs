import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDatabase, withTransaction, closeDatabase } from "../../lib/db/postgres.ts";
import { createRoom, joinRoom, leaveRoom, renewLiveKitToken, updateConsents, getRoomState } from "../../services/rooms/index.ts";
import { ingestAffect, getMyAffect } from "../../services/affect/index.ts";

const issuer = async ({ roomId, participantId }) => ({ serverUrl:"wss://unit.test", participantToken:"test",
  roomName:`cm_${roomId}`, participantIdentity:participantId, expiresAt:new Date(Date.now()+600000).toISOString() });
const rooms=[];
async function setup() {
  const owner=randomUUID(),guest=randomUUID();
  const created=await withTransaction(tx=>createRoom(tx,owner,"Multimodal test")); const roomId=created.room.id;rooms.push(roomId);
  const join=user=>withTransaction(tx=>joinRoom(tx,roomId,user,{displayName:"Test",consents:{transcription:true,visualAffect:true,voiceAffect:true,structuredSharing:true},consentNoticeVersion:"cm-privacy-v1"},issuer));
  const me=await join(owner);const other=await join(guest);return {owner,guest,roomId,me,other};
}
function observation(f) {
  const id=randomUUID();
  return { source:"voice",metadata:{observationId:id,roomId:f.roomId,participantIdentity:f.me.me.participant.id,
    trackSid:"TR_test",streamId:randomUUID(),sampledAtMs:0,consentRevision:1},
    result:{observationId:id,status:"ok",intensity:null,confidence:null,reason:null,
      model:{provider:"unit",name:"unit",version:null},inferenceMs:1,scores:[{name:"Joy",score:.8}],vad:null}};
}
test("owner-only emotion reads reject outsiders, hide other participants, and discard revoked/future observations",{skip:!process.env.DATABASE_URL},async()=>{
  const f=await setup();const body=observation(f);
  await withTransaction(tx=>ingestAffect(tx,f.roomId,body));
  assert.equal((await getMyAffect(f.roomId,f.owner)).observations.length,1);
  assert.deepEqual((await getMyAffect(f.roomId,f.guest)).observations,[]);
  await assert.rejects(getMyAffect(f.roomId,randomUUID()),e=>e.code==="FORBIDDEN");
  const publicRoom=JSON.stringify(await getRoomState(f.roomId,f.guest));
  assert.ok(!publicRoom.includes('"Joy"'));assert.ok(!publicRoom.includes('"scores"'));
  const replay=await withTransaction(tx=>ingestAffect(tx,f.roomId,body));assert.equal(replay.duplicate,true);
  const changed=structuredClone(body);changed.result.scores[0].score=.2;
  await assert.rejects(withTransaction(tx=>ingestAffect(tx,f.roomId,changed)),e=>e.code==="IDEMPOTENCY_CONFLICT");
  const future=observation(f);future.metadata.consentRevision=2;
  await assert.rejects(withTransaction(tx=>ingestAffect(tx,f.roomId,future)),e=>e.code==="CONSENT_REVOKED");
  await withTransaction(tx=>updateConsents(tx,f.roomId,f.owner,{voiceAffect:false}));
  assert.deepEqual((await getMyAffect(f.roomId,f.owner)).observations,[]);
  await assert.rejects(withTransaction(tx=>ingestAffect(tx,f.roomId,body)),e=>e.code==="CONSENT_REVOKED");
});
test("concurrent consent patches preserve independent purposes and room leave fences tokens",{skip:!process.env.DATABASE_URL},async()=>{
  const f=await setup();
  await Promise.all([
    withTransaction(tx=>updateConsents(tx,f.roomId,f.owner,{voiceAffect:false})),
    withTransaction(tx=>updateConsents(tx,f.roomId,f.owner,{visualAffect:false})),
  ]);
  const me=(await getRoomState(f.roomId,f.owner)).me;
  assert.equal(me.consentRevision,3);assert.equal(me.consents.voiceAffect,false);assert.equal(me.consents.visualAffect,false);
  assert.equal(me.consents.transcription,true);
  await withTransaction(tx=>leaveRoom(tx,f.roomId,f.owner));
  await assert.rejects(renewLiveKitToken(f.roomId,f.owner,issuer),e=>e.code==="FORBIDDEN");
  await assert.rejects(withTransaction(tx=>joinRoom(tx,f.roomId,f.owner,{displayName:"Test",consents:me.consents,consentNoticeVersion:"cm-privacy-v1"},issuer)),e=>e.code==="TOKEN_NOT_YET_VALID");
});
test("emotion IDs cannot cross rooms and expired observations are not returned",{skip:!process.env.DATABASE_URL},async()=>{
  const a=await setup(),b=await setup();const one=observation(a);await withTransaction(tx=>ingestAffect(tx,a.roomId,one));
  const other=observation(b);other.metadata.observationId=one.metadata.observationId;other.result.observationId=one.result.observationId;
  await assert.rejects(withTransaction(tx=>ingestAffect(tx,b.roomId,other)),e=>e.code==="IDEMPOTENCY_CONFLICT");
  await getDatabase()`UPDATE affect_observations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${one.metadata.observationId}::uuid`;
  assert.deepEqual((await getMyAffect(a.roomId,a.owner)).observations,[]);
});
test.after(async()=>{if(process.env.DATABASE_URL){for(const id of rooms) await getDatabase()`DELETE FROM rooms WHERE id=${id}::uuid`;}await closeDatabase();});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RoomWorker, LatestOnly } from "../../worker/room-worker.ts";
import { WorkerHttpError, createWorkerTransport } from "../../worker/http.ts";
import { runSupervisor } from "../../worker/supervisor.ts";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check, description = "condition") { for (let i=0; i<100; i++) { if (check()) return; await delay(5); } throw new Error(`Timed out waiting for ${description}`); }
function fixture() {
  const roomId=randomUUID(), runId=randomUUID(), identity=randomUUID();
  const context={ room: { id:roomId,status:"meeting",mediaEpochAt:new Date(Date.now()-10000).toISOString() },mapVersion:0,
    participants:[{id:identity,livekitIdentity:identity,transcriptionConsent:true,visualAffectConsent:false,voiceAffectConsent:false,
      structuredSharingConsent:true,consentRevision:1,mediaIsolated:false}],nodes:[],participantStates:[],pendingTranscripts:[],
    pendingIsolations:[],mediaCleanupTargets:[],deleteMediaRoom:false };
  const posts=[], statuses=[], removes=[], audio=[], video=[], subscriptions=[];
  let change=()=>{}, data=()=>{}, connected=false;
  const pub={identity,sid:"TR_microphone",source:"microphone",muted:false,subscribed:false,subscribe(value){this.subscribed=value;subscriptions.push(value);queueMicrotask(change);} };
  const pubs=[pub];
  const media={ isConnected:()=>connected, connect:async()=>{connected=true;},close:async()=>{connected=false;},publications:()=>pubs,
    onChange:cb=>{change=cb;},onData:cb=>{data=cb;},
    audio:async(p,signal,onFrame)=>{audio.push({p,signal,onFrame});await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener("abort",r,{once:true});});},
    video:async(p,signal,onFrame)=>{video.push({p,signal,onFrame});await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener("abort",r,{once:true});});},
  };
  const transport={status:async body=>{statuses.push(structuredClone(body));return {leaseExpiresAt:new Date(Date.now()+30000).toISOString()};},
    context:async()=>structuredClone(context),post:async(path,body)=>{posts.push({path,body:structuredClone(body)});},infer:async metadata=>({observationId:metadata.observationId,status:"unavailable"})};
  const admin={remove:async(identity,cutoff)=>{removes.push({identity,cutoff});},deleteRoom:async()=>{removes.push({delete:true});}};
  const packet=()=>({segmentId:randomUUID(),streamId:randomUUID(),revision:1,content:"A real final segment",startedAtMs:null,endedAtMs:null,
    language:"en-US",confidence:null,consentRevision:1,recognizedAt:new Date().toISOString()});
  return { roomId,runId,identity,context,posts,statuses,removes,audio,video,subscriptions,pub,pubs,media,transport,admin,packet,
    send:(value,who=identity,reliable=true,topic="cm.transcript.final.v1")=>data(new TextEncoder().encode(JSON.stringify(value)),who,reliable,topic),
    change:()=>change(), options:{roomId,runId,media,transport,admin,timings:{controlMs:10000,heartbeatMs:10000,staleMs:1000,watchMs:10,cameraMs:1}} };
}
async function start(t,f,extra={}) { const worker=new RoomWorker({...f.options,...extra}); const run=worker.run(); t.after(async()=>{await worker.stop();await run;}); await until(()=>f.statuses.length&&f.media.isConnected()); return worker; }

test("transcript sender, topic, final revision, permission and actual microphone publication are enforced",async t=>{
  const f=fixture();await start(t,f);
  f.send(f.packet(),randomUUID());f.send(f.packet(),f.identity,false);f.send(f.packet(),f.identity,true,"wrong");
  f.send({...f.packet(),consentRevision:2});f.send({...f.packet(),content:"x".repeat(40000)});
  f.send(f.packet());await until(()=>f.posts.length===1);
  assert.equal(f.posts[0].path,"transcripts");assert.equal(f.posts[0].body.participantIdentity,f.identity);assert.equal(f.posts[0].body.trackSid,"TR_microphone");
  assert.equal(f.audio.length,0,"transcription alone must not send microphone PCM to a supplier");
  f.pub.muted=true;f.send(f.packet());await delay(20);assert.equal(f.posts.length,1);
});

test("transcript retries preserve receivedAt and queue stays bounded",async t=>{
  const f=fixture();let attempts=0;const release=deferred();
  f.transport.post=async(path,body)=>{f.posts.push({path,body:structuredClone(body)});if(attempts++===0){await release.promise;throw new WorkerHttpError(503);}};
  await start(t,f);const packet=f.packet();f.send(packet);await until(()=>attempts===1);
  for(let i=0;i<100;i++)f.send(f.packet());release.resolve();await until(()=>attempts>=2);
  assert.equal(f.posts[0].body.receivedAt,f.posts[1].body.receivedAt);
  await delay(50);assert.ok(f.posts.length<=34);
});

test("fresh consent starts one existing-track voice stream and withdrawal aborts it",async t=>{
  const f=fixture();f.context.participants[0].voiceAffectConsent=true;let voiceOptions;let writes=0;
  const worker=await start(t,f,{voice:opts=>{voiceOptions=opts;return{write(){writes++;return true;},close(){}};}});
  await until(()=>f.audio.length===1);f.audio[0].onFrame(new Int16Array([1,2]));assert.equal(writes,1);
  voiceOptions.onResult({status:"unavailable",reason:"model_unavailable",intensity:null,confidence:null,inferenceMs:null,scores:[],vad:null,model:{provider:"Hume",name:"EVI",version:null}});
  await until(()=>f.posts.some(p=>p.path==="affect-observations"));
  assert.ok(f.posts.at(-1).body.metadata.sampledAtMs>=10000);
  f.context.participants[0].voiceAffectConsent=false;f.context.participants[0].consentRevision=2;await worker.control();
  assert.equal(f.audio[0].signal.aborted,true);assert.equal(f.pub.subscribed,false);
  voiceOptions.onResult({status:"unavailable"});await delay(20);assert.equal(f.posts.length,1);
});

test("voice provider loss publishes unavailable before closing its audio reader",async t=>{
  const f=fixture();f.context.participants[0].voiceAffectConsent=true;let opts;
  await start(t,f,{voice:options=>{opts=options;return{write:()=>true,close(){}};}});
  await until(()=>f.audio.length===1);f.audio[0].onFrame(new Int16Array([0]));
  opts.onResult({status:"unavailable",reason:"model_unavailable",intensity:null,confidence:null,inferenceMs:null,scores:[],vad:null,model:{provider:"Hume",name:"EVI",version:null}});
  opts.onError(new Error("provider disconnected"));
  await until(()=>f.posts.length===1);assert.equal(f.posts[0].body.result.status,"unavailable");assert.equal(f.audio[0].signal.aborted,true);
});

test("context staleness pauses analysis even while the control request is stuck",async t=>{
  const f=fixture();f.context.participants[0].voiceAffectConsent=true;
  await start(t,f,{timings:{...f.options.timings,staleMs:35},voice:()=>({write:()=>true,close(){}})});
  await until(()=>f.audio.length===1);await until(()=>f.audio[0].signal.aborted,"stale stream abort");assert.equal(f.pub.subscribed,false);
});

test("one camera inference runs while only the latest new frame is kept",async t=>{
  const f=fixture();f.pub.source="camera";f.pub.sid="TR_camera";f.context.participants[0].visualAffectConsent=true;
  const release=deferred(), encoded=[];let inferences=0;
  f.transport.infer=async metadata=>{inferences++;if(inferences===1)await release.promise;return{observationId:metadata.observationId,status:"unavailable"};};
  await start(t,f);await until(()=>f.video.length===1);
  const frame=n=>({timestampUs:String(n*1000),receivedAt:Date.now(),encode:async()=>{encoded.push(n);return{jpeg:new Uint8Array([1]),width:10,height:10};}});
  f.video[0].onFrame(frame(1));await until(()=>inferences===1);
  for(let i=2;i<=100;i++)f.video[0].onFrame(frame(i));release.resolve();await until(()=>inferences===2);
  assert.deepEqual(encoded,[1,100]);assert.equal(f.posts.filter(p=>p.path==="affect-observations").length,2);
});

test("cleanup acknowledges only its issued snapshot and shares successful isolation removal",async t=>{
  const f=fixture();f.context.room.status="mediation";
  const target={participantId:f.identity,livekitIdentity:f.identity,revokeBeforeUnixSec:123};
  f.context.pendingIsolations=[{sessionId:randomUUID(),targets:[target]}];f.context.mediaCleanupTargets=[target];
  await start(t,f);
  assert.equal(f.removes.length,1);assert.equal(f.posts[0].path,"mediation-isolation");
  assert.equal(f.statuses.filter(s=>s.mediaCleanupCompleted===true).length,1);
  assert.equal(f.statuses[0].mediaCleanupCompleted,undefined);
});

test("failed cleanup stays pending and lease heartbeats continue during slow removals",async t=>{
  const f=fixture();f.context.room.status="mediation";f.context.mediaCleanupTargets=[{participantId:f.identity,livekitIdentity:f.identity,revokeBeforeUnixSec:123}];
  const release=deferred();f.admin.remove=async()=>{await release.promise;throw new Error("service failed");};
  const worker=new RoomWorker({...f.options,timings:{...f.options.timings,heartbeatMs:10}});const run=worker.run();
  t.after(async()=>{release.resolve();await worker.stop();await run;});
  await until(()=>f.statuses.length>=3);assert.equal(f.statuses.some(s=>s.mediaCleanupCompleted),false);release.resolve();
  await until(()=>f.media.isConnected());assert.equal(f.statuses.some(s=>s.mediaCleanupCompleted),false);
});

test("meeting analysis preserves model-selected speaker evidence and source revisions",async t=>{
  const f=fixture();const transcript={id:randomUUID(),participantId:f.identity,content:"Discuss delivery risk",revision:2};f.context.pendingTranscripts=[transcript];
  await start(t,f,{analyze:async input=>({nodeUpserts:[{id:randomUUID(),participantStates:[{participantId:f.identity,evidenceTranscriptIds:[input.pendingTranscripts[0].id]}]}]})});
  await until(()=>f.posts.some(p=>p.path==="meeting-analysis"));
  const body=f.posts.find(p=>p.path==="meeting-analysis").body;
  assert.deepEqual(body.sourceTranscriptRevisions,{[transcript.id]:2});assert.deepEqual(body.nodeUpserts[0].participantStates[0].evidenceTranscriptIds,[transcript.id]);
});

test("isolation transition cancels in-flight analysis and rejects its late output",async t=>{
  const f=fixture();const transcript={id:randomUUID(),participantId:f.identity,content:"Discuss scope",revision:1};f.context.pendingTranscripts=[transcript];
  const generation=deferred();let signal;const worker=await start(t,f,{analyze:async(_input,s)=>{signal=s;return generation.promise;}});
  await until(()=>signal);f.context.room.status="mediation";await worker.control();assert.equal(signal.aborted,true);
  generation.resolve({nodeUpserts:[]});await delay(20);assert.equal(f.posts.some(p=>p.path==="meeting-analysis"),false);
});

test("HTTP transport binds service credentials and deadlines without leaking error payloads",async()=>{
  const calls=[];const transport=createWorkerTransport({appOrigin:"http://local.test",inferenceOrigin:"http://inference.test",roomId:randomUUID(),runId:"run",workerToken:"worker-only",inferenceToken:"inference-only"},async(url,options)=>{calls.push({url:String(url),options});return Response.json({data:{ok:true}});});
  const controller=new AbortController();await transport.context(controller.signal);await transport.infer({observationId:randomUUID()},new Uint8Array([1]),controller.signal);
  assert.equal(calls[0].options.headers.Authorization,"Bearer worker-only");assert.equal(calls[1].options.headers.Authorization,"Bearer inference-only");
  assert.equal(calls[1].options.body.get("metadata").type,"application/json");assert.equal(calls[1].options.body.get("frame").type,"image/jpeg");
  assert.equal(calls[0].options.redirect,"error");assert.ok(calls[0].options.signal);
});

test("supervisor starts one worker per room and shuts it down when discovery removes it",async()=>{
  const controller=new AbortController();let rooms=["room"],created=0,stopped=0;const exit=deferred();
  const run=runSupervisor({intervalMs:5,discover:async()=>rooms,maintenance:async()=>{},create(){created++;return{run:()=>exit.promise,stop:async()=>{stopped++;exit.resolve();}};}},controller.signal);
  await until(()=>created===1);await delay(20);assert.equal(created,1);rooms=[];await until(()=>stopped===1);controller.abort();await run;
});

test("latest-only queue releases replaced values and stops cleanly",async()=>{
  const controller=new AbortController();const release=deferred(),values=[];
  const queue=new LatestOnly(async value=>{values.push(value);if(value===1)await release.promise;},controller.signal);
  queue.offer(1);await until(()=>values.length===1);queue.offer(2);queue.offer(3);release.resolve();await queue.done();assert.deepEqual(values,[1,3]);controller.abort();queue.offer(4);await delay(5);assert.deepEqual(values,[1,3]);
});

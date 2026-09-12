import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDatabase, closeDatabase, withTransaction} from '../../lib/db/postgres.ts';
import {ingestTranscript, submitMeetingAnalysis} from '../../services/worker/index.ts';
import {applyNodeGroups} from '../../lib/agents/node-grouping.ts';

test('API-24 persists a grouping parent without replacing child state or losing original evidence', {skip:!process.env.DATABASE_URL}, async()=>{
 const db=getDatabase(),roomId=randomUUID(),person=randomUUID(),user=randomUUID(),a=randomUUID(),b=randomUUID(),parent=randomUUID();
 await db`insert into rooms(id,title,created_by,status) values(${roomId}::uuid,'Grouping test',${user}::uuid,'meeting')`;
 await db`insert into participants(id,room_id,auth_user_id,display_name,role,livekit_identity,transcription_consent,structured_sharing_consent) values(${person}::uuid,${roomId}::uuid,${user}::uuid,'Tester','host',${person},true,true)`;
 const segments=[randomUUID(),randomUUID(),randomUUID()];
 for(const [i,id] of segments.entries())await withTransaction(tx=>ingestTranscript(tx,roomId,{segmentId:id,participantIdentity:person,content:['Budget is limited.','Two engineers are available.','Let us review the constraints.'][i],isFinal:true,revision:1,streamId:randomUUID(),trackSid:'TR_test',startedAtMs:null,endedAtMs:null,language:'en',confidence:null,receivedAt:new Date().toISOString(),timeBasis:'unknown',consentRevision:1}));
 const nodes=[a,b].map((id,i)=>({id,parentNodeId:null,topic:i?'Engineering team size':'Budget limit',summary:i?'Two engineers are available.':'The budget is limited.',contentionScore:.1,discussionLoopCount:0,status:'normal'}));
 const first=nodes.map((n,i)=>({...n,participantStates:[{participantId:person,position:'An explicitly stated constraint',supportingReasons:[],underlyingConcerns:[],emotionIntensity:null,viewOfOthers:[],acceptableCompromises:[],evidenceTranscriptIds:[segments[i]],affectObservationIds:[]}]}));
 await withTransaction(tx=>submitMeetingAnalysis(tx,roomId,{analysisId:randomUUID(),baseMapVersion:0,sourceTranscriptIds:segments.slice(0,2),nodeUpserts:first}));
 const before=await db`select s.* from participant_node_states s join mind_map_nodes n on n.id=s.node_id where n.room_id=${roomId}::uuid order by s.id`;
 const evidence=await db`select e.* from node_transcript_evidence e join mind_map_nodes n on n.id=e.node_id where n.room_id=${roomId}::uuid order by e.node_id`;
 const nodeUpserts=applyNodeGroups(nodes,[],[{id:parent,topic:'Project constraints',summary:'Limits on budget and staffing.',childNodeIds:[a,b]}]);
 const result=await withTransaction(tx=>submitMeetingAnalysis(tx,roomId,{analysisId:randomUUID(),baseMapVersion:1,sourceTranscriptIds:[segments[2]],nodeUpserts}));
 assert.equal(result.mapVersion,2);
 assert.deepEqual(await db`select s.* from participant_node_states s join mind_map_nodes n on n.id=s.node_id where n.room_id=${roomId}::uuid order by s.id`,before);
 assert.deepEqual(await db`select e.* from node_transcript_evidence e join mind_map_nodes n on n.id=e.node_id where n.room_id=${roomId}::uuid order by e.node_id`,evidence);
 const saved=await db`select id,parent_node_id from mind_map_nodes where room_id=${roomId}::uuid`;
 assert.equal(saved.length,3);assert.ok(saved.filter(n=>n.id!==parent).every(n=>n.parent_node_id===parent));
 assert.equal(saved.find(n=>n.id===parent).parent_node_id,null);
});
test.after(closeDatabase);

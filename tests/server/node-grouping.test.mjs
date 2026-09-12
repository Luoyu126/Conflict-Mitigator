import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applyNodeGroups} from '../../lib/agents/node-grouping.ts';
const node=(topic,parentNodeId=null)=>({id:randomUUID(),parentNodeId,topic,summary:topic,contentionScore:.2,discussionLoopCount:1,status:'normal'});
const group=(children)=>({id:randomUUID(),topic:'Project constraints',summary:'Limits on project resources and delivery.',childNodeIds:children.map(n=>n.id)});

test('grouping preserves child content and leaves existing participant states and evidence untouched',()=>{
 const nodes=[node('Budget'),node('Staffing'),node('Weather')],g=group(nodes.slice(0,2)),before=structuredClone(nodes);
 const result=applyNodeGroups(nodes,[],[g]);assert.deepEqual(nodes,before);assert.equal(result.length,3);
 const parent=result.find(n=>n.id===g.id);assert.equal(parent.parentNodeId,null);assert.equal(parent.contentionScore,0);assert.deepEqual(parent.participantStates,[]);
 for(const old of nodes.slice(0,2)){const child=result.find(n=>n.id===old.id);assert.equal(child.parentNodeId,g.id);assert.equal(child.topic,old.topic);assert.equal(child.summary,old.summary);assert.equal(child.contentionScore,old.contentionScore);assert.deepEqual(child.participantStates,[]);}
 assert.ok(!result.some(n=>n.id===nodes[2].id));
});

test('nested grouping inserts its parent between siblings and their actual parent',()=>{
 const root=node('Project'),a=node('Budget',root.id),b=node('Staffing',root.id),other=node('Customer feedback',root.id),g=group([a,b]);
 const result=applyNodeGroups([root,a,b,other],[],[g]);assert.equal(result.find(n=>n.id===g.id).parentNodeId,root.id);
 assert.ok(result.filter(n=>n.id!==g.id).every(n=>n.parentNodeId===g.id));
});

test('new semantic child retains its selected transcript evidence when grouped',()=>{
 const a=node('Budget'),b=node('Staffing'),g=group([a,b]),evidence=randomUUID();
 const draft={...b,participantStates:[{participantId:randomUUID(),position:'Hire two engineers',supportingReasons:[],underlyingConcerns:[],emotionIntensity:null,viewOfOthers:[],acceptableCompromises:[],evidenceTranscriptIds:[evidence],affectObservationIds:[]}]};
 const result=applyNodeGroups([a],[draft],[g]);assert.deepEqual(result.find(n=>n.id===b.id).participantStates,draft.participantStates);
});

test('skips invalid grouping proposals while rejecting cycles in the content graph',()=>{
 const a=node('Budget'),b=node('Staffing'),g=group([a,b]);
 assert.deepEqual(applyNodeGroups([a,b],[],[{...g,childNodeIds:[a.id,randomUUID()]}]),[]);
 assert.deepEqual(applyNodeGroups([a,b],[],[{...g,childNodeIds:[a.id,a.id]}]),[]);
 assert.deepEqual(applyNodeGroups([a,{...b,parentNodeId:a.id}],[],[g]),[]);
 assert.deepEqual(applyNodeGroups([a,{...b,status:'private_mediation'}],[],[g]),[]);
 assert.equal(applyNodeGroups([a,b],[],[g,{...g,id:randomUUID()}]).length,3);
 assert.deepEqual(applyNodeGroups([a,b],[],[{...g,id:a.id}]),[]);
 assert.throws(()=>applyNodeGroups([{...a,parentNodeId:b.id},{...b,parentNodeId:a.id}],[],[]));
});


test('already grouped siblings do not acquire redundant parent layers',()=>{
 const parent=node('Project constraints'),a=node('Budget',parent.id),b=node('Staffing',parent.id);
 assert.deepEqual(applyNodeGroups([parent,a,b],[],[group([a,b])]),[]);
 assert.deepEqual(applyNodeGroups([parent,a,b],[],[{...group([a,b]),topic:'Resource constraints'}]),[]);
});

test('grouping parent IDs are assigned by trusted code rather than copied from model output',async()=>{
 const {analyzeMeeting}=await import('../../lib/agents/meeting-agent.ts');
 const a=node('Budget'),b=node('Staffing');
 const result=await analyzeMeeting({nodes:[a,b],participantStates:[],pendingTranscripts:[]},async()=>({nodeUpserts:[],nodeGroups:[{id:a.id,topic:'Project constraints',summary:'Budget and staffing constraints.',childNodeIds:[a.id,b.id]}]}));
 assert.notEqual(result.nodeGroups[0].id,a.id);
 assert.equal(applyNodeGroups([a,b],result.nodeUpserts,result.nodeGroups).length,3);
});

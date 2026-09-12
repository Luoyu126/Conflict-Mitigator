import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3104';
const authOrigin = process.env.MOCK_SUPABASE_ORIGIN ?? 'http://127.0.0.1:59999';
for (const origin of [appOrigin, authOrigin]) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Browser acceptance must use an isolated localhost origin.');
}
const artifacts = process.env.BROWSER_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'cm-browser-acceptance-'));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  headless: true,
  args: process.env.PLAYWRIGHT_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
});
try {
const page=await browser.newPage({viewport:{width:1440,height:1000}, serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*', route => {
  const origin = new URL(route.request().url()).origin;
  return [new URL(appOrigin).origin, new URL(authOrigin).origin].includes(origin) ? route.continue() : route.abort();
});
const id='10000000-0000-4000-8000-000000000001',pid='20000000-0000-4000-8000-000000000001',sid='30000000-0000-4000-8000-000000000001',nid='40000000-0000-4000-8000-000000000001';
const now=new Date().toISOString();let consents={transcription:false,visualAffect:false,voiceAffect:false,structuredSharing:false};
const participant={id:pid,roomId:id,displayName:'Live tester',role:'host',status:'active',livekitIdentity:pid,joinedAt:now,leftAt:null};
const node={id:nid,roomId:id,parentNodeId:null,topic:'Real API topic',summary:'Server-grounded summary',status:'heated',contentionScore:.8,readinessScore:null,discussionLoopCount:3,createdAt:now,updatedAt:now};
const extraNodes = [
 { ...node, id: '40000000-0000-4000-8000-000000000002', topic: 'Budget', status: 'normal', parentNodeId: null },
 { ...node, id: '40000000-0000-4000-8000-000000000003', topic: 'Delivery', status: 'normal', parentNodeId: null },
 { ...node, id: '40000000-0000-4000-8000-000000000004', topic: 'Testing', status: 'normal', parentNodeId: '40000000-0000-4000-8000-000000000003' },
 { ...node, id: '40000000-0000-4000-8000-000000000005', topic: 'Test coverage', status: 'normal', parentNodeId: '40000000-0000-4000-8000-000000000004' },
];
let state='meeting';let med=null;let joined;const sentIds=[];let sendFails=true;let messages=[];let resumeVersion;let tokenTimes=[];
function roomData(){return {room:{id,title:'Live API conversation',status:state,createdAt:now,updatedAt:now,mediaEpochAt:now,activeMediationSessionId:med&&!['completed','cancelled'].includes(med.status)?sid:null,activeMediationNodeId:med&&!['completed','cancelled'].includes(med.status)?nid:null,observer:{status:'ready',audio:'ready',video:'ready',meetingAgent:'ready',lastHeartbeatAt:now}},participants:[participant],me:{participant,consents,consentRevision:1,consentNoticeVersion:'cm-privacy-v1'}};}
function session(status='proposed'){return {id:sid,roomId:id,nodeId:nid,status,triggerReason:'Discussion needs clarification',sharedSummary:null,summaryVersion:0,createdAt:now,expiresAt:null,startedAt:null,endedAt:null,members:[{participantId:pid,entryDecision:'pending',resumeDecision:'pending',acceptedSummaryVersion:null,isolatedAt:null,updatedAt:now}],transitionError:null};}
function meData(){return {session:med,node,selfState:null,others:[],chatAllowed:med?.status==='active'&&consents.structuredSharing,canAcceptResume:med?.status==='active'&&Boolean(med.sharedSummary),navigationPath:`/room/${id}/mediation/${nid}`,consensusTree:med.sharedSummary?{version:1,generatedAt:now,nodes:[{id:'tree-1',kind:'inferred_common_ground',label:'Shared concern from API',participantId:null,epistemicStatus:'llm_inferred'}],edges:[]}:null};}
const token=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:pid,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.stub';
await page.route(`${authOrigin}/**`,async route=>{
 if(route.request().method()==='OPTIONS')return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
 await route.fulfill({json:{access_token:token,refresh_token:'test-only-refresh',expires_in:3600,token_type:'bearer',user:{id:pid,aud:'authenticated',role:'authenticated',email:'',app_metadata:{provider:'anonymous',providers:['anonymous']},user_metadata:{},identities:[],created_at:now,is_anonymous:true}},headers:{'access-control-allow-origin':'*'}});
});
await page.route('**/api/rooms**',async route=>{
 const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method(); const body=req.postData()?JSON.parse(req.postData()):{};
 const ok=data=>route.fulfill({json:{data,requestId:crypto.randomUUID()}});
 if(path==='/api/rooms'&&method==='POST')return ok({room:roomData().room,lobbyPath:`/room/${id}/lobby`});
 if(path.endsWith('/lobby'))return ok({roomId:id,title:'Live API conversation',status:state,participantCount:1,canJoin:true,myParticipantId:null,consentNoticeVersion:'cm-privacy-v1'});
 if(path.endsWith('/join')){joined=body;return ok({room:roomData().room,me:roomData().me,livekit:{},navigationPath:`/room/${id}`});}
 if(path===`/api/rooms/${id}`)return ok(roomData());
 if(path.endsWith('/mind-map'))return ok({roomId:id,mapVersion:1,nodes:[node,...extraNodes],participantStates:[]});
 if(path.endsWith('/transcripts'))return ok({items:[{id:'segment-1',roomId:id,participantId:pid,content:'This text came from the API.',startedAtMs:100,endedAtMs:1000,isFinal:true,revision:1,streamId:'stream',sourceTrackSid:'TR_test',language:'en',confidence:null,createdAt:now,updatedAt:now}],pageInfo:{nextBeforeCursor:null,hasMore:false}});
 if(path.endsWith('/livekit-token')){tokenTimes.push(Date.now());return route.fulfill({status:409,json:{error:{code:'MEDIA_CLEANUP_PENDING',message:'Waiting for safe media renewal',retryable:true,retryAfterMs:1500,issues:[],userMessageId:null},requestId:'test'}});}
 if(path.endsWith(`/nodes/${nid}/mediation`))return ok({session:med,isMember:true});
 if(path.endsWith('/acceptance')){med={...med,status:'starting',members:med.members.map(m=>({...m,entryDecision:body.decision}))};state='mediation';return ok({session:med,node,roomStatus:state});}
 if(path.endsWith('/me/consents')){consents={...consents,...body};return ok({me:roomData().me});}
 if(path.endsWith('/me/messages')&&method==='GET')return ok({items:messages,pageInfo:{nextBeforeCursor:null,hasMore:false}});
 if(path.endsWith('/me/messages')&&method==='POST'){
  sentIds.push(body.clientMessageId);
  if(sendFails){sendFails=false;return route.fulfill({status:500,json:{error:{code:'INTERNAL_ERROR',message:'Test retry',retryable:true,retryAfterMs:null,issues:[],userMessageId:null},requestId:'test'}});}
  messages=[{id:'message-1',mediationSessionId:sid,participantId:pid,role:'user',content:body.content,clientMessageId:body.clientMessageId,replyToMessageId:null,replyStatus:'completed',createdAt:now},{id:'message-2',mediationSessionId:sid,participantId:pid,role:'assistant',content:'A private API reply.',clientMessageId:null,replyToMessageId:'message-1',replyStatus:null,createdAt:now}];return ok({userMessage:messages[0],assistantMessage:messages[1]});
 }
 if(path.endsWith('/resume')){resumeVersion=body.summaryVersion;med={...med,status:'completed'};state='meeting';return ok({session:med,node,roomStatus:state});}
 if(path.endsWith('/me'))return ok(meData());
 const detailNode = [node, ...extraNodes].find(item => path.endsWith(`/nodes/${item.id}`));
 if(detailNode)return ok({node:detailNode,participantStates:[],selfState:null,activeMediationSessionId:detailNode.id===nid?med?.id??null:null});
 console.log('unexpected',method,path);return route.fulfill({status:404,json:{error:{message:'Not stubbed'}}});
});
await page.goto(`${appOrigin}/`);await page.getByLabel('Start a conversation').fill('Live API conversation');await page.getByRole('button',{name:'Create meeting',exact:true}).click();await page.waitForURL(`**/room/${id}/lobby`);await page.getByLabel('Your name',{exact:true}).fill('Live tester');
assert.equal(await page.locator('input[type=checkbox]:checked').count(),0);await page.screenshot({path:join(artifacts, 'lobby.png'),fullPage:true});await page.getByRole('button',{name:'Join meeting',exact:true}).click();await page.waitForURL(`**/room/${id}`);await page.getByText('This text came from the API.').waitFor();assert.deepEqual(joined.consents,consents);assert.equal(await page.getByText('Chelsea Rathbun',{exact:false}).count(),0);await page.screenshot({path:join(artifacts, 'live.png'),fullPage:true});
const map = page.locator('svg[aria-labelledby="map-title map-description"]');
await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
for (const item of [node, ...extraNodes]) {
 const drawn = map.getByRole('button', { name: `${item.topic}.`, exact: false });
 await drawn.waitFor();
 const box = await drawn.boundingBox(), canvas = await map.boundingBox();
 assert.ok(box && canvas && box.x >= canvas.x && box.y >= canvas.y && box.x + box.width <= canvas.x + canvas.width && box.y + box.height <= canvas.y + canvas.height, `${item.topic} fits inside canvas`);
}
assert.equal(await map.getByRole('button').count(), 5, 'all independent roots and descendants are rendered');
assert.equal(await map.locator('path').count(), 2, 'only the two real parent-child edges are drawn');
await map.getByRole('button', { name: 'Test coverage.', exact: false }).click();
await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
await map.getByRole('button', { name: 'Real API topic.', exact: false }).click();
await page.screenshot({path:join(artifacts, 'multi-root-map.png'),fullPage:true});
med=session();await page.getByRole('button',{name:'Agree and enter mediation →'}).waitFor();await page.getByRole('button',{name:'Agree and enter mediation →'}).click();await page.getByText('Meeting media is off.',{exact:false}).waitFor();const before=tokenTimes.length;await page.waitForTimeout(1800);assert.equal(tokenTimes.length,before,'no token renewal during isolation');
med={...med,status:'active'};await page.waitForURL(`**/room/${id}/mediation/${nid}`);await page.getByRole('button',{name:'Allow structured sharing',exact:true}).click();await page.getByLabel('Your message to the Private Agent').fill('My private concern');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByText('Test retry',{exact:true}).waitFor();await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByText('A private API reply.').waitFor();assert.equal(sentIds[0],sentIds[1],'same clientMessageId on retry');
med={...med,sharedSummary:'Shared approved proposal',summaryVersion:3};node.status='ready_to_resume';node.readinessScore=.8;await page.getByText('Shared concern from API',{exact:false}).waitFor();await page.screenshot({path:join(artifacts, 'private.png'),fullPage:true});await page.getByRole('button',{name:'Accept and return to meeting →'}).click();await page.waitForURL(`**/room/${id}`);assert.equal(resumeVersion,3);await page.waitForTimeout(1000);assert.ok(tokenTimes.length>before,'fresh token requested after completed mediation');assert.deepEqual(errors,[]);console.log('PASS: create/join all consent off, API-only live map/transcript, isolation blocks token, private text retry deduplicates, versioned resume, fresh token.');console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }

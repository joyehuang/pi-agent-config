import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const baseline=process.argv.includes('--baseline');
const imp=n=>import(pathToFileURL(path.join(root,'lib',n+'.ts')));
const {createTelegramActivityRuntime,createTelegramAssistantOutputRuntime}=await imp('activity');
const {handleTelegramAgentEndRuntime}=await imp('queue');
const {createTelegramOutboundReplyArtifactSender}=await imp('outbound');
const {createTelegramSendQueue,withTelegramSendContext}=await imp('send-queue');
const results=[];
function runtime(){
 const sent=[],events=[];
 const output=createTelegramAssistantOutputRuntime({isEnabled:()=>true,canDeliver:()=>true,send:async e=>sent.push({route:'assistant-output',text:e.text,target:e.target,activity:e.activityId})});output.start();
 const rt=createTelegramActivityRuntime({generation:'test',dispatcher:{dispatch:()=>{},stop:()=>{}},observeEvent:e=>{events.push(e);if(e.type==='assistant-segment')output.accept(e);}});
 const start=(target,request)=>{rt.recordInputSource('extension');rt.onAgentStart(target,request)};
 const text=t=>{rt.onAssistantEvent({type:'text_end',contentIndex:0,content:t});rt.onAssistantEvent({type:'done'})};
 async function queue(turn,t){await handleTelegramAgentEndRuntime({turn,assistant:{text:t,stopReason:'stop'},foldQueuedPromptsIntoHistory:false,
  resetRuntimeState:()=>{},updateStatus:()=>{},dispatchNextQueuedTelegramTurn:()=>{},clearPreview:async()=>{},setPreviewPendingText:()=>{},finalizeMarkdownPreview:async()=>false,
  sendMarkdownReply:async(_c,_r,text)=>sent.push({route:'queue',text,target:turn.target}),sendTextReply:async()=>{},sendQueuedAttachments:async()=>{}})}
 return {sent,events,output,rt,start,text,queue,close(){output.stop();rt.onSessionShutdown()}};
}
const turn=(thread=1)=>({chatId:123,replyToMessageId:1,target:{chatId:123,threadId:thread},queuedAttachments:[]});
for(const preceding of [false,true]){
 const h=runtime();if(preceding){h.start();h.rt.onAgentEnd()}
 const t=turn();h.start(t.target,t);h.text('same');await h.output.waitForIdle();await h.queue(t,'same');
 assert.equal(h.sent.length,baseline&&preceding?2:1);
 if(!baseline||!preceding)assert.equal(h.sent[0].route,'queue');
 results.push({case:preceding?'autonomous_to_user':'ordinary',sends:h.sent.length,routes:h.sent.map(s=>s.route)});h.close();
}
if(baseline){console.log(JSON.stringify({baseline:true,cases:results}));process.exit(0)}
{
 const h=runtime();let old;
 for(let i=0;i<2;i++){const t=turn(i+1);h.start(t.target,t);if(old)h.rt.onAgentSettled(old);
 old=h.rt.getActivityId();h.text('same');await h.output.waitForIdle();await h.queue(t,'same');h.rt.onAgentEnd()}
 assert.equal(h.sent.length,2);assert.notEqual(h.sent[0].target.threadId,h.sent[1].target.threadId);results.push('same_text_distinct_turn_cross_thread_stale_settled');h.close();
}
{
 const h=runtime(),t=turn();h.start(t.target,t);h.rt.onAgentEnd();h.start();h.text('autonomous');await h.output.waitForIdle();
 assert.equal(h.sent.length,1);assert.equal(h.events.at(-1).source,'autonomous');results.push('user_to_autonomous');h.close();
}
{
 const h=runtime(),t=turn();h.start(t.target,t);
 h.rt.onAssistantEvent({type:'text_end',contentIndex:0,content:'progress'});h.rt.onAssistantEvent({type:'toolcall_start',contentIndex:1});
 await h.output.waitForIdle();h.text('final');await h.output.waitForIdle();await h.queue(t,'final');assert.deepEqual(h.sent.map(s=>s.text),['progress','final']);
 const id=h.rt.getActivityId();h.rt.onAgentEnd();h.rt.onAgentStart(t.target,t);assert.equal(h.rt.getActivityId(),id);results.push('intermediate_and_retry_identity');h.close();
}
{
 const h=runtime();h.start();h.rt.onAgentEnd();h.rt.onAgentSettled();const t=turn();h.start(t.target,t);h.text('new session');await h.output.waitForIdle();await h.queue(t,'new session');assert.equal(h.sent.length,1);h.close();results.push('session_reset');
}
const artifact=createTelegramOutboundReplyArtifactSender({});
for(const plan of [{},{voiceText:''},{voiceReplies:[]},{voiceReplies:[{text:'  '}]}])await artifact(turn(),plan);
results.push('empty_artifact_tts_noop');
{
 const dir=path.join(root,'test-ledger');let attempts=0;const q=createTelegramSendQueue({directory:dir,getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:'1',pairedUserId:123}),record:()=>{},intervalMs:0});
 await assert.rejects(()=>withTelegramSendContext({priority:'final',isActive:()=>true,requestId:'r',activityId:'a',route:'queue',source:'telegram'},()=>q.run('sendMessage',{chat_id:123,text:'PRIVATE_FIXTURE'},async()=>{attempts++;throw Object.assign(new Error('lost'),{name:'TelegramApiCommitUnknownError'})})));
 assert.equal(attempts,1);const ledger=fs.readFileSync(path.join(dir,'delivery-ledger.jsonl'),'utf8');assert(!ledger.includes('PRIVATE_FIXTURE'));assert(!ledger.includes('fixture'));assert.equal(JSON.parse(ledger.trim().split('\n').at(-1)).status,'unknown');results.push('unknown_send_no_retry_redacted_ledger');
}
console.log(JSON.stringify({passed:results},null,2));
// Installed binding membrane lifecycle, using only mock host hooks and ports.
{
 const {bindTelegramRelayOwner}=await imp('bindings');
 const hooks={};let owns=true,work=false;
 const pi={on:(name,cb)=>hooks[name]=cb};
 const ctx={mode:'tui',sessionManager:{getSessionId:()=> 's'},isIdle:()=>true,hasPendingMessages:()=>false};
 bindTelegramRelayOwner(pi,{owns:()=>owns,getTarget:()=>({chatId:123,threadId:5}),getProfile:()=> 'personal',getEpoch:()=>1,generation:'g',hasWork:()=>work});
 const key=Symbol.for('joye.pi-telegram.relay-owner.v1');
 hooks.session_start({},ctx);assert.equal(globalThis[key]().target.threadId,5);
 owns=false;assert.equal(globalThis[key](),undefined);owns=true;work=true;assert.equal(globalThis[key]().idle,false);
 hooks.session_shutdown();assert.equal(globalThis[key],undefined);
 console.log('owner binding: passed');
}
// Actual preserved guard, no model: one follow-up, then a real Telegram turn.
{
 const {default:guard}=await import('../extensions/empty-reply-guard.ts');
 const hooks={};let injections=0;guard({on:(n,c)=>hooks[n]=c,sendUserMessage:()=>injections++});
 await hooks.before_agent_start({prompt:'question'});
 const e={messages:[{role:'assistant',content:[],stopReason:'stop'}]},ctx={ui:{notify:()=>{}}};
 await hooks.agent_end(e,ctx);await hooks.agent_end(e,ctx);assert.equal(injections,1);
 const h=runtime();h.start();h.rt.onAgentEnd();h.start();h.text('guard follow-up');await h.output.waitForIdle();h.rt.onAgentEnd();
 const t=turn();h.start(t.target,t);h.text('user reply');await h.output.waitForIdle();await h.queue(t,'user reply');
 assert.deepEqual(h.sent.map(s=>s.text),['guard follow-up','user reply']);h.close();
 console.log('preserved empty guard followup: passed');
}
{
 const h=runtime();
 for(let i=0;i<2;i++){const t=turn(1);h.start(t.target,t);h.text('identical legitimate answer');await h.output.waitForIdle();await h.queue(t,'identical legitimate answer');h.rt.onAgentEnd()}
 assert.equal(h.sent.length,2);h.close();console.log('same text two turns same thread: passed');
}
{
 const {createTelegramActivityBridgeRuntime}=await imp('activity');const events=[];
 const rt=createTelegramActivityBridgeRuntime({generation:'session-test',observeEvent:e=>events.push(e)});
 rt.onSessionStart();rt.recordInputSource('extension');rt.onAgentStart();const old=rt.getActivityId();rt.onAgentEnd();rt.onSessionShutdown();
 rt.onSessionStart();const t=turn();rt.recordInputSource('extension');rt.onAgentStart(t.target,t);rt.onAgentSettled(old);
 rt.onAssistantEvent({type:'text_end',contentIndex:0,content:'new'});rt.onAssistantEvent({type:'done'});
 assert.equal(events.at(-1).source,'telegram');assert.notEqual(rt.getActivityId(),old);rt.onSessionShutdown();console.log('real bridge runtime session replacement: passed');
}
// Real local bus serialization retains correlation across follower/leader APIs.
{
 const os=await import('node:os');
 const {createTelegramBusLocalServer,isTelegramFollowerApiCallAllowed}=await imp('bus');
 const {createTelegramBusFollowerApiCaller}=await imp('bus-follower');
 const {handleFollowerApiCall}=await imp('bus-leader');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bus-ledger-'));
 const socketDir=fs.mkdtempSync('/tmp/pi-fix-bus-');
 const socket=path.join(socketDir,'bus.sock');
 let generation='g',calls=0,lastEnvelope,drop=false,sequence=0;
 const follower={instanceId:'f',registrationGeneration:generation,target:{chatId:123,threadId:8}};
 const registry={get:()=>({...follower,registrationGeneration:generation}),heartbeat:()=>{}};
 const q=createTelegramSendQueue({directory:dir,getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:()=>{},intervalMs:0});
 const server=createTelegramBusLocalServer({socketPath:socket,shouldDropResponse:()=>drop,handleEnvelope:async e=>{
  lastEnvelope=e;return handleFollowerApiCall(e,{followerRegistry:registry,getNowMs:Date.now,authorizeFollowerApiCall:isTelegramFollowerApiCallAllowed,
   callApi:async(method,args)=>q.run(args[0],args[1],async()=>{calls++;return {message_id:calls}})});
 }});
 await server.start();
 try {
  const send=createTelegramBusFollowerApiCaller({socketPath:socket,instanceId:'f',createRequestId:()=>`f:${++sequence}`,getRegistrationGeneration:()=>generation,timeoutMs:200});
  const work=()=>send('call',['sendMessage',{chat_id:123,message_thread_id:8,text:'PRIVATE_BUS_FIXTURE',reply_parameters:{message_id:77}}]);
  await withTelegramSendContext({priority:'final',isActive:()=>true,originalText:'MUST_NOT_CROSS',requestId:'request-8',activityId:'activity-8',route:'queue',placement:'final',source:'telegram'},work);
  assert.equal(calls,1);assert.equal(lastEnvelope.delivery.requestId,'request-8');assert(!JSON.stringify(lastEnvelope.delivery).includes('MUST_NOT_CROSS'));
  const rows=()=>fs.readFileSync(path.join(dir,'delivery-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const receipt=rows().at(-1);assert.equal(receipt.request_id,'request-8');assert.equal(receipt.thread,8);assert.equal(receipt.reply_to,77);assert.equal(receipt.message_id,1);assert.equal(receipt.status,'success');
  drop=true;await assert.rejects(()=>withTelegramSendContext({priority:'final',isActive:()=>true,requestId:'request-lost',route:'queue'},work));
  assert.equal(calls,2);assert.equal(rows().at(-1).request_id,'request-lost');assert.equal(rows().at(-1).status,'success');
  console.log('real serialized bus correlation and unknown bus ACK without duplicate API send: passed');
 }finally{await server.stop();fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(socketDir,{recursive:true,force:true})}
}
{
 const {registerTelegramLifecycleHooks}=await imp('lifecycle');const hooks={};const h=runtime();
 let model='fixture-a',t=turn();
 registerTelegramLifecycleHooks({on:(name,cb)=>hooks[name]=cb},{onModelSelect:event=>{model=event.model.id},isSessionActive:()=>true});
 h.start();h.rt.onAgentEnd();await hooks.model_select({model:{id:'fixture-b'}},{});
 h.start(t.target,t);h.text('after model selection');await h.output.waitForIdle();await h.queue(t,'after model selection');
 assert.equal(model,'fixture-b');assert.equal(h.sent.length,1);h.close();console.log('real lifecycle model_select event then user turn: passed (no model call)');
}
{
 const dir=path.join(root,'test-ledger-receipts');let calls=0;
 const q=createTelegramSendQueue({directory:dir,getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:()=>{},intervalMs:0});
 await q.run('editMessageText',{chat_id:123,message_id:90,text:'edit fixture'},async()=>{calls++;return true});
 await assert.rejects(()=>q.run('sendMessage',{chat_id:123,text:'failed fixture'},async()=>{calls++;throw Object.assign(new Error('rejected fixture'),{status:400})}));
 const rows=fs.readFileSync(path.join(dir,'delivery-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert(rows.some(r=>r.operation==='edit'&&r.status==='success'&&r.message_id===90));assert.equal(rows.at(-1).status,'failure');assert.equal(calls,2);
 console.log('send/edit confirmed and rejected ledger receipts: passed');
}

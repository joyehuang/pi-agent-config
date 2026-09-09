// Actual Agent/AgentSession queues + relay + full bridge lifecycle registration.
// Only model stream and physical Telegram API are deterministic fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRelay} from '../extensions/relay-notify.ts';
import guard from '../extensions/empty-reply-guard.ts';
const [pkg,host,root]=process.argv.slice(2);fs.mkdirSync(root,{recursive:true});
const imp=p=>import(pathToFileURL(p));
const {Agent}=await imp(path.join(host,'node_modules/@earendil-works/pi-agent-core/dist/agent.js'));
const {AssistantMessageEventStream}=await imp(path.join(host,'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'));
const {AgentSession}=await imp(path.join(host,'dist/core/agent-session.js'));
const {SessionManager}=await imp(path.join(host,'dist/core/session-manager.js'));
const {SettingsManager}=await imp(path.join(host,'dist/core/settings-manager.js'));
const {createTelegramActivityRuntime}=await imp(path.join(pkg,'lib/activity.ts'));
const {registerTelegramLifecycleRuntimeHooks,createTelegramAssistantOutputBindingRuntime}=await imp(path.join(pkg,'lib/bindings.ts'));
const {createTelegramSendQueue}=await imp(path.join(pkg,'lib/send-queue.ts'));
globalThis.fetch=()=>{throw Error('NETWORK FORBIDDEN')};
const key=Symbol.for('joye.pi-telegram.relay-owner.v1'),controlKey=Symbol.for('joye.pi.task-control.v1');
const script=path.resolve('scripts/task_protocol.py');
const model={id:'fixture',api:'fixture',provider:'fixture',baseUrl:'',reasoning:false,input:['text'],contextWindow:1e6,maxTokens:1000};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
class OfflineSession extends AgentSession {
 _buildRuntime(){} _installAgentToolHooks(){} _installAgentNextTurnRefresh(){} async _checkCompaction(){return false}
}
const noop=()=>{},noops=new Proxy({}, {get:()=>noop});
async function harness(name){
 const dir=path.join(root,name);fs.mkdirSync(dir);const state=path.join(dir,'state');
 const python=args=>JSON.parse(execFileSync('/usr/bin/python3',[script,'--root',state,...args],{encoding:'utf8'}));
 const code=text=>JSON.parse(execFileSync('/usr/bin/python3',['-c',`import sys,json\nsys.path.insert(0,${JSON.stringify(path.resolve('scripts'))})\nimport task_protocol as p\nroot=${JSON.stringify(state)}\n${text}`],{encoding:'utf8'}));
 code("p.register(root,'t','fixture','review',[],route={'profile':'personal','target':{'chatId':123}})\np.start_run(root,'t','r')\nwith p.transaction(root) as reg:\n t=reg['tasks'][0];t.update(status='ready_for_review');eid=p.emit(reg,t,'ready_for_review')\np.enqueue(root,'state data','task-watchdog',p.read(p.Path(root)/'registry.json')['outbox'][eid])\nprint(json.dumps(eid))");
 const box=()=>JSON.parse(fs.readFileSync(path.join(state,'inbox.json')));
 const phase=status=>code(`with p.transaction(root) as reg: reg['tasks'][0]['status']=${JSON.stringify(status)}\nprint('null')`);
 const proof=path.join(dir,'handled');fs.writeFileSync(proof,'Independent fixture control handling evidence');
 const hooks={},tools={},pending=[],sends=[],injected=[];let session,mode='text',calls=0,beforeStart,interceptSend;
 const sm=SessionManager.inMemory();
 const ctx={mode:'tui',hasUI:true,ui:{notify:noop},sessionManager:sm,isIdle:()=>!session._isAgentRunActive,hasPendingMessages:()=>session.pendingMessageCount>0};
 const emit=async event=>{for(const h of hooks[event.type]??[])await h(event,ctx)};
 const pi={on:(n,h)=>(hooks[n]??=[]).push(h),registerTool:t=>{tools[t.name]=t},appendEntry:(type,data)=>sm.appendCustomEntry(type,data),
  exec:async(cmd,args)=>{try{return {code:0,stdout:execFileSync(cmd,args,{encoding:'utf8'})}}catch{return {code:1,stdout:''}}},
  sendUserMessage:(content,opts)=>{injected.push(content);if(interceptSend)interceptSend(content,opts);else pending.push(session.sendUserMessage(content,opts))}};
 const q=createTelegramSendQueue({directory:path.join(dir,'ledger'),getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:noop,intervalMs:0});
 const output=createTelegramAssistantOutputBindingRuntime({isEnabled:()=>true,authority:{getPreferredTarget:()=>({chatId:123}),getFallbackChatId:()=>123,getTransportStamp:()=>1,isTransportStampActive:()=>true,ownsDirect:()=>true,getDirectEpoch:()=>1,isFollowerRegistered:()=>false,getFollowerGeneration:()=>undefined},sender:{sendMessage:body=>q.run('sendMessage',body,async()=>{sends.push(body);return {message_id:sends.length}}),sendRichMessage:()=>{throw Error('unexpected rich')},getAssistantRenderingMode:()=> 'html',execCommand:()=>{throw Error('unexpected command')}},recordRuntimeEvent:noop});
 const activity=createTelegramActivityRuntime({generation:name,dispatcher:{dispatch:noop,stop:noop},observeEvent:e=>output.observeEvent(e)});
 registerTelegramLifecycleRuntimeHooks({pi,activityRuntime:activity,assistantOutputRuntime:output.runtime,sessionLifecycleRuntime:{onSessionStart:noop,onSessionShutdown:noop,onModelSelect:noop},
  configStore:{get:()=>({}),getOutboundHandlers:()=>({}),hasBotToken:()=>true,load:async()=>{}},abort:noops,typing:noops,lifecycle:{...noops,hasDispatchPending:()=>false,resetActiveToolExecutions:noop,clearDispatchPending:noop,setFoldQueuedPromptsIntoHistory:noop,shouldFoldQueuedPromptsIntoHistory:()=>false,getActiveToolExecutions:()=>0,setActiveToolExecutions:noop},
  activeTurnRuntime:{get:()=>undefined,has:()=>false,set:noop,clear:noop},telegramQueueStore:{getQueuedItems:()=>[],setQueuedItems:noop},modelSwitchController:noops,previewRuntime:noops,promptDispatchRuntime:noops,deferredQueueDispatchRuntime:noops,modelContextAvailabilityRuntime:{reconcile:noop},buttonActionStore:noops,
  callMultipart:noop,sendChatAction:noop,sendRecordVoiceAction:noop,sendMarkdownReply:()=>{throw Error('unexpected queue final')},sendTextReply:()=>{throw Error('unexpected queue fallback')},dispatchNextQueuedTelegramTurn:noop,answerGuestQuery:noop,deleteMessage:noop,sendGuestReply:noop,finalizeMarkdownPreview:noop,proactivePushTargetGetter:()=>({chatId:123}),getAssistantRenderingMode:()=> 'html',canSendAgentActivity:()=>false,isSessionContextActive:()=>true,updateStatus:noop,recordRuntimeEvent:(category,error)=>{throw error??Error(category)}});
 guard(pi);const relay=createRelay(pi,{script,root:state,isMain:()=>true});
 const agent=new Agent({initialState:{model,tools:[{...tools.task_event_finish,execute:(id,args,signal,update)=>tools.task_event_finish.execute(id,args,signal,update,ctx)}]},streamFn:()=>{
  calls++;assert(calls<20,'unbounded fixture stream');
  const stream=new AssistantMessageEventStream();const content=['empty','empty-error'].includes(mode)?[]:mode==='finish'?[{type:'toolCall',id:'finish-'+calls,name:'task_event_finish',arguments:{evidence:proof}}]:[{type:'text',text:'旧提醒已处理（离线固定输出）'}];
  const m={role:'assistant',api:'fixture',provider:'fixture',model:'fixture',timestamp:Date.now(),usage,stopReason:mode==='finish'?'toolUse':mode==='empty-error'?'error':'stop',content};
  stream.push({type:'start',partial:m});if(mode==='text'){stream.push({type:'text_start',contentIndex:0,partial:m});stream.push({type:'text_end',contentIndex:0,content:content[0].text,partial:m})}
  stream.push(mode==='empty-error'?{type:'error',reason:'error',error:m}:{type:'done',reason:m.stopReason,message:m});return stream;
 }});
 session=new OfflineSession({agent,sessionManager:sm,settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),modelRuntime:{hasConfiguredAuth:()=>true},resourceLoader:{getPromptTemplates:()=>[],getPrompts:()=>[]},cwd:dir});
 session._extensionRunner={invalidate:noop,emit,hasHandlers:n=>!!hooks[n]?.length,emitInput:async(text,images,source)=>{for(const h of hooks.input??[]){const r=await h({text,images,source},ctx);if(r?.action==='handled')return r}return {action:'continue'}},emitBeforeAgentStart:async prompt=>{await emit({type:'before_agent_start',prompt,systemPrompt:''});await beforeStart?.()},emitMessageEnd:async e=>{await emit(e)},emitError:e=>{throw Error(JSON.stringify(e))}};
 globalThis[key]=()=>({pid:process.pid,profile:'personal',session_id:sm.getSessionId(),target:{chatId:123},generation:name,epoch:1,idle:ctx.isIdle()});
 await emit({type:'session_start'});
 const flush=async()=>{for(let i=0;i<pending.length;i++)await pending[i];await output.runtime.waitForIdle()};
 return {session,agent,sm,ctx,relay,python,box,phase,pi,pending,sends,injected,tools,proof,emit,flush,code,calls:()=>calls,setMode:v=>mode=v,setBeforeStart:v=>beforeStart=v,setIntercept:v=>interceptSend=v,async close(){await emit({type:'session_shutdown'});session.dispose();delete globalThis[key]}};
}
const passed=[];
{
 const h=await harness('current-internal');await h.relay.collect();await h.flush();assert.equal(h.calls(),1);assert.equal(h.sends.length,0);assert.equal(h.injected.length,1);
 assert(h.sm.getBranch().some(e=>e.customType==='task-control-input-v1'));passed.push('current_ready_executes_but_prose_is_internal');
 h.setMode('empty');await h.session.sendUserMessage('Real user asks about [task-event:fake]');await h.flush();assert.equal(h.injected.length,2);assert.equal(h.calls(),3);passed.push('real_user_empty_reply_recovers_after_internal');
 h.setMode('text');await h.session.sendUserMessage('Normal question repeats legitimate text');await h.flush();assert.equal(h.sends.length,1);
 await h.session.sendUserMessage('Normal question repeats legitimate text');await h.flush();assert.equal(h.sends.length,2);passed.push('same_text_new_user_requests_visible');await h.close();
}
{
 const h=await harness('silent-empty');h.setMode('empty');await h.relay.collect();await h.flush();assert.equal(h.calls(),1);assert.equal(h.injected.length,1);assert.equal(h.sends.length,0);passed.push('internal_empty_stop_no_compensation');await h.close();
}
{
 const h=await harness('custom-after-internal');await h.relay.collect();await h.flush();assert.equal(h.sends.length,0);
 await h.session.sendCustomMessage({customType:'mail',content:'Independent authorized extension task',display:false},{triggerTurn:true});await h.flush();assert.equal(h.sends.length,1);passed.push('independent_custom_prompt_does_not_inherit_internal_visibility');await h.close();
}
{
 const h=await harness('silent-error');h.setMode('empty-error');await h.relay.collect();await h.flush();assert.equal(h.calls(),1);assert.equal(h.injected.length,1);assert.equal(h.sends.length,0);passed.push('internal_empty_error_no_compensation');await h.close();
}
{
 const h=await harness('silent-tool');h.setMode('finish');await h.relay.collect();await h.flush();assert.equal(h.calls(),1);assert.equal(h.sends.length,0);assert.equal(Object.values(h.box())[0].state,'handled');passed.push('documented_terminate_tool_with_real_handling_proof');await h.close();
}
{
 const h=await harness('preflight-race');h.setBeforeStart(()=>h.phase('reported'));await h.relay.collect();await h.flush();assert.equal(h.calls(),0);assert.equal(h.sends.length,0);assert.equal(Object.values(h.box())[0].state,'superseded');passed.push('after_async_preflight_terminal_no_model_no_guard');await h.close();
}
{
 const h=await harness('last-hook-race');
 const retained={role:'custom',customType:'legacy-context',content:'keep this data',display:false,timestamp:1};
 h.session._pendingNextTurnMessages.push(retained);
 h.pi.on('turn_start',()=>h.phase('reported'));
 await h.relay.collect();await h.flush();assert.equal(h.calls(),0);assert.equal(h.sends.length,0);
 assert.equal(h.sm.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,0);
 assert.deepEqual(h.session._pendingNextTurnMessages,[retained]);passed.push('turn_start_after_admission_rechecks_preserves_next_turn_data');await h.close();
}
{
 const h=await harness('queue-race');let held;h.setIntercept((content,opts)=>held={content,opts});await h.relay.collect();assert(held);
 // Hold an actual fake stream open: Agent and AgentSession become busy through
 // their real lifecycle, without manually changing state flags.
 let release,entered;const waiting=new Promise(r=>entered=r);
 h.agent.streamFunction=()=>{
  const stream=new AssistantMessageEventStream();
  const m={role:'assistant',api:'fixture',provider:'fixture',model:'fixture',timestamp:1,usage,stopReason:'stop',content:[{type:'text',text:'Final user business delivery'}]};
  stream.push({type:'start',partial:m});
  release=()=>{stream.push({type:'text_start',contentIndex:0,partial:m});stream.push({type:'text_end',contentIndex:0,content:m.content[0].text,partial:m});stream.push({type:'done',reason:'stop',message:m})};
  entered();return stream;
 };
 const user=h.session.sendUserMessage('Real user prompt');await waiting;
 assert.equal(h.session.isStreaming,true);
 await h.session.sendUserMessage(held.content,held.opts);assert.equal(h.session.pendingMessageCount,1);
 h.phase('reported');release();
 await user;await h.flush();assert.equal(h.session.pendingMessageCount,0);assert.equal(h.sends.length,1);assert.equal(Object.values(h.box())[0].state,'superseded');
 assert.equal(h.sm.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,1);passed.push('queued_then_reported_preserves_user_final_drops_control');await h.close();
}
{
 // The actual core queue drains stale heads without stranding ordinary messages,
 // including all mode; use the issued capabilities from the real relay capture.
 const h=await harness('fifo-queue');let held;h.setIntercept((content,opts)=>held={content,opts});await h.relay.collect();
 const c=globalThis[controlKey].take(held.content);h.phase('reported');
 const message={role:'user',content:'control',timestamp:1};Object.defineProperty(message,Symbol.for('joye.pi.task-control.message.v1'),{value:c});
 const ordinary={role:'user',content:'ordinary',timestamp:2};h.agent.followUp(message);h.agent.followUp(ordinary);
 assert.deepEqual(h.agent.followUpQueue.drain(),[ordinary]);h.agent.followUpMode='all';h.agent.followUp(ordinary);h.agent.followUp(message);assert.deepEqual(h.agent.followUpQueue.drain(),[ordinary]);passed.push('stale_queue_head_fifo_and_all_mode');await h.close();
}
{
 let current=true,turns=0,calls=0;
 const streamFn=()=>{calls++;const stream=new AssistantMessageEventStream();const m={role:'assistant',api:'fixture',provider:'fixture',model:'fixture',timestamp:1,usage,stopReason:'stop',content:[{type:'text',text:'ordinary'}]};stream.push({type:'done',reason:'stop',message:m});return stream};
 const agent=new Agent({initialState:{model},streamFn});
 agent.subscribe(e=>{if(e.type==='turn_start' && ++turns===2)current=false});
 const control={role:'user',content:'obsolete queued data',timestamp:2};Object.defineProperty(control,Symbol.for('joye.pi.task-control.message.v1'),{value:{check:()=>current}});
 agent.followUp(control);agent.followUp({role:'user',content:'valid next question',timestamp:3});
 await agent.prompt('ordinary first question');
 assert.equal(calls,2);assert(!agent.state.messages.some(m=>m===control));assert(agent.state.messages.some(m=>m.content==='valid next question'));passed.push('advance_in_turn_start_after_dequeue_no_stale_model_preserves_tail');
}
console.log(JSON.stringify({passed,physical_fake_sends_for_queued_reported_task:1,stale_control_model_calls:0,stale_control_replies:0,real_model_calls:0,messages_sent:0}));

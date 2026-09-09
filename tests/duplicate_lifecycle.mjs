// Real installed Agent + AgentSession event/persistence/native-retry machinery.
// Only model stream, extension registry, compaction and Telegram network are fake.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [pkg,host,guardPath,evidence]=process.argv.slice(2);
const imp=p=>import(pathToFileURL(p));
const {Agent}=await imp(path.join(host,'node_modules/@earendil-works/pi-agent-core/dist/agent.js'));
const {AssistantMessageEventStream}=await imp(path.join(host,'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'));
const {AgentSession}=await imp(path.join(host,'dist/core/agent-session.js'));
const {SessionManager}=await imp(path.join(host,'dist/core/session-manager.js'));
const {SettingsManager}=await imp(path.join(host,'dist/core/settings-manager.js'));
const {default:guard}=await imp(guardPath);
const {createTelegramActivityRuntime}=await imp(path.join(pkg,'lib/activity.ts'));
const {createTelegramAssistantOutputBindingRuntime}=await imp(path.join(pkg,'lib/bindings.ts'));
const {createTelegramSendQueue}=await imp(path.join(pkg,'lib/send-queue.ts'));
const scenario=process.argv[6] ?? 'incident';
const baselineGuard=guardPath.includes('baseline');
const baselineTransport=pkg.includes('baseline');
globalThis.fetch=()=>{throw new Error('NETWORK FORBIDDEN')};
const model={id:'fixture',name:'fixture',api:'fixture',provider:'fixture',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1e6,maxTokens:1000};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const completion='Completed synthetic dashboard task.';
let calls=0,sends=0,injections=0;
const events=[],parts=[],prompts=[];
const q=createTelegramSendQueue({directory:path.join(evidence,'ledger'),getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:()=>{},intervalMs:0});
const output=createTelegramAssistantOutputBindingRuntime({isEnabled:()=>true,authority:{getPreferredTarget:()=>({chatId:123}),getFallbackChatId:()=>123,getTransportStamp:()=>1,isTransportStampActive:()=>true,ownsDirect:()=>true,getDirectEpoch:()=>1,isFollowerRegistered:()=>false,getFollowerGeneration:()=>undefined},sender:{sendMessage:body=>q.run('sendMessage',body,async()=>({message_id:++sends})),sendRichMessage:()=>{throw Error('unexpected rich')},editMessage:()=>{throw Error('unexpected edit')},getAssistantRenderingMode:()=> 'html',execCommand:()=>{throw Error('unexpected handler')}},recordRuntimeEvent:()=>{}});
output.runtime.start();
const activity=createTelegramActivityRuntime({generation:'fixture-session',dispatcher:{dispatch:()=>{},stop:()=>{}},observeEvent:e=>{if(e.type==='assistant-segment')parts.push(e.placement);output.observeEvent(e)}});
const hooks={};let session;
const ctx={mode:'tui',hasUI:true,ui:{notify:()=>{}},sessionManager:SessionManager.inMemory(),isIdle:()=>!session._isAgentRunActive,hasPendingMessages:()=>session.pendingMessageCount>0};
const pending=[];
guard({on:(n,h)=>hooks[n]=h,sendUserMessage:(text,opts)=>{injections++;prompts.push(text);pending.push(session.sendUserMessage(text,opts))}});
const emit=async e=>{
 events.push(e.type);
 await hooks[e.type]?.(e,ctx);
 if(e.type==='input')activity.recordInputSource(e.source);
 if(e.type==='agent_start')activity.onAgentStart();
 if(e.type==='message_update')activity.onAssistantEvent(e.assistantMessageEvent);
 if(e.type==='agent_end')activity.onAgentEnd();
 if(e.type==='agent_settled')activity.onAgentSettled();
};
const agent=new Agent({initialState:{model,tools:[{name:'fixture_tool',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'fixture tool result'}]})}]},streamFn:()=>{
 calls++;
 let m={role:'assistant',api:'fixture',provider:'fixture',model:'fixture',timestamp:calls,usage,stopReason:calls===1?'error':calls===2?'toolUse':'stop',content:calls===2?[{type:'toolCall',id:'tool-1',name:'fixture_tool',arguments:{}}]:calls===1?[]:[{type:'text',text:completion}],...(calls===1?{errorMessage:'503 service unavailable'}:{})};
 if(scenario!=='incident') {
   const reason=scenario==='abort'?'aborted':['empty-error','abort-backoff'].includes(scenario)?'error':'stop';
   m={...m,stopReason:reason,content:[],...(reason==='error'?{errorMessage:scenario==='abort-backoff'?'503 service unavailable':'nonretryable fixture failure'}:{errorMessage:undefined})};
 }
 assert(calls<=4,'unbounded model fixture loop');
 const stream=new AssistantMessageEventStream();stream.push({type:'start',partial:{...m,stopReason:'pending'}});
 if(scenario==='incident' && calls===2)stream.push({type:'toolcall_start',contentIndex:0,partial:m});
 if(scenario==='incident' && calls>=3){stream.push({type:'text_start',contentIndex:0,partial:m});stream.push({type:'text_end',contentIndex:0,content:completion,partial:m})}
 stream.push(['error','aborted'].includes(m.stopReason)?{type:'error',reason:m.stopReason,error:m}:{type:'done',reason:m.stopReason,message:m});return stream;
}});
class OfflineSession extends AgentSession {
 _buildRuntime() {} // No resource discovery, providers, real tools or user config.
 _installAgentToolHooks() {}
 _installAgentNextTurnRefresh() {}
 async _checkCompaction(){return false}
}
session=new OfflineSession({agent,sessionManager:ctx.sessionManager,settingsManager:SettingsManager.inMemory({retry:{enabled:true,maxRetries:1,baseDelayMs:50},compaction:{enabled:false}}),modelRuntime:{hasConfiguredAuth:()=>true},resourceLoader:{getPromptTemplates:()=>[],getPrompts:()=>[]},cwd:process.cwd()});
session._extensionRunner={invalidate:()=>{},emit,hasHandlers:n=>n==='input',emitInput:async(text,images,source)=>{const r=await hooks.input?.({text,images,source},ctx);activity.recordInputSource(source);return r??{action:'continue'}},emitBeforeAgentStart:async prompt=>{await hooks.before_agent_start?.({prompt},ctx)},emitMessageEnd:async e=>{await emit(e)},emitError:e=>{throw Error(JSON.stringify(e))}};
if(scenario==='abort-backoff')session.subscribe(e=>{if(e.type==='auto_retry_start')setTimeout(()=>session.abortRetry(),0)});
await hooks.session_start?.({},ctx);
await session.sendUserMessage('Run synthetic task');
for(let i=0;i<pending.length;i++) await pending[i];
await output.runtime.waitForIdle();
if(scenario==='incident'){
assert.equal(calls,baselineGuard?4:3);
assert.equal(injections,baselineGuard?1:0);
assert.equal(sends,baselineGuard&&baselineTransport?2:1);
assert.deepEqual(parts,baselineGuard?['intermediate','terminal-partial']:['terminal-partial']);
assert.equal(ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.stopReason==='stop').length,baselineGuard?2:1);
} else { assert.equal(calls,['abort','abort-backoff'].includes(scenario)?1:2); assert.equal(injections,['abort','abort-backoff'].includes(scenario)?0:1); assert.equal(sends,0); }
output.runtime.stop();activity.onSessionShutdown();session.dispose();
console.log(JSON.stringify({case:scenario,baselineGuard,baselineTransport,fake_stream_calls:calls,guard_injections:injections,physical_fake_api_sends:sends,placements:parts,real_model_calls:0,network_calls:0}));

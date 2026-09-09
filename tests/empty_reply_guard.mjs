import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import guard from '../extensions/empty-reply-guard.ts';
const {SessionManager}=await import(pathToFileURL(path.join(process.argv[2],'dist/core/session-manager.js')));
const done=[];
const assistant=(content=[],stopReason='stop')=>({role:'assistant',content,stopReason,timestamp:1});
const text=t=>[{type:'text',text:t}];
function harness(){
 const hooks={},injected=[];let idle=true,pending=false,reads=0;
 const sm=SessionManager.inMemory();const orig=sm.getEntry.bind(sm);sm.getEntry=id=>{reads++;return orig(id)};
 const ctx={sessionManager:sm,hasUI:true,ui:{notify:()=>{}},isIdle:()=>idle,hasPendingMessages:()=>pending};
 const emit=(n,e={})=>hooks[n]?.(e,ctx);
 guard({on:(n,h)=>hooks[n]=h,sendUserMessage:t=>{injected.push(t)}});emit('session_start');
 const add=m=>sm.appendMessage(m);
 const user=t=>{emit('before_agent_start',{prompt:t});return add({role:'user',content:text(t),timestamp:1})};
 const end=m=>{add(m);emit('turn_end',{message:m,toolResults:[]});emit('agent_end',{messages:[m]})};
 return {sm,ctx,emit,add,user,end,injected,reads:()=>reads,idle:v=>idle=v,pending:v=>pending=v};
}
for(const reason of ['stop','error','length']){
 const h=harness();h.user('request');h.end(assistant([],reason));assert.equal(h.injected.length,0);h.emit('agent_settled');assert.equal(h.injected.length,1);
 const retry=h.injected[0];assert.notEqual(h.emit('input',{source:'extension',text:retry})?.action,'handled');
 assert.equal(h.emit('input',{source:'extension',text:retry})?.action,'handled');
 h.user(retry);h.end(assistant([],reason));h.emit('agent_settled');h.emit('agent_settled');assert.equal(h.injected.length,1);
 h.user('new request');h.end(assistant([],reason));h.emit('agent_settled');assert.equal(h.injected.length,2);
 done.push(`empty_${reason}_one_retry_duplicate_followup_new_budget`);
}
for(const reason of ['aborted','pending','toolUse']){const h=harness();h.user('x');h.end(assistant([],reason));h.emit('agent_settled');assert.equal(h.injected.length,0);done.push(`no_retry_${reason}`)}
{
 const h=harness();h.user('x');h.end(assistant([...text('progress'),{type:'toolCall',id:'a'}],'toolUse'));h.add({role:'toolResult',content:text('result'),timestamp:1});h.end(assistant());h.emit('agent_settled');assert.equal(h.injected.length,1);done.push('progress_before_tools_is_not_final');
}
{
 const h=harness();h.user('x');h.end(assistant(text('final')));h.emit('agent_end',{messages:[assistant()]});h.emit('agent_settled');assert.equal(h.injected.length,0);done.push('persisted_final_overrides_stale_empty_event');
 h.user('next');h.end(assistant());h.emit('agent_end',{messages:[assistant(text('old final'))]});h.emit('agent_settled');assert.equal(h.injected.length,1);done.push('stale_nonempty_event_does_not_hide_current_empty');
}
{
 const h=harness();const fork=h.user('x');h.end(assistant(text('old branch')));h.sm.branch(fork);h.emit('session_tree');h.user('branch request');h.end(assistant());h.emit('agent_settled');assert.equal(h.injected.length,1);
 h.ctx.sessionManager=SessionManager.inMemory();h.emit('agent_end',{messages:[assistant()]});h.emit('agent_settled');assert.equal(h.injected.length,1);done.push('branch_and_session_fencing');
}
{
 const h=harness();h.user('x');h.end(assistant());h.idle(false);h.emit('agent_settled');assert.equal(h.injected.length,0);h.idle(true);h.pending(true);h.emit('agent_settled');assert.equal(h.injected.length,0);h.pending(false);h.user('queued request');h.end(assistant(text('new final')));h.emit('agent_settled');assert.equal(h.injected.length,0);done.push('late_settled_busy_and_queued_input');
}
{
 const h=harness();h.user('prior task');h.end(assistant(text('prior final')));h.emit('agent_settled');h.user('autonomous task');h.end(assistant());h.emit('agent_settled');assert.equal(h.injected.length,1);done.push('new_autonomous_task_not_suppressed');
}
{
 const h=harness();h.user('long task');for(let i=0;i<3000;i++)h.end(assistant([{type:'toolCall',id:String(i)}],'toolUse'));const before=h.reads();h.end(assistant());h.emit('agent_settled');assert(h.reads()-before<5);assert.equal(h.injected.length,1);done.push('indexed_incremental_branch_reads');
}
{
 const h=harness();h.user('x');h.end(assistant());h.ctx.signal={aborted:true};h.emit('agent_settled');assert.equal(h.injected.length,0);done.push('abort_signal');
}
{
 const h=harness();h.user('x');h.end(assistant(text('completed candidate')));h.end(assistant());h.emit('agent_settled');assert.equal(h.injected.length,0);done.push('completed_candidate_survives_empty_late_run_without_new_work');
}
console.log(JSON.stringify({passed:done,real_model_calls:0}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRelay} from '../extensions/relay-notify.ts';
const {SessionManager}=await import(pathToFileURL(path.join(os.homedir(),'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')));
const exec=promisify(execFile),root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-test-'));
const script=path.resolve('scripts/task_protocol.py');
const python=async args=>JSON.parse((await exec('/usr/bin/python3',[script,'--root',root,...args])).stdout);
const enqueue=async id=>exec('/usr/bin/python3',[path.resolve('scripts/notify-agent.py'),'fixture','test','--root',root,'--event-id',id]);
const read=()=>JSON.parse(fs.readFileSync(path.join(root,'inbox.json')));
const mutate=fn=>{const b=read();fn(b);fs.writeFileSync(path.join(root,'inbox.json'),JSON.stringify(b))};
const expire=()=>mutate(b=>{for(const n of Object.values(b)){n.lease_until=0;n.next_at=0}});
let manager=SessionManager.create(root,path.join(root,'sessions'));
// Ensure actual SessionManager flushes subsequent user input to a private test file.
const initial=manager.appendMessage({role:'assistant',content:[{type:'text',text:'fixture context'}],timestamp:Date.now(),stopReason:'stop'});
let hooks={},sent=[],fail=false,idle=true,main=true;
const key=Symbol.for('joye.pi-telegram.relay-owner.v1');
globalThis[key]=()=>({pid:process.pid,profile:'personal',session_id:manager.getSessionId(),target:{chatId:123,threadId:2},generation:'g',epoch:'1',idle});
const ctx={isIdle:()=>idle,hasPendingMessages:()=>false,get sessionManager(){return manager}};
const pi={registerTool:()=>{},appendEntry:()=>{},on:(name,cb)=>hooks[name]=cb,exec:async(cmd,args)=>{try{const r=await exec(cmd,args);return {...r,code:0}}catch{return {code:1,stdout:''}}},sendUserMessage:text=>{if(fail)throw Error('injection');sent.push(text);manager.appendMessage({role:'user',content:text,timestamp:Date.now()})}};
const start=()=>{hooks={};const r=createRelay(pi,{isMain:()=>main,script,root});hooks.session_start({},ctx);return r};
const clock=Date.now;
try{
 await enqueue('a');let r=start();idle=false;await r.collect();assert.equal(read().a.state,'pending');hooks.session_shutdown();
 idle=true;main=false;r=start();await r.collect();assert.equal(read().a.state,'pending');main=true;
 fail=true;await r.collect();assert.equal(read().a.state,'claimed');hooks.session_shutdown();
 expire();fail=false;r=start();await r.collect();assert.equal(sent.length,1);assert.equal(read().a.state,'enqueued');assert.notEqual(read().a.state,'handled');
 assert(sent[0].includes('后台通知｜test'));assert(sent[0].includes('没有 task/run 登记'));assert(!sent[0].includes('task_id=legacy'));
 hooks.session_shutdown();
 // A real file reopen retains the event input on this session's active branch.
 const sessionFile=manager.getSessionFile();manager=SessionManager.open(sessionFile);expire();r=start();await r.collect();assert.equal(sent.length,1);
 const fixedDeadline=read().a.lease_until;hooks.session_shutdown();
 mutate(b=>{b.a.state='claimed';b.a.lease_until=0});
 r=start();await r.collect();assert.equal(sent.length,1);assert.equal(read().a.lease_until,fixedDeadline);hooks.session_shutdown();
 // Persisted input without handled proof must resume after the original deadline.
 mutate(b=>{b.a.first_enqueued_at=clock()/1000-2000;b.a.lease_until=0});
 r=start();await r.collect();assert.equal(sent.length,2);assert(sent[1].includes('[task-recovery:a]'));hooks.session_shutdown();
 // Crash after recovery injection but before ACK: persistent marker prevents repeat.
 manager=SessionManager.open(sessionFile);mutate(b=>{b.a.state='claimed';b.a.lease_until=0});
 r=start();await r.collect();assert.equal(sent.length,2);assert.equal(read().a.state,'needs_attention');
 await r.collect();assert.equal(sent.length,2);assert.equal(read().a.attention_required,'handling_unconfirmed');
 // Real tree navigation: original/recovery exist only on an inactive sibling.
 manager.branch(initial);const sibling=manager.appendMessage({role:'user',content:'different branch',timestamp:clock()});
 assert(manager.getEntries().some(e=>e.type==='message'&&JSON.stringify(e.message.content).includes('[task-event:a]')));
 assert(!manager.getBranch().some(e=>e.type==='message'&&JSON.stringify(e.message.content).includes('[task-event:a]')));
 hooks.session_tree({newLeafId:sibling},ctx);await r.collect();assert.equal(sent.length,2); // user quiet window
 Date.now=()=>clock()+2000;await r.collect();Date.now=clock;
 assert.equal(sent.length,3);assert(sent[2].startsWith('[task-event:a]'));hooks.session_shutdown();
 // Genuine handled proof is global business evidence, including other branches.
 const evidence=path.join(root,'handled.txt');fs.writeFileSync(evidence,'independently handled fixture');
 await python(['ack','a',read().a.claim_id,'handled','--evidence',evidence]);
 manager.branch(initial);manager.appendMessage({role:'user',content:'third branch',timestamp:clock()});r=start();await r.collect();assert.equal(sent.length,3);hooks.session_shutdown();
 // New session with uncertain, unhandled event can deliver at least once.
 await enqueue('b');r=start();await r.collect();hooks.session_shutdown();const before=sent.length;
 manager=SessionManager.inMemory(root);expire();r=start();await r.collect();assert.equal(sent.length,before+1);hooks.session_shutdown();
 console.log(JSON.stringify({passed:['busy_restart_pending','non_main_no_claim','inject_failure_lease_recovery','enqueued_not_handled','real_session_reopen_active_input_dedup','unknown_ack_fixed_deadline','same_session_unhandled_crash_recovery','recovery_ack_unknown_no_repeat','persistent_needs_attention_no_spam','real_tree_inactive_sibling_does_not_suppress','tree_user_priority','handled_proof_survives_branch_change','successor_at_least_once','shutdown_cleanup']}));
}finally{Date.now=clock;hooks.session_shutdown?.();delete globalThis[key];fs.rmSync(root,{recursive:true,force:true})}

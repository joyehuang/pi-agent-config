import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRelay} from '../extensions/relay-notify.ts';
const exec=promisify(execFile),root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-test-'));
const script=path.resolve('scripts/task_protocol.py');
const python=async args=>JSON.parse((await exec('/usr/bin/python3',[script,'--root',root,...args])).stdout);
const enqueue=async id=>exec('/usr/bin/python3',[path.resolve('scripts/notify-agent.py'),'fixture','test','--root',root,'--event-id',id]);
const read=()=>JSON.parse(fs.readFileSync(path.join(root,'inbox.json')));
const expire=()=>{const b=read();for(const n of Object.values(b))n.lease_until=0;fs.writeFileSync(path.join(root,'inbox.json'),JSON.stringify(b))};
let hooks={},entries=[],sent=[],fail=false,idle=true,session='main',main=true;
const key=Symbol.for('joye.pi-telegram.relay-owner.v1');
globalThis[key]=()=>({pid:process.pid,profile:'personal',session_id:session,target:{chatId:123,threadId:2},generation:'g',epoch:'1',idle});
const ctx={isIdle:()=>idle,hasPendingMessages:()=>false,sessionManager:{getSessionId:()=>session,getEntries:()=>entries}};
const pi={on:(name,cb)=>hooks[name]=cb,exec:async(cmd,args)=>{try{const r=await exec(cmd,args);return {...r,code:0}}catch{return {code:1,stdout:''}}},sendUserMessage:text=>{if(fail)throw Error('injection');sent.push(text);entries.push({type:'message',message:{role:'user',content:text}})}};
const start=()=>{hooks={};const r=createRelay(pi,{isMain:()=>main,script,root});hooks.session_start({},ctx);return r};
try{
 await enqueue('a');let r=start();idle=false;await r.collect();assert.equal(read().a.state,'pending');hooks.session_shutdown();
 idle=true;main=false;r=start();await r.collect();assert.equal(read().a.state,'pending');main=true;
 fail=true;await r.collect();assert.equal(read().a.state,'claimed');hooks.session_shutdown();
 expire();fail=false;r=start();await r.collect();assert.equal(sent.length,1);assert.equal(read().a.state,'enqueued');assert.notEqual(read().a.state,'handled');
 assert(sent[0].includes('后台通知｜test'));assert(sent[0].includes('没有 task/run 登记'));assert(!sent[0].includes('task_id=legacy'));
 hooks.session_shutdown();expire();r=start();await r.collect();assert.equal(sent.length,1); // persisted input dedup
 hooks.session_shutdown();
 // Lost ACK: accepted message survived but producer's claim lease expired.
 const b=read();b.a.state='claimed';b.a.lease_until=0;fs.writeFileSync(path.join(root,'inbox.json'),JSON.stringify(b));
 r=start();await r.collect();assert.equal(sent.length,1);hooks.session_shutdown();
 // A successor session may redeliver uncertain events; never pretend exactly once.
 session='replacement';entries=[];expire();r=start();await r.collect();assert.equal(sent.length,2);hooks.session_shutdown();
 console.log(JSON.stringify({passed:['busy_restart_pending','non_main_no_claim','inject_failure_lease_recovery','enqueued_not_handled','restart_persisted_input_dedup','unknown_ack_reconciliation','successor_at_least_once','shutdown_cleanup']}));
}finally{hooks.session_shutdown?.();delete globalThis[key];fs.rmSync(root,{recursive:true,force:true})}

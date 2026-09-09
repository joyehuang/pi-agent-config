import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [root,dir,socket]=process.argv.slice(2);
const imp=n=>import(pathToFileURL(path.join(root,'lib',n+'.ts')));
const {createTelegramBusLocalServer,isTelegramFollowerApiCallAllowed}=await imp('bus');
const {createTelegramBusFollowerApiCaller}=await imp('bus-follower');
const {handleFollowerApiCall}=await imp('bus-leader');
const {createTelegramSendQueue,withTelegramSendContext}=await imp('send-queue');
let calls=0,drop=true,seq=0,generation='g';
const follower={instanceId:'f',registrationGeneration:generation,target:{chatId:123,threadId:8}};
const registry={get:()=>({...follower,registrationGeneration:generation}),heartbeat:()=>{}};
const q=createTelegramSendQueue({directory:dir,getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:()=>{},intervalMs:0});
const server=createTelegramBusLocalServer({socketPath:socket,shouldDropResponse:()=>drop,handleEnvelope:e=>handleFollowerApiCall(e,{followerRegistry:registry,getNowMs:Date.now,authorizeFollowerApiCall:isTelegramFollowerApiCallAllowed,callApi:async(method,args)=>q.run(args[0],args[1],async()=>({message_id:++calls}))})});
await server.start();
try{
 const send=createTelegramBusFollowerApiCaller({socketPath:socket,instanceId:'f',createRequestId:()=>`f:${++seq}`,getRegistrationGeneration:()=>generation,timeoutMs:100});
 const work=(extra={},body={chat_id:123,message_thread_id:8,text:'completion'})=>withTelegramSendContext({priority:'background',isActive:()=>true,activityId:'f-session-1:a',requestId:'a',route:'assistant-output',placement:'intermediate',source:'autonomous',replyIntent:createHash('sha256').update('completion').digest('hex'),...extra},()=>send('call',['sendMessage',body]));
 await assert.rejects(()=>work());assert.equal(calls,1);drop=false;
 const result=await work({placement:'terminal-partial'});assert.equal(result.message_id,1);assert.equal(calls,1);
 const rows=fs.readFileSync(path.join(dir,'delivery-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.status==='success').length,1);
 await assert.rejects(()=>work({}, {chat_id:123,message_thread_id:9,text:'completion'}));assert.equal(calls,1);
 await work({activityId:'f-session-2:a'});assert.equal(calls,2);
 console.log(JSON.stringify({passed:['actual_serialized_bus_lost_ack_reuses_original_receipt','unauthorized_thread_rejected_before_dedup','new_follower_session_same_text_allowed'],real_api_calls:0}));
}finally{await server.stop()}

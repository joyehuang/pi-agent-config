import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,dir]=process.argv.slice(2);
const imp=n=>import(pathToFileURL(path.join(root,'lib',n+'.ts')));
const {createTelegramSendQueue}=await imp('send-queue');
const {createTelegramAssistantOutputBindingRuntime}=await imp('bindings');
const {createTelegramAssistantOutputSender}=await imp('outbound');
const fixtures=['# Header\n\n- item\n  - child\n\n**bold** _italic_\n\n```js\nconst under_score = "<tag>";\n```',('Repeated paragraph **bold** with under_score.\n\n').repeat(1200)];
const passed=[];
for(const mode of ['html','rich'])for(const [i,text] of fixtures.entries()){
 const expected=[],actual=[];
 const sender=collection=>({sendMessage:async body=>{collection.push({method:'sendMessage',body});return {message_id:collection.length}},sendRichMessage:async body=>{collection.push({method:'sendRichMessage',body});return {message_id:collection.length}},editMessage:()=>{throw Error('unexpected edit')},getAssistantRenderingMode:()=>mode,execCommand:()=>{throw Error('unexpected command')}});
 const event={type:'assistant-segment',activityId:`a-${mode}-${i}`,sequence:1,source:'autonomous',placement:'intermediate',text,contentIndex:0,timestamp:1};
 await createTelegramAssistantOutputSender(sender(expected))(event,{target:{chatId:123,threadId:8}},()=>true);
 const q=createTelegramSendQueue({directory:path.join(dir,mode+String(i)),getScope:()=>({profile:'fake',token:'fixture',ownerEpoch:1,pairedUserId:123}),record:()=>{},intervalMs:0});
 const physical=sender(actual);
 const binding=createTelegramAssistantOutputBindingRuntime({isEnabled:()=>true,authority:{getPreferredTarget:()=>({chatId:123,threadId:8}),getFallbackChatId:()=>123,getTransportStamp:()=>1,isTransportStampActive:()=>true,ownsDirect:()=>true,getDirectEpoch:()=>1,isFollowerRegistered:()=>false,getFollowerGeneration:()=>undefined},sender:{...physical,sendMessage:body=>q.run('sendMessage',body,()=>physical.sendMessage(body)),sendRichMessage:body=>q.run('sendRichMessage',body,()=>physical.sendRichMessage(body))},recordRuntimeEvent:()=>{}});
 binding.runtime.start();binding.observeEvent(event);binding.observeEvent({...event,sequence:2,placement:'terminal-partial'});await binding.runtime.waitForIdle();binding.runtime.stop();
 assert.deepEqual(actual,expected);assert(actual.length>=1);if(i===1)assert(actual.length>1);passed.push({mode,fixture:i,chunks:actual.length});
}
console.log(JSON.stringify({passed,real_api_calls:0}));

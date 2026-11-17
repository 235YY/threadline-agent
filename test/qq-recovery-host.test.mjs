import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readAccount} from '../tools/qq-connect/account.mjs';
import {claimConnector} from '../tools/qq-connect/connector-guard.mjs';
import {buildReplyPayload} from '../tools/qq-connect/bridge-payload.mjs';
import {launchBrain} from '../tools/brain-service/bootstrap.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {targetArgs,stickerPage} from '../tools/qq-connect/tools.mjs';
const temp=()=>mkdtempSync(join(tmpdir(),'jy-realqq-host-'));
test('QQ sender owner and Bot identity are separate, never inferred from selfId',()=>{
 const e={message_type:'private',user_id:7,message_id:1,message:[{type:'text',data:{text:'hello'}}]};
 assert.equal(buildReplyPayload(e,{selfId:7}).sender.isOwner,false);
 assert.equal(buildReplyPayload(e,{selfId:9,ownerId:'7'}).sender.isOwner,true);
 e.user_id=9;assert.equal(buildReplyPayload(e,{selfId:9,ownerId:7}).sender.isOwner,false);
});
test('account selection is explicit and cannot silently use a different Bot',()=>{
 const home=temp();mkdirSync(join(home,'config'));for(const id of [7,9])writeFileSync(join(home,'config',`onebot_${id}.json`),JSON.stringify({networks:{httpServers:[{host:'127.0.0.1',port:3000}],wsServers:[{host:'127.0.0.1',port:3001}]}}));
 assert.throws(()=>readAccount({home}),{code:'QQ_ACCOUNT_REQUIRED'});assert.equal(readAccount({home,uin:9}).uin,'9');assert.throws(()=>readAccount({home,uin:8}),{code:'ENOENT'});
});
test('one local Bot guard excludes another instance regardless of its project and database; other Bot allowed',()=>{
 const root=temp(),a=claimConnector({root,botId:'7'}),b=claimConnector({root,botId:'9'});
 try{assert.throws(()=>claimConnector({root,botId:'7'}),{code:'CONNECTOR_OWNED'});}finally{a.close();b.close();}
 const reopened=claimConnector({root,botId:'7'});reopened.close();assert.deepEqual(readdirSync(root),[]);
});
test('live bootstrap grants only the explicit tool set, preserves task controls, and never grants Office writes',async()=>{
 const root=temp();writeFileSync(join(root,'persona.txt'),'synthetic offline identity');let config;
 const running=await launchBrain({root,env:{JY_AFFECT:'0',BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_LEDGER:'fake.json',BRAIN_MAX_CALLS:'30',BRAIN_MAX_MICROS:'2000000',BRAIN_PORT:'0',BRAIN_STATE:'state',BRAIN_STORE:':memory:',BRAIN_IDENTITY_FILE:'persona.txt',BRAIN_MAINTENANCE:'0',BRAIN_HEARTBEAT_MS:'0'},dependencies:{officialSpend:{gate:()=>({known:true,allow:true})},auditBudgets:()=>{throw Error('legacy audit must not gate live startup');},createModelDecision:()=>({decide(){throw Error('NO_MODEL');},close(){}}),tools:{TOOL_NAMES:['qq_list_stickers','qq_send_sticker','office_run','github_put_file'],executeTool(){throw Error('NO_EXTERNAL');}},core:{READ_ONLY_HOST_TOOLS:['qq_list_stickers'],async startBrainService(c){config=c;return {server:{listening:false},health:()=>({cognitionBusy:false}),close(){},stopScheduling(){},startScheduling(){},port:0,url:'http://offline'};}}}});
 try{assert.deepEqual(Object.keys(config.agentTools),['qq_list_stickers','qq_send_sticker']);assert.ok(config.allowedActionTools.includes('qq_send_sticker'));assert.ok(config.allowedActionTools.includes('start_agent_task'));assert.ok(config.allowedActionTools.includes('remember_note'));assert.ok(!config.allowedActionTools.includes('office_run'));assert.ok(!config.allowedActionTools.includes('github_put_file'));assert.ok(!config.capabilities.includes('qq_send_voice'));assert.ok(!config.capabilities.includes('qq_send_message'));assert.ok(config.capabilities.includes('say'));assert.ok(config.capabilities.includes('qq_send_sticker'));}finally{await running.stop();}
});
test('host owns egress once and persists actual platform message_id in the response receipt',async()=>{
 let count=0;const service=createBrainService({storePath:':memory:',global:true,heartbeatMs:0,adapter:{send:async()=>{count++;return {message_id:123456};}},decide:p=>({packetId:p.packetId,options:[{id:'r',kind:'respond',payload:{text:'offline reply'}}],selected:'r',summary:'offline',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}})});
 try{const result=await service.reply({scene:'qq/private/7',key:'private:7',source:'qq',message_id:'one',execute:true,messages:[{role:'user',content:'offline input'}]});assert.equal(result.ok,true);assert.equal(count,1);await service.dispatch(result.outbox,{scene:'qq/private/7',execute:true});assert.equal(count,1);const response=[...service.store.all('response')][0];assert.equal(response.status,'sent');const events=[...service.store.all('event')];assert.ok(events.some(e=>String(e.body).includes('123456')));}finally{service.close();}
});
test('connector has no independent send fallback and always uses persistent admission even without polling',()=>{
 const s=readFileSync(new URL('../tools/qq-connect/bridge.mjs',import.meta.url),'utf8');
 assert.ok(!s.includes('ctx.reply('));assert.ok(!s.includes('deliverClaimedAction('));assert.match(s,/payload\.execute=true/);assert.match(s,/const receiver=new MessageReceiver/);assert.match(s,/QQ_IDENTITY_MISMATCH/);
});

 test('disabled history polling does not create a zero-delay interval',()=>{const s=readFileSync(new URL('../tools/qq-connect/bridge.mjs',import.meta.url),'utf8');assert.ok(s.includes("if(receiver&&reconcileMs>0){log('receive-reconciliation'"));});
test('actual QQ argument counterexample is rejected before transport; recipients are never guessed',()=>{
 assert.throws(()=>targetArgs({target:'private:100000001',id:'100000002_sticker',url:'https://example.invalid'}),{code:'QQ_TARGET_ARGUMENTS',transportInvoked:false});
 assert.deepEqual(targetArgs({target:'private',id:'100000001'}),{target:'private',id:'100000001'});
 assert.throws(()=>targetArgs({target:'private',id:'sticker-id'}),{code:'QQ_TARGET_ARGUMENTS'});
 const p=stickerPage([{id:'sticker-id',url:'https://example.invalid',desc:'synthetic'}]);assert.match(p.sendContract.id,/NOT item.id/);
});
test('known unsent host validation is a failed receipt, not unknown execution; no external call is made',async()=>{
 let externalCalls=0;const service=createBrainService({storePath:':memory:',global:true,heartbeatMs:0,allowedActionTools:['probe'],adapter:{act:async({args})=>{targetArgs(args);externalCalls++;return {}; }},decide:p=>({packetId:p.packetId,options:[{id:'a',kind:'act',payload:{tool:'probe',args:{target:'private:7',id:'sticker'}}}],selected:'a',summary:'offline',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}})});
 try{const result=await service.reply({scene:'qq/private/7',key:'private:7',source:'qq',message_id:'invalid',execute:true,messages:[{role:'user',content:'offline input'}]});assert.equal(result.ok,true);assert.equal(externalCalls,0);const action=[...service.store.all('action')][0];assert.equal(action.status,'failed');const receipt=service.store.read(action.receipt.id);assert.match(receipt.body,/QQ_TARGET_ARGUMENTS/);assert.match(receipt.body,/transportInvoked/);}finally{service.close();}
});

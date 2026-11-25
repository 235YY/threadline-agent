// U6 deliveryPin — A-owned enforcement tests.
// Only synthetic state and stubbed transports: no production DB, no QQ, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuityStore} from '../src/store.mjs';
import {initializeSubject} from '../src/continuity.mjs';
import {launchBrain,deliveryPinForResponse,deliveryPinForAction,deliveryPinForTask,assertPinnedDelivery,sendTargetScene,followupDeliveryAuthorization,DELIVERY_SEND_TOOLS} from '../tools/brain-service/bootstrap.mjs';
import {executeTool} from '../tools/qq-connect/tools.mjs';

const SUBJECT='jingyang';
function storeFixture(t){const store=new ContinuityStore(':memory:');t.after(()=>store.close());initializeSubject({store,subjectId:SUBJECT,requestId:'init'});return store;}
function admitEvent(store,id,scene,{origin='reported',actor='fixture'}={}){
 const ev=store.execute({requestId:'event:'+id,commands:[{op:'append_event',id,body:'synthetic '+id,origin,actor,scene,source:{system:'fixture',key:id},occurredAt:1000}]}).at(-1);
 store.execute({requestId:'admit:'+id,commands:[{op:'admit_subject_event',subjectId:SUBJECT,event:{id:ev.id,revision:ev.revision}}]});
 return ev;
}
function fakeStore(records){return {read:(id,revision)=>records[`${id}@${revision??'current'}`]??records[id]??null};}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jy-pin-'));
 const state=join(root,'state'), ledger=join(root,'journal.json'), identity=join(root,'persona.txt');
 writeFileSync(identity,'synthetic identity');
 const store=storeFixture(t);
 const calls=[],captured={};
 const tools={TOOL_NAMES:['qq_list_stickers','qq_send_sticker','qq_send_message','web_search'],UNAVAILABLE_TOOLS:[],
  executeTool:async(tool,args,context)=>{calls.push({tool,args,context});return {message_id:123456,delivered:true};}};
 const deps={tools,
  officialSpend:{gate:()=>({known:true,allow:true})},
  createModelDecision:()=>({decide(){throw Error('NO_MODEL');},close(){}}),
  core:{READ_ONLY_HOST_TOOLS:['qq_list_stickers','qq_send_message'],async startBrainService(options){
   captured.options=options;
   return {server:{listening:false},store,health:()=>({cognitionBusy:false,active:null,pending:[]}),close(){},stopScheduling(){},beginShutdown(){},startScheduling(){},runCognitionExclusive:async fn=>fn(),port:0,url:'http://offline',token:null};
  }}};
 const env={JY_AFFECT:'0',BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1',JY_QQ_SCOPE:'all',
  BRAIN_STORE:':memory:',BRAIN_LEDGER:ledger,BRAIN_PORT:'0',BRAIN_STATE:state,STYLE:join(root,'style'),BRAIN_STYLE_DIR:join(root,'style'),
  BRAIN_IDENTITY_FILE:identity,BRAIN_MAINTENANCE:'0',BRAIN_HEARTBEAT_MS:'0'};
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {root,store,env,deps,calls,captured};
}
async function boot(t,override={}){
 const f=fixture(t);
 const running=await launchBrain({root:process.cwd(),env:{...f.env,...override.env},dependencies:{...f.deps,...override.dependencies}});
 t.after(async()=>{try{await running.stop();}catch{}});
 return {...f,running,captured:f.captured};
}

test('sendTargetScene derives only explicit decimal QQ recipients',()=>{
 assert.equal(sendTargetScene('qq_send_sticker',{target:'private',id:'7',url:'https://example.invalid/x.png'}),'qq/private/7');
 assert.equal(sendTargetScene('qq_send_message',{target:'group',id:'9',text:'x'}),'qq/group/9');
 assert.equal(sendTargetScene('qq_send_sticker',{target:'private:7',id:'7'}),null);
 assert.equal(sendTargetScene('qq_send_message',{target:'group',id:'sticker:1'}),null);
 assert.equal(sendTargetScene('qq_list_stickers',{query:'x'}),null);
});

test('executeTool fails closed when a send has no committed pin',async()=>{
 await assert.rejects(()=>executeTool('qq_send_message',{target:'group',id:'9',text:'x'},{allowedTools:['qq_send_message'],pinRequired:true,entry:'decision'}),
  error=>error.code==='DELIVERY_PIN_UNAVAILABLE'&&error.transportInvoked===false);
});

test('executeTool rejects any target outside the committed pin before transport',async()=>{
 await assert.rejects(()=>executeTool('qq_send_sticker',{target:'group',id:'999',url:'https://example.invalid/x.png'},
  {allowedTools:['qq_send_sticker'],pinRequired:true,pinTargets:['qq/private/7'],entry:'task'}),
  error=>error.code==='UNDELIVERED_TARGET'&&error.transportInvoked===false);
 const saved=process.env.QQ_SEND_DISABLED;process.env.QQ_SEND_DISABLED='1';
 try{const result=await executeTool('qq_send_sticker',{target:'private',id:'7',url:'https://example.invalid/x.png'},
   {allowedTools:['qq_send_sticker'],pinRequired:true,pinTargets:['qq/private/7'],entry:'task'});
  assert.deepEqual(result,{delivered:false,disabled:true,mode:'receive-only'});}finally{if(saved===undefined)delete process.env.QQ_SEND_DISABLED;else process.env.QQ_SEND_DISABLED=saved;}
});

test('executeTool rejects out-of-pin targets before the Open-Life policy layer',async()=>{
 const saved=process.env.JY_OPEN_LIFE;process.env.JY_OPEN_LIFE='1';
 try{
  await assert.rejects(()=>executeTool('qq_send_message',{target:'group',id:'999',text:'x',reason:'synthetic'},
   {allowedTools:['qq_send_message'],pinRequired:true,pinTargets:['qq/private/7'],entry:'decision'}),
   error=>error.code==='UNDELIVERED_TARGET'&&error.transportInvoked===false);
  await assert.rejects(()=>executeTool('qq_send_message',{target:'private',id:'7',text:'x',reason:'synthetic'},
   {allowedTools:['qq_send_message'],pinRequired:true,pinTargets:['qq/private/7'],entry:'decision'}),
   error=>error.code==='LIFE_NOT_READY'&&error.transportInvoked===false);
 }finally{if(saved===undefined)delete process.env.JY_OPEN_LIFE;else process.env.JY_OPEN_LIFE=saved;}
});

test('response pin is the persisted response scene and rejects a caller-side redirect',()=>{
 const store=fakeStore({'resp:1':{type:'response',id:'resp:1',revision:1,subject:SUBJECT,scene:'qq/private/7',decision:{id:'dec:1',revision:1}}});
 const pin=deliveryPinForResponse({store,response:{id:'resp:1',revision:1}});
 assert.deepEqual(pin.allowedTargets,['qq/private/7']);
 assert.equal(assertPinnedDelivery({tool:'qq_send_message',args:{target:'private',id:'7'},pin}),'qq/private/7');
 assert.throws(()=>assertPinnedDelivery({tool:'qq_send_message',args:{target:'group',id:'999'},pin}),{code:'UNDELIVERED_TARGET'});
 assert.throws(()=>deliveryPinForResponse({store,response:{id:'missing',revision:1}}),{code:'DELIVERY_PIN_UNAVAILABLE'});
});

test('task pin defaults to no QQ delivery without a persisted origin',()=>{
 const pin=deliveryPinForTask({store:fakeStore({}),task:{id:'task:1',target:'qq/group/999',metadata:{allowedTools:['qq_send_sticker']}}});
 assert.equal(pin.denyQQ,true);
 assert.deepEqual(pin.allowedTargets,[]);
 assert.throws(()=>assertPinnedDelivery({tool:'qq_send_sticker',args:{target:'group',id:'999',url:'https://example.invalid/x.png'},pin}),{code:'DELIVERY_PIN_UNAVAILABLE'});
});

test('task pin derives from the admitted origin event and not from task.target',()=>{
 const store=fakeStore({
  'e1@1':{type:'event',id:'e1',revision:1,scene:'qq/private/10001',origin:'reported'},
  'dec-reflection@1':{type:'decision',id:'dec-reflection',revision:1,subject:SUBJECT,input:{payload:{current:null,continuity:{contactTargets:[{scene:'qq/private/20002'}]}}}},
 });
 store.subjectObservation=()=>({status:'received'});
 const fromEvent=deliveryPinForTask({store,task:{id:'task:1',originEventRef:{id:'e1',revision:1},target:'qq/group/999',metadata:{}}});
 assert.deepEqual(fromEvent.allowedTargets,['qq/private/10001']);
 assert.equal(assertPinnedDelivery({tool:'qq_send_sticker',args:{target:'private',id:'10001',url:'https://example.invalid/x.png'},pin:fromEvent}),'qq/private/10001');
 assert.throws(()=>assertPinnedDelivery({tool:'qq_send_sticker',args:{target:'group',id:'999',url:'https://example.invalid/x.png'},pin:fromEvent}),{code:'UNDELIVERED_TARGET'});
 const fromDecision=deliveryPinForTask({store,task:{id:'task:2',originDecisionRef:{id:'dec-reflection',revision:1},target:'qq/group/999',metadata:{}}});
 assert.deepEqual(fromDecision.allowedTargets,['qq/private/20002']);
});

test('autonomy task and missing-origin decisions deny QQ delivery at execution',async t=>{
 const f=await boot(t);
 const task={id:'task:auto',metadata:{origin:'autonomy',allowedTools:['qq_send_sticker']}};
 await assert.rejects(()=>f.captured.options.agentTools.qq_send_sticker({target:'private',id:'7',url:'https://example.invalid/x.png'},task),
  error=>error.code==='DELIVERY_PIN_UNAVAILABLE'&&error.transportInvoked===false);
 const noOrigin={id:'task:none',metadata:{allowedTools:['qq_send_sticker']}};
 await assert.rejects(()=>f.captured.options.agentTools.qq_send_sticker({target:'private',id:'7',url:'https://example.invalid/x.png'},noOrigin),
  error=>error.code==='DELIVERY_PIN_UNAVAILABLE');
 assert.equal(f.calls.length,0,'no tool transport may be reached');
});

test('origin task tool passes an explicit pin to the tool host and still rejects other targets',async t=>{
 const f=await boot(t);
 const origin=admitEvent(f.store,'task-origin','qq/private/10001');
 const task={id:'task:origin',originEventRef:{id:origin.id,revision:origin.revision},metadata:{allowedTools:['qq_send_sticker']}};
 const result=await f.captured.options.agentTools.qq_send_sticker({target:'private',id:'10001',url:'https://example.invalid/x.png'},task);
 assert.equal(result.message_id,123456);
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].context.pinTargets,['qq/private/10001']);
 assert.equal(f.calls[0].context.pinRequired,true);
 assert.equal(f.calls[0].context.allowedTools.includes('qq_send_sticker'),true);
 await assert.rejects(()=>f.captured.options.agentTools.qq_send_sticker({target:'group',id:'999',url:'https://example.invalid/x.png'},task),{code:'UNDELIVERED_TARGET'});
 assert.equal(f.calls.length,1,'rejected target must not reach the tool host transport');
});

test('action execution uses the persisted action args and the persisted source pin',async t=>{
 const f=await boot(t);
 const origin=admitEvent(f.store,'act-origin','qq/private/10001');
 const ws=f.store.execute({requestId:'ws',commands:[{op:'set_workspace',id:'ws:qq/private/10001',expectedRevision:0,scene:'qq/private/10001',focus:{id:'current',label:'current'},workingRefs:[],continuityRefs:[],actionRefs:[]}]}).at(-1);
 const proposed=f.store.execute({requestId:'propose',commands:[{op:'propose_action',id:'act:1',workspace:{id:ws.id,revision:ws.revision},tool:'qq_send_sticker',args:{target:'group',id:'999',url:'https://example.invalid/x.png'},inputRefs:[{id:origin.id,revision:origin.revision}]}]}).at(-1);
 assert.equal(proposed.status,'proposed');
 const claimed=f.store.execute({requestId:'claim',commands:[{op:'claim_action',action:{id:'act:1',revision:proposed.revision},claimId:'claim:1',worker:'test'}]}).at(-1);
 await assert.rejects(()=>f.captured.options.adapter.act({tool:'qq_send_sticker',scene:'qq/private/10001',args:{target:'group',id:'999',url:'https://example.invalid/x.png'},action:{id:'act:1',revision:claimed.revision}}),
  error=>error.code==='UNDELIVERED_TARGET'&&error.transportInvoked===false);
 assert.equal(f.calls.length,0);
 const proposed2=f.store.execute({requestId:'propose2',commands:[{op:'propose_action',id:'act:2',workspace:{id:ws.id,revision:ws.revision},tool:'qq_send_sticker',args:{target:'private',id:'10001',url:'https://example.invalid/x.png'},inputRefs:[{id:origin.id,revision:origin.revision}]}]}).at(-1);
 const claimed2=f.store.execute({requestId:'claim2',commands:[{op:'claim_action',action:{id:'act:2',revision:proposed2.revision},claimId:'claim:2',worker:'test'}]}).at(-1);
 const result=await f.captured.options.adapter.act({tool:'qq_send_sticker',scene:'qq/private/10001',args:{target:'private',id:'10001',url:'https://example.invalid/CALLER-ARGS.png'},action:{id:'act:2',revision:claimed2.revision}});
 assert.equal(result.message_id,123456);
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].args,{target:'private',id:'10001',url:'https://example.invalid/x.png'},'the persisted action args must be executed, not caller/outbox args');
 assert.deepEqual(f.calls[0].context.pinTargets,['qq/private/10001']);
});

test('followup authorization requires an admitted original event in its own basis',async t=>{
 const store=storeFixture(t);
 const same=admitEvent(store,'fu-same','qq/private/7');
 const other=admitEvent(store,'fu-other','qq/private/8');
 const scene=admitEvent(store,'fu-scene','qq/private/7',{origin:'observed'});
 assert.equal(followupDeliveryAuthorization({store,followup:{targetScene:'qq/private/7',basis:[{id:same.id,revision:same.revision}]}}),true);
 assert.throws(()=>followupDeliveryAuthorization({store,followup:{targetScene:'qq/private/9',basis:[{id:other.id,revision:other.revision}]}}),{code:'UNDELIVERED_TARGET'});
 assert.throws(()=>followupDeliveryAuthorization({store,followup:{targetScene:'qq/private/7',basis:[{id:'missing',revision:1}]}}),{code:'UNDELIVERED_TARGET'});
 assert.throws(()=>followupDeliveryAuthorization({store,followup:{targetScene:'qq/private/7',basis:[]}}),{code:'FOLLOWUP_TARGET'});
 assert.equal(followupDeliveryAuthorization({store,followup:{targetScene:'qq/private/7',basis:[{id:scene.id,revision:scene.revision}]}}),true);
});
test('proactive_contact action execution reuses the persisted action args and private target pin',async t=>{
 const f=await boot(t);
 const origin=admitEvent(f.store,'proactive-origin','qq/private/10001');
 const ws=f.store.execute({requestId:'ws-proactive',commands:[{op:'set_workspace',id:'ws:qq/private/10001',expectedRevision:0,scene:'qq/private/10001',focus:{id:'current',label:'current'},workingRefs:[],continuityRefs:[],actionRefs:[]}]}).at(-1);
 const proposed=f.store.execute({requestId:'propose-proactive',commands:[{op:'propose_action',id:'act:proactive:1',workspace:{id:ws.id,revision:ws.revision},tool:'proactive_contact',args:{targetScene:'qq/private/10001',text:'synthetic proactive'},inputRefs:[{id:origin.id,revision:origin.revision}]}]}).at(-1);
 assert.equal(proposed.status,'proposed');
 const claimed=f.store.execute({requestId:'claim-proactive',commands:[{op:'claim_action',action:{id:'act:proactive:1',revision:proposed.revision},claimId:'claim:proactive:1',worker:'test'}]}).at(-1);
 const result=await f.captured.options.adapter.act({tool:'proactive_contact',scene:'qq/private/10001',args:{targetScene:'qq/private/99999',text:'CALLER-ARGS'},action:{id:'act:proactive:1',revision:claimed.revision}});
 assert.equal(result.message_id,123456);
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].args,{targetScene:'qq/private/10001',text:'synthetic proactive'},'the persisted proactive action args must be executed');
 assert.deepEqual(f.calls[0].context.pinTargets,['qq/private/10001']);
});
test('proactive_contact pin derives only a persisted private action target with input material',()=>{
 const actionPatch=(id,args,inputRefs)=>({type:'action',id,revision:1,tool:'proactive_contact',args,inputRefs});
 const privateAction=actionPatch('action:proactive:1',{targetScene:'qq/private/7',text:'synthetic hello'},[{id:'event:e1',revision:1}]);
 const pin=deliveryPinForAction({store:fakeStore({[privateAction.id]:privateAction}),action:{id:privateAction.id}});
 assert.equal(DELIVERY_SEND_TOOLS.includes('proactive_contact'),true);
 assert.deepEqual(pin.allowedTargets,['qq/private/7']);
 assert.equal(pin.provenance.kind,'proactive-contact');
 assert.equal(assertPinnedDelivery({tool:'proactive_contact',args:privateAction.args,pin}),'qq/private/7');
 assert.throws(()=>assertPinnedDelivery({tool:'proactive_contact',args:{targetScene:'qq/private/8',text:'x'},pin}),{code:'UNDELIVERED_TARGET'});
 const group=actionPatch('action:proactive:group',{targetScene:'qq/group/9',text:'x'},[{id:'event:e1',revision:1}]);
 assert.throws(()=>deliveryPinForAction({store:fakeStore({[group.id]:group}),action:{id:group.id}}),{code:'PROACTIVE_GROUP_DISABLED'});
 const invalid=actionPatch('action:proactive:invalid',{targetScene:'qq/private/7:1',text:'x'},[{id:'event:e1',revision:1}]);
 assert.throws(()=>deliveryPinForAction({store:fakeStore({[invalid.id]:invalid}),action:{id:invalid.id}}),{code:'PROACTIVE_TARGET'});
 const noMaterial=actionPatch('action:proactive:no-material',{targetScene:'qq/private/7',text:'x'},[]);
 assert.throws(()=>deliveryPinForAction({store:fakeStore({[noMaterial.id]:noMaterial}),action:{id:noMaterial.id}}),{code:'PROACTIVE_CONTEXT'});
});
test('proactive_contact target derivation uses its explicit scene only',()=>{
 assert.equal(sendTargetScene('proactive_contact',{targetScene:'qq/private/7'}),'qq/private/7');
 assert.equal(sendTargetScene('proactive_contact',{targetScene:'qq/group/9'}),'qq/group/9');
 assert.equal(sendTargetScene('proactive_contact',{target:'private',id:'7'}),null);
 assert.equal(sendTargetScene('proactive_contact',{targetScene:'private:7'}),null);
});

test('live bootstrap can require the local brain token and keeps one Open-Life config source',async t=>{
 const f=fixture(t);
 await assert.rejects(()=>launchBrain({root:process.cwd(),env:{...f.env,JY_REQUIRE_BRAIN_TOKEN:'1'},dependencies:f.deps}),{code:'BRAIN_TOKEN_REQUIRED'});
 const saved=process.env.JY_OPEN_LIFE;delete process.env.JY_OPEN_LIFE;
 try{
  const opened=await boot(t,{env:{JY_OPEN_LIFE:'1'},dependencies:{lifePolicy:{assertOperationCurrent(){},beforeTask(){},canReflect:()=>false,recordReflection(){}}}});
  assert.equal(opened.captured.options.hostAllowedTools.includes('qq_send_message'),true);
  assert.equal(process.env.JY_OPEN_LIFE,'1','the resolved config must be the same source the tool host reads');
 }finally{if(saved===undefined)delete process.env.JY_OPEN_LIFE;else process.env.JY_OPEN_LIFE=saved;}
});

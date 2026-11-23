import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {keepAttention} from '../src/attention.mjs';
import {intentPacket,autonomyView} from '../src/intent-protocol.mjs';
import {canonical} from '../src/contracts.mjs';
import {saveActivity} from '../src/turn-activity.mjs';
import {executeTool} from '../tools/qq-connect/tools.mjs';

const continuity=()=>({changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{...keepAttention()}});
let now=1_000_000;
let script=[];
const seen=[];
function decide(packet){
  seen.push(packet);
  const next=script.shift();
  const value=typeof next==='function'?next(packet):next;
  if(packet.payload?.internal?.kind==='autonomy'){
    // The transport sends the intent wire, so the answer carries the wire packet id.
    const wire=intentPacket(packet);
    return JSON.stringify({packetId:wire.packetId,decision:value??{type:'none'}});
  }
  return JSON.stringify(value??{packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'wait',used:[],continuity:continuity()});
}
async function boot(t,{autonomy=true,cognition={}}={}){
  seen.length=0;script.length=0;
  const service=await startBrainService({token:'t',clock:()=>now,decide,rhythm:{minGapMs:1},autonomy,subjectTask:true,cognition,idleIntervalMs:3_600_000});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  return service;
}
const slotOf=n=>Math.max(1,Math.floor(n/3_600_000));

test('autonomy is completely inert when JY_AUTONOMY is off',async t=>{
  const service=await boot(t,{autonomy:false});
  const before=service.store.all('decision').length;
  const r=await service.autonomyTick({now});
  assert.equal(r.skipped,true);
  assert.equal(service.store.all('decision').length,before);
});

test('one autonomy opportunity per idle interval, decided by a fixed slot id',async t=>{
  const service=await boot(t);
  now=9_000_000; // slot 2
  script.push({type:'none'});
  const first=await service.autonomyTick({now});
  assert.equal(first.ok,true);
  assert.equal(first.slot,slotOf(now));
  assert.equal(service.store.read('decision:autonomy:'+slotOf(now))?.id,'decision:autonomy:'+slotOf(now));
  script.push({type:'none'});
  const second=await service.autonomyTick({now:now+1});
  assert.equal(second.skipped,true);
  assert.equal(seen.length,1);
});

test('autonomy uses the short protocol: no current, no QQ, bounded bytes',async t=>{
  const service=await boot(t);
  now=16_000_000; // slot 4
  script.push({type:'none'});
  await service.autonomyTick({now});
  const packet=seen.at(-1);
  assert.equal(packet.payload.current,undefined);
  assert.equal(packet.payload.internal.kind,'autonomy');
  assert.equal(packet.payload.continuity.subject.id,'jingyang');
  assert.ok(packet.payload.workspace.id.includes('agent/autonomy'));
  const wire=intentPacket(packet);
  assert.ok(wire.bytes<=16384,`wire bytes ${wire.bytes}`);
  assert.ok(!JSON.stringify(packet.payload).includes('qq/'));
});

test('minimal model answer {packetId, decision} is accepted',async t=>{
  const service=await boot(t);
  now=23_000_000;
  const captured=[];
  script.push(packet=>{captured.push(packet);return {type:'none'};});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const decision=service.store.read(r.decision.id);
  assert.equal(decision.stage??decision.input.stage,'reflection');
  assert.equal(decision.input.payload.internal.kind,'autonomy');
});

test('autonomy can create an Intent without starting a task',async t=>{
  const service=await boot(t);
  now=30_000_000;
  script.push({type:'intent',goal:'把桌面收一下',status:'open'});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const intents=[...service.store.all('intent')];
  assert.equal(intents.length,1);
  assert.equal(intents[0].goal,'把桌面收一下');
  assert.equal([...service.store.all('action')].length,0);
});

test('autonomy reply is refused before any transport',async t=>{
  const service=await boot(t);
  now=37_000_000;
  script.push({type:'reply',text:'在的'});
  await assert.rejects(()=>service.autonomyTick({now}),error=>error.code==='REPLY_NOT_ALLOWED');
});

test('autonomy may start an AgentTask, with receipt admission in the same commit',async t=>{
  const service=await boot(t);
  now=44_000_000;
  const slot=slotOf(now);
  script.push({type:'act',tool:'start_agent_task',args:{goal:'读一章书',plan:'读第一章'}});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const task=service.store.read('task:decision:autonomy:'+slot+':action');
  assert.equal(task?.status,'running');
  const action=service.store.read('decision:autonomy:'+slot+':action');
  assert.equal(action.status,'succeeded');
  assert.ok(action.receipt);
  assert.ok(service.store.subjectObservation('jingyang','task-receipt:decision:autonomy:'+slot+':action'));
});

test('an autonomy task cannot touch QQ, while a host task is not blocked by origin',async t=>{
  const service=await boot(t);
  now=45_000_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'读一章书',plan:'读第一章',allowedTools:['qq_list_groups','web_search']}});
  await service.autonomyTick({now});
  const task=[...service.store.all('agent_task')][0];
  assert.equal(task.metadata.origin,'autonomy');
  assert.deepEqual(task.metadata.allowedTools,['web_search']);
  await assert.rejects(()=>executeTool('qq_list_groups',{},{task}),error=>error.code==='TOOL_NOT_GRANTED');
  await assert.rejects(()=>executeTool('qq_send_sticker',{},{task}),error=>error.code==='TOOL_NOT_GRANTED');
  let hostError=null;
  try{await executeTool('qq_list_groups',{},{metadata:{allowedTools:['qq_list_groups']}});}catch(error){hostError=error;}
  assert.notEqual(hostError?.code,'TOOL_NOT_GRANTED');
});

test('a dispatched autonomy request without output is UNKNOWN and is not resent',async t=>{
  const service=await boot(t);
  now=200_000_000;
  script.push(()=>{throw Object.assign(new Error('transport died'),{code:'TRANSPORT_DOWN'});});
  await assert.rejects(()=>service.autonomyTick({now}),error=>error.code==='TRANSPORT_DOWN');
  assert.equal(seen.length,1);
  await assert.rejects(()=>service.autonomyTick({now:now+1}),error=>error.code==='TURN_OUTCOME_UNKNOWN');
  assert.equal(seen.length,1);
});

test('a captured autonomy answer is reused after a crash without another model call',async t=>{
  const service=await boot(t);
  now=300_000_000;
  script.push(()=>{throw Object.assign(new Error('transport died'),{code:'TRANSPORT_DOWN'});});
  await assert.rejects(()=>service.autonomyTick({now}),error=>error.code==='TRANSPORT_DOWN');
  assert.equal(seen.length,1);
  const record=[...service.store.all('extension_record')].find(r=>r.stateType==='turn-activity');
  const output=JSON.stringify({packetId:intentPacket(record.value.packet).packetId,decision:{type:'none'}});
  saveActivity(service.store,record,{subject:'jingyang',workspace:{id:'ws:agent/autonomy'},value:{...record.value,phase:'captured',output}});
  const r=await service.autonomyTick({now:now+1});
  assert.equal(r.ok,true);
  assert.equal(seen.length,1);
});

test('QQ inbox outranks autonomy: nothing is decided while a chat message waits',async t=>{
  const service=await boot(t);
  now=51_000_000;
  await fetch(service.url+'/v1/observe',{method:'POST',headers:{'content-type':'application/json','x-brain-token':'t'},body:JSON.stringify({source:'qq',key:'private:1',text:'在吗'})});
  const r=await service.autonomyTick({now});
  assert.equal(r.skipped,true);
  assert.equal(r.reason,'pending');
  assert.equal(seen.length,0);
});

test('task step runs through the full protocol and can finish',async t=>{
  const service=await boot(t);
  now=58_000_000;
  const slot=slotOf(now);
  script.push({type:'act',tool:'start_agent_task',args:{goal:'读一章书'}});
  await service.autonomyTick({now});
  script.push(packet=>({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'读完了'}}}],selected:'f',summary:'完成',used:[],continuity:continuity()}));
  const step=await service.agentTick();
  assert.equal(step.ok,true);
  assert.equal(service.store.read('task:decision:autonomy:'+slot+':action')?.status,'done');
});


test('repeating the same slot never calls the model twice',async t=>{
  const service=await boot(t);
  now=65_000_000;
  script.push({type:'none'});
  const first=await service.autonomyTick({now});
  assert.equal(first.ok,true);
  const calls=seen.length;
  const second=await service.autonomyTick({now});
  assert.equal(second.skipped,true);
  assert.equal(second.reason,'cadence');
  assert.equal(seen.length,calls);
  const decisions=[...service.store.all('decision')].filter(d=>String(d.id).startsWith('decision:autonomy:'));
  assert.equal(decisions.length,1);
});

test('an Intent can be modified by handle without starting work',async t=>{
  const service=await boot(t);
  now=72_000_000;
  script.push({type:'intent',goal:'tidy desk',status:'open',dueAt:now+1000});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'intent',handle,status:'pursuing',nextAction:'stack books'};});
  const r=await service.autonomyTick({now});
  assert.equal(r.kind,'continuation');
  const intents=[...service.store.all('intent')];
  assert.equal(intents.length,1);
  assert.equal(intents[0].status,'pursuing');
  assert.equal(intents[0].nextAction,'stack books');
  assert.equal([...service.store.all('action')].length,0);
});

test('an Intent can be abandoned and stops asking for continuation',async t=>{
  const service=await boot(t);
  now=79_600_000;
  script.push({type:'intent',goal:'old plan',status:'open',dueAt:now});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'intent',handle,status:'abandoned'};});
  const r=await service.autonomyTick({now});
  assert.equal(r.kind,'continuation');
  const intent=[...service.store.all('intent')][0];
  assert.equal(intent.status,'abandoned');
  now+=3_600_000;
  script.push({type:'none'});
  const idle=await service.autonomyTick({now});
  assert.equal(idle.kind,'idle');
});

test('a committed autonomy start action is recovered when execution was interrupted',async t=>{
  const service=await boot(t);
  now=90_000_000;
  const slot=slotOf(now)+5;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'recover me'}});
  const res=await service.autonomyDriver().autonomyStep({now,opportunity:slot,kind:'idle'});
  assert.ok(res.actionOut,'autonomy must produce an action');
  const actionId=res.actionOut.action.id;
  assert.equal(service.store.read(actionId).status,'proposed');
  now+=3_600_000;
  script.push({type:'none'});
  await service.autonomyTick({now});
  assert.equal(service.store.read(actionId).status,'succeeded');
  assert.ok(service.store.read('task:'+actionId));
});

test('task steps advance automatically and can replan then finish',async t=>{
  const service=await boot(t);
  now=100_000_000;
  const slot=slotOf(now);
  script.push({type:'act',tool:'start_agent_task',args:{goal:'two steps',plan:'one'}});
  await service.autonomyTick({now});
  const id='task:decision:autonomy:'+slot+':action';
  script.push(packet=>({packetId:packet.packetId,options:[{id:'r',kind:'act',payload:{tool:'task_replan',args:{plan:'two'}}}],selected:'r',summary:'replan',used:[],continuity:continuity()}));
  const first=await service.agentTick();
  assert.equal(first.ok,true);
  assert.equal(service.store.read(id).plan,'two');
  assert.equal(service.store.read(id).status,'running');
  script.push(packet=>({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'all done'}}}],selected:'f',summary:'finish',used:[],continuity:continuity()}));
  const second=await service.agentTick();
  assert.equal(second.ok,true);
  assert.equal(service.store.read(id).status,'done');
});

test('modifying the bound Intent in a task step keeps the task running',async t=>{
  const service=await boot(t);
  now=108_000_000;
  script.push({type:'intent',goal:'bound goal',status:'open',dueAt:now});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'act',tool:'start_agent_task',args:{goal:'bound goal',intentId:handle}};});
  const started=await service.autonomyTick({now});
  const intentId=[...service.store.all('intent')][0].id;
  const taskId=started.decision.id+':action';
  assert.ok(service.store.read('task:'+taskId)?.intentRef);
  script.push(packet=>({packetId:packet.packetId,options:[{id:'i',kind:'intent',payload:{intentId,status:'pursuing',nextAction:'keep going'}}],selected:'i',summary:'update intent',used:[],continuity:continuity()}));
  const step=await service.agentTick();
  assert.equal(step.ok,true);
  const task=service.store.read('task:'+taskId);
  assert.equal(task.status,'running');
  const intent=service.store.read(intentId);
  assert.equal(intent.status,'pursuing');
  assert.equal(task.intentRef.revision,intent.revision);
});

test('deferring the bound Intent pauses the task and resume rebases it',async t=>{
  const service=await boot(t);
  now=116_000_000;
  script.push({type:'intent',goal:'pause me',status:'open',dueAt:now});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'act',tool:'start_agent_task',args:{goal:'pause me',intentId:handle}};});
  const started=await service.autonomyTick({now});
  const intentId=[...service.store.all('intent')][0].id;
  const taskId='task:'+started.decision.id+':action';
  script.push(packet=>({packetId:packet.packetId,options:[{id:'d',kind:'intent',payload:{intentId,status:'deferred'}}],selected:'d',summary:'later',used:[],continuity:continuity()}));
  const step=await service.agentTick();
  assert.equal(step.ok,true);
  assert.equal(service.store.read(taskId).status,'paused');
  const intent=service.store.read(intentId);
  service.store.execute({requestId:'test:intent:pursue',commands:[{op:'put_intent',id:intent.id,expectedRevision:intent.revision,value:{...intent,status:'pursuing',nextAction:'after break'}}]});
  const resumed=await service.resumeAgentTask(taskId);
  assert.equal(resumed.ok,true);
  assert.equal(service.store.read(taskId).status,'running');
  assert.equal(service.store.read(taskId).intentRef.revision,service.store.read(intentId).revision);
});

test('completing the bound Intent cancels the task and stops further steps',async t=>{
  const service=await boot(t);
  now=124_000_000;
  script.push({type:'intent',goal:'finish me',status:'open',dueAt:now});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'act',tool:'start_agent_task',args:{goal:'finish me',intentId:handle}};});
  const started=await service.autonomyTick({now});
  const intentId=[...service.store.all('intent')][0].id;
  const taskId='task:'+started.decision.id+':action';
  script.push(packet=>({packetId:packet.packetId,options:[{id:'c',kind:'intent',payload:{intentId,status:'completed'}}],selected:'c',summary:'done',used:[],continuity:continuity()}));
  const step=await service.agentTick();
  assert.equal(step.ok,true);
  assert.equal(service.store.read(taskId).status,'cancelled');
  assert.equal(service.store.read(intentId).status,'completed');
  const after=await service.agentTick();
  assert.equal(after.skipped,true);
});


test('a cancelled task does not execute another tool action',async t=>{
  const service=await boot(t);
  now=132_000_000;
  script.push({type:'intent',goal:'stop work',status:'open',dueAt:now});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push(packet=>{const wire=intentPacket(packet);const handle=Object.keys(wire.handles).find(k=>k.startsWith('G'));return {type:'act',tool:'start_agent_task',args:{goal:'stop work',intentId:handle}};});
  const started=await service.autonomyTick({now});
  const intentId=[...service.store.all('intent')][0].id;
  const taskId='task:'+started.decision.id+':action';
  script.push(packet=>({packetId:packet.packetId,options:[{id:'c',kind:'intent',payload:{intentId,status:'abandoned'}}],selected:'c',summary:'stop',used:[],continuity:continuity()}));
  await service.agentTick();
  assert.equal(service.store.read(taskId).status,'cancelled');
  const before=[...service.store.all('action')].length;
  const again=await service.agentTick();
  assert.equal(again.skipped,true);
  assert.equal([...service.store.all('action')].length,before);
});

test('task steps keep apperception in the subject packet',async t=>{
  const service=await boot(t,{cognition:{apperceptionV1:true}});
  now=140_000_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'apperception check'}});
  await service.autonomyTick({now});
  let apperception=null;
  script.push(packet=>{apperception=packet.payload.apperceptionV1;return {packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'ok'}}}],selected:'f',summary:'finish',used:[],continuity:continuity()};});
  await service.agentTick();
  assert.ok(apperception);
});

test('an idle tick that already decided writes no extra decision or packet',async t=>{
  const service=await boot(t);
  now=148_000_000;
  script.push({type:'none'});
  await service.autonomyTick({now});
  const decisions=[...service.store.all('decision')].length;
  const actions=[...service.store.all('action')].length;
  const again=await service.autonomyTick({now});
  assert.equal(again.skipped,true);
  assert.equal([...service.store.all('decision')].length,decisions);
  assert.equal([...service.store.all('action')].length,actions);
});

test('autonomy view stays JSON-safe when stored states omit optional fields',()=>{
  const base={payload:{now:1000,identity:'小栈',materials:[{ref:{id:'event:e1',revision:1},aspects:['experience']}],allowedActionTools:['start_agent_task'],continuity:{foreground:[{ref:{id:'state:s1',revision:1},kind:'feeling',body:'有点困'}],recalled:[],intents:[],tasks:[]}}};
  const view=autonomyView(base);
  assert.doesNotThrow(()=>canonical({view:view.view,handles:view.handles}));
  assert.equal('mind' in view.handles.S1,false);
  assert.equal('body' in view.view.materials[0],true);
  assert.equal(view.view.materials[0].body,null);
});

test('missing allowedTools uses host defaults; an explicit empty list stays empty',async t=>{
  const service=await boot(t,{autonomy:false});
  service.autonomyDriver();
  service.store.execute({requestId:'seed-default-tools',commands:[{op:'propose_action',id:'test-default-tools:action',workspace:{id:'ws:agent/autonomy',revision:1},tool:'start_agent_task',args:{goal:'host default tools'},inputRefs:[]}]});
  await service.executeAction({id:'test-default-tools:action'});
  const task=service.store.read('task:test-default-tools:action');
  assert.deepEqual(task.metadata.allowedTools,['qq_list_friends','qq_list_groups','qq_list_stickers','anchor_recall','attention_status','web_search']);
  assert.equal(task.intentRef,null);
});

test('an explicit empty allowedTools keeps zero task tools but host task controls still work',async t=>{
  const service=await boot(t);
  now=210_000_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'empty tool task',allowedTools:[]}});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const taskId='task:'+r.decision.id+':action';
  assert.deepEqual(service.store.read(taskId).metadata.allowedTools,[]);
  script.push(packet=>({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'done without tools'}}}],selected:'f',summary:'finish',used:[],continuity:continuity()}));
  const step=await service.agentTick();
  assert.equal(step.ok,true);
  assert.equal(service.store.read(taskId).status,'done');
});

test('a string-encoded empty tool list is compiled before attempt and action, keeping zero tools',async t=>{
  const service=await boot(t);
  now=220_000_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'serialized empty tools',allowedTools:'[]'}});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const slot=r.slot,actionId='decision:autonomy:'+slot+':action';
  const action=service.store.read(actionId);
  assert.equal(action.status,'succeeded');
  assert.deepEqual(action.args.allowedTools,[]);
  const attempt=service.store.read('decision:autonomy:'+slot+':attempt');
  assert.equal(attempt.status,'adopted');
  assert.deepEqual(attempt.output.options[0].payload.args.allowedTools,[]);
  const decision=service.store.read('decision:autonomy:'+slot);
  assert.deepEqual(decision.output.options[0].payload.args.allowedTools,[]);
  assert.deepEqual(service.store.read('task:'+actionId).metadata.allowedTools,[]);
  const record=[...service.store.all('extension_record')].find(x=>x.stateType==='proposal-normalization'&&x.value?.diagnostics?.some(d=>d.code==='STRING_ARRAY_PARSED'));
  assert.ok(record,'normalization must remain auditable');
  assert.equal(record.value.diagnostics.find(d=>d.code==='STRING_ARRAY_PARSED').originalValue,'[]');
});

test('a serialized string array is parsed without widening autonomy grants',async t=>{
  const service=await boot(t);
  now=225_000_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'serialized mixed tools',allowedTools:'["web_search","qq_list_groups"]'}});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const action=service.store.read('decision:autonomy:'+r.slot+':action');
  assert.deepEqual(action.args.allowedTools,['web_search','qq_list_groups']);
  assert.deepEqual(service.store.read('task:'+action.id).metadata.allowedTools,['web_search']);
});

test('illegal allowedTools values are rejected before any Action or Decision exists',async t=>{
  for(const [index,value] of ['not-json',[1],5].entries()){
    const service=await boot(t);
    now=230_000_000+index*3_600_000;
    script.push({type:'act',tool:'start_agent_task',args:{goal:'invalid tools '+index,allowedTools:value}});
    const before=[...service.store.all('action')].length;
    await assert.rejects(()=>service.autonomyTick({now}),error=>error.code==='TOOL_ARGUMENTS'&&error.transportInvoked===false);
    assert.equal([...service.store.all('action')].length,before);
    assert.equal([...service.store.all('agent_task')].length,0);
    assert.equal(service.store.read('decision:autonomy:'+slotOf(now)),null);
    assert.equal(service.store.read('decision:autonomy:'+slotOf(now)+':attempt')?.status,'captured');
  }
});

test('a deterministic preflight failure settles once and never re-enters recovery',async t=>{
  const service=await boot(t);
  now=240_000_000;
  service.autonomyDriver();
  const slot=slotOf(now),actionId='decision:autonomy:'+slot+':action';
  service.store.execute({requestId:'seed-bad-action',commands:[{op:'propose_action',id:actionId,workspace:{id:'ws:agent/autonomy',revision:1},tool:'start_agent_task',args:{goal:'legacy bad tools',allowedTools:'[]'},inputRefs:[]}]});
  script.push({type:'none'});
  const first=await service.autonomyTick({now});
  assert.equal(first.ok,true);
  const action=service.store.read(actionId);
  assert.equal(action.status,'failed');
  assert.ok(action.receipt);
  assert.match(service.store.read(action.receipt.id,action.receipt.revision).body,/TOOL_ARGUMENTS/);
  assert.equal([...service.store.all('agent_task')].length,0);
  const receipts=()=>[...service.store.all('event')].filter(e=>e.id==='host-action:'+actionId).length;
  assert.equal(receipts(),1);
  assert.equal(service.store.debugHealth().failedWrites,0,'failure diagnostic must satisfy the existing metadata contract');
  await service.autonomyTick({now:now+1});
  assert.equal(receipts(),1);
  assert.equal(service.store.read(actionId).status,'failed');
});

test('an autonomy failure without proven no-transport evidence is interrupted, not failed',async t=>{
  const service=await boot(t);
  now=250_000_000;
  service.autonomyDriver();
  const slot=slotOf(now),actionId='decision:autonomy:'+slot+':action';
  service.store.execute({requestId:'seed-ambiguous-action',commands:[{op:'propose_action',id:actionId,workspace:{id:'ws:agent/autonomy',revision:1},tool:'start_agent_task',args:{goal:'missing intent',intentId:'intent:jingyang:missing'},inputRefs:[]}]});
  script.push({type:'none'});
  await service.autonomyTick({now});
  const action=service.store.read(actionId);
  assert.equal(action.status,'interrupted');
  assert.match(service.store.read(action.receipt.id,action.receipt.revision).body,/no automatic retry/);
  assert.equal([...service.store.all('agent_task')].length,0);
});

test('a task without an explicit goal handle stays independent instead of matching text',async t=>{
  const service=await boot(t);
  now=260_000_000;
  script.push({type:'intent',goal:'圣诞节那天第一个跟他说生日快乐',status:'open'});
  await service.autonomyTick({now});
  now+=3_600_000;
  script.push({type:'act',tool:'start_agent_task',args:{goal:'找机会进MC世界看看'}});
  const r=await service.autonomyTick({now});
  assert.equal(r.ok,true);
  const task=service.store.read('task:'+r.decision.id+':action');
  assert.equal(task.intentRef,null);
  assert.equal([...service.store.all('intent')].length,1);
});

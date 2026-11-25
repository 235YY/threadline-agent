// Phase 3.2 task-source recovery (R1/R2/R4; R3 remains blocked): end-to-end seams.
// No model/network/QQ/production. Uses the real store/journal/service surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {affectTurnId} from '../src/affect-contract.mjs';
import {callWorker} from '../tools/affect-shadow/bridge.mjs';
import {canonical} from '../src/contracts.mjs';

const T=1_800_000_000_000;
const HEADERS={'content-type':'application/json','x-brain-token':'brain-token','x-jingyang-control':'op-token'};
const attention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const taskReply=result=>({packetId:null,options:[{id:'x',kind:'act',payload:{tool:'task_finish',args:{result}}}],selected:'x',
  summary:'captured task step',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});

async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'jy-ts-recovery-'));
  const journal=new RequestJournal(join(dir,'requests.json'));
  const state={calls:0,plan:()=>{throw Object.assign(Error('unexpected model call'),{code:'PROBE_MODEL_CALL'});}};
  const decide=p=>{state.calls++;return state.plan(p);};
  decide.requestJournal=journal;
  const service=await startBrainService({port:0,token:'brain-token',storePath:':memory:',heartbeatMs:0,subjectTask:true,
    shutdownControl:{token:'op-token',stop:async()=>{}},decide,agentTools:{},allowedActionTools:[]});
  t.after(async()=>{try{await new Promise(r=>service.server.close(r));}catch{}try{service.close();}catch{}try{journal.close();}catch{}try{rmSync(dir,{recursive:true,force:true});}catch{}});
  const post=async(path,body)=>{const res=await fetch(service.url+path,{method:'POST',headers:HEADERS,body:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};};
  return {service,store:service.store,journal,state,post};
}

function seedEvent(f,id='task-source-event'){
  f.store.execute({requestId:'seed-event:'+id,commands:[
    {op:'append_event',id,body:'浠诲姟鏉ユ簮浜嬩欢',origin:'reported',actor:'u',scene:'agent/task',source:{system:'probe',key:id},occurredAt:T},
    {op:'admit_subject_event',subjectId:'jingyang',event:{id,revision:1}}]});
  return {id,revision:1};
}

// Build and durably capture the exact task-step packet+proposal a provider return
// would leave behind if the process died before the commit transaction.
async function seedCapturedAttempt(f,task,{eventId='task-source-event',result='captured done'}={}){
  await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'preview',evidence:{operator:'seed'}});
  const scene=task.target??'agent/task',workspace=f.store.read('ws:'+scene);
  const event=seedEvent(f,eventId);
  const session=new ContinuitySession({store:f.store,subjectId:'jingyang',attention:true,maxForeground:16});
  const taskContext={id:task.id,controlRevision:task.controlRevision??0,leaseToken:task.lease?.token??null,interruptCursor:task.interruptCursor??0,
    goal:task.goal,plan:task.plan,status:task.status,target:task.target??null,threadId:task.threadId??null,processId:task.processId??null,
    stepCount:task.stepCount,budget:task.budget??null,observations:[],earlierObservations:[],observationRefs:[],interrupts:[],
    controlTools:['task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect']};
  const packet=session.prepare({instructionSuffix:'task step captured probe',currentEvent:event,workspace:{id:workspace.id,revision:workspace.revision},
    identity:'',style:'',materials:[],previousDecisions:[],investigationContinuityV1:false,experienceLearningV1:false,lookupResults:[],
    mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,algorithmV011:false,apperceptionV1:false,
    subjectiveDomains:false,subjectiveMemory:false,subjectiveMemoryV2:false,taskThreads:false,anchorDirectory:false,socialContext:false,
    localLookupPolicy:{maxReads:1,maxHits:1},allowedActionTools:['task_finish'],budgetBytes:131072,now:T,capabilities:null,task:taskContext});
  const output={...taskReply(result),packetId:packet.packetId};
  const decisionId='task-decision:'+packet.packetId;
  f.store.execute({requestId:'seed-capture:'+decisionId,commands:[{op:'capture_decision_attempt',id:decisionId+':attempt',
    decisionId,requestKey:decisionId,invocationKey:null,input:packet,output}]});
  const source=f.journal.taskSource({subject:'jingyang',taskId:task.id,step:task.stepCount}),rowId='turn:'+packet.packetId;
  f.journal.reserve(rowId,'f'.repeat(64),10,{source,packetId:packet.packetId});
  f.journal.dispatch(rowId);f.journal.settle(rowId,{upperMicros:10});f.journal.attachOutput(rowId,JSON.stringify(output));
  return {packet,output,decisionId,rowId,source};
}

function advanceSubject(f){
  const event=seedEvent(f,'advance-event-'+Math.random().toString(36).slice(2));
  const session=new ContinuitySession({store:f.store,subjectId:'jingyang',attention:true,maxForeground:16});
  const workspace=f.store.read('ws:agent/task');
  const packet=session.prepare({currentEvent:event,workspace:{id:workspace.id,revision:workspace.revision},identity:'',style:'',materials:[],
    previousDecisions:[],lookupResults:[],mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
    localLookupPolicy:{maxReads:1,maxHits:1},allowedActionTools:[],budgetBytes:131072,now:T+10});
  const output={packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'advance',used:[],
    continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}};
  session.commit({packet,output:JSON.stringify(output),requestId:'advance:'+packet.packetId,decisionId:'advance:'+packet.packetId});
}

test('R1: committed-step capture is adopted by runAgentStep with zero model calls',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'captured task',metadata:{allowedTools:[]}});
  const capture=await seedCapturedAttempt(f,f.store.read(task.id),{result:'captured finish'});
  const callsBefore=f.state.calls;
  const step=await f.service.stepAgentTask(task.id);
  assert.equal(step.status,'done');
  assert.equal(f.state.calls,callsBefore,'captured attempt must not call the model');
  assert.ok(f.store.read(capture.decisionId),'captured decision adopted');
  assert.equal(f.journal.find(capture.rowId).validation?.status,'accepted');
  assert.equal(f.journal.blocks(capture.source),false);
});

test('R1: stale subject/frame refs are not adopted; source stays blocked and classified',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'stale capture task',metadata:{allowedTools:[]}});
  const capture=await seedCapturedAttempt(f,f.store.read(task.id),{eventId:'stale-event'});
  advanceSubject(f);
  f.state.plan=()=>{throw Object.assign(Error('original source unresolved'),{code:'SOURCE_REQUEST_BLOCKED'});};
  const callsBefore=f.state.calls;
  const step=await f.service.stepAgentTask(task.id);
  assert.equal(step.ok,false);
  assert.equal(f.state.calls,callsBefore+1,'stale capture must fall through to the blocked path, not adopt');
  const blocked=f.store.read(task.id);
  assert.equal(blocked.status,'blocked');
  assert.match(String(blocked.blockedReason),/^TASK_MODEL_SOURCE_BLOCKED:/);
  assert.equal(blocked.blockedReason,`TASK_MODEL_SOURCE_BLOCKED:${capture.rowId}`);
  assert.equal(f.store.read(capture.decisionId),null,'stale capture is not adopted');
  assert.equal(f.journal.find(capture.rowId).validation??null,null);
  // Resume without operator evidence is refused and leaves the task blocked.
  const resume=await f.post('/v1/tasks/'+encodeURIComponent(task.id)+'/resume',{});
  assert.equal(resume.status,400);
  assert.equal(resume.body.error,'TASK_SOURCE_OPERATOR_REQUIRED');
  assert.equal(f.store.read(task.id).status,'blocked');
  // Blocked tasks never auto-step: no model calls and no journal reservation growth.
  const rows=f.journal.data.requests.length,calls=f.state.calls;
  for(let i=0;i<3;i++)await f.service.agentTick();
  assert.equal(f.state.calls,calls,'blocked task-source task must not be retried by ticks');
  assert.equal(f.journal.data.requests.length,rows,'blocked task-source task must not reserve requests');
});

test('R2: operator recover-capture adopts with zero calls, host-side artifact, deterministic replay',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'operator capture task',metadata:{allowedTools:[]}});
  const capture=await seedCapturedAttempt(f,f.store.read(task.id),{eventId:'operator-capture-event',result:'operator captured finish'});
  f.state.plan=()=>{throw Object.assign(Error('recover-capture must not call model'),{code:'PROBE_MODEL_CALL'});};
  const callsBefore=f.state.calls;
  const recovered=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'recover-capture',
    evidence:{operator:'test-engineer',reason:'captured attempt replay'}});
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.recovered,true,JSON.stringify(recovered.body));
  assert.equal(f.state.calls,callsBefore,'recover-capture performs no model call');
  assert.equal(f.store.read(task.id).status,'done');
  assert.ok(recovered.body.artifact&&f.store.read(recovered.body.artifact)?.stateType==='task-source-review');
  // Host-side evidence stays out of the subject inbox.
  assert.equal(f.store.subjectObservation('jingyang',recovered.body.artifact),null);
  const replay=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'recover-capture',
    evidence:{operator:'test-engineer',reason:'captured attempt replay'}});
  assert.equal(replay.status,200);
  assert.equal(replay.body.replayed,true);
  assert.equal(f.store.read(task.id).status,'done');
});

test('R2: recover-capture refuses stale subject/frame with no task/journal writes',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'stale operator capture',metadata:{allowedTools:[]}});
  await seedCapturedAttempt(f,f.store.read(task.id),{eventId:'stale-operator-event'});
  advanceSubject(f);
  const before={task:f.store.read(task.id).revision,extensions:[...f.store.all('extension_record')].filter(r=>r.stateType==='task-source-review').length,journal:f.journal.data.requests.length};
  const refused=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'recover-capture',evidence:{operator:'test'}});
  assert.equal(refused.status,400);
  assert.equal(refused.body.error,'TASK_CAPTURE_UNAVAILABLE');
  assert.equal(f.store.read(task.id).revision,before.task,'task unchanged on stale capture refusal');
  assert.equal([...f.store.all('extension_record')].filter(r=>r.stateType==='task-source-review').length,before.extensions,'no host artifact written');
  assert.equal(f.journal.data.requests.length,before.journal,'journal unchanged');
});

test('R4: operator close terminalizes failed with zero calls and leaves the journal intact',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'close me',metadata:{allowedTools:[]}});
  seedEvent(f,'close-event');
  const beforeRevision=f.store.read(task.id).revision,control=f.store.read(task.id).controlRevision??0,journalBytes=JSON.stringify(f.journal.data),calls=f.state.calls;
  const closed=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'close',evidence:{operator:'test',reason:'operator closed'}});
  assert.equal(closed.status,200);
  const after=f.store.read(task.id);
  assert.equal(after.status,'failed');
  assert.deepEqual(after.result,{outcome:'operator-closed',reason:'operator closed'});
  assert.equal(after.controlRevision,control+1);
  assert.ok(after.revision>beforeRevision);
  assert.equal(f.state.calls,calls,'close performs no model call');
  assert.equal(JSON.stringify(f.journal.data),journalBytes,'journal untouched by close');
  const replay=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'close',evidence:{operator:'test',reason:'operator closed'}});
  assert.equal(replay.status,200);
  assert.equal(replay.body.replayed,true);
  assert.equal(f.store.read(task.id).revision,(await f.service.listAgent()).find(x=>x.id===task.id).revision,'replay does not append a revision');
});

test('R3 remains blocked; preview advertises retry blocked and no second paid path exists',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'no retry',metadata:{allowedTools:[]}});
  const preview=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'preview',evidence:{operator:'test'}});
  assert.equal(preview.status,200);
  assert.equal(preview.body.retry.blocked,true);
  assert.ok(preview.body.transitions.includes('recover-capture'));
  assert.ok(preview.body.transitions.includes('close'));
  const retry=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'retry',evidence:{operator:'test'}});
  assert.equal(retry.status,400);
  assert.equal(retry.body.error,'OPERATOR_TRANSITION');
  assert.equal(f.state.calls,0);
});

test('no new table/schema: store snapshot stays schema 12 and task-source routes use no new command',async t=>{
  const f=await fixture(t),task=await f.service.createAgentTask({goal:'schema probe',metadata:{allowedTools:[]}});
  assert.equal(f.service.store.snapshot().schemaVersion,12);
  const agentTaskTypes=[...f.service.store.all('agent_task')].map(x=>x.type);
  assert.ok(agentTaskTypes.every(x=>x==='agent_task'));
  const preview=await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'preview',evidence:{operator:'test'}});
  assert.equal(preview.status,200);
  assert.equal(f.service.store.snapshot().schemaVersion,12);
});

// ---------------------------------------------------------------------------
// IR-05: affect-enabled R1. Real R1 shape = affect_turn.rawOutput keeps the
// model appraisal; decision_attempt.output is the same proposal with
// affectAppraisal stripped; the journal row is the settled model output.
// The R1 path must adopt it through AffectSession.commitCaptured with 0 LLM
// calls (worker replay allowed), journal accepted, never MODEL_OUTPUT_INVALID.
async function affectFixture(t){
  const dir=mkdtempSync(join(tmpdir(),'jy-ts-affect-recovery-'));
  const journal=new RequestJournal(join(dir,'requests.json'));
  const state={calls:0,plan:()=>{throw Object.assign(Error('unexpected model call'),{code:'PROBE_MODEL_CALL'});}};
  const decide=p=>{state.calls++;return state.plan(p);};decide.requestJournal=journal;
  const workerState={down:false,calls:0};
  const worker=async input=>{workerState.calls++;if(workerState.down)throw Object.assign(Error('synthetic affect worker unavailable'),{code:'WORKER_UNAVAILABLE'});return callWorker(input);};
  const sessionFactory=args=>new AffectSession({...args,worker,config:{timezoneMinutes:480,parameters:{}},fusion:false});
  const service=await startBrainService({port:0,token:'brain-token',storePath:':memory:',heartbeatMs:0,subjectTask:true,clock:()=>T,
    shutdownControl:{token:'op-token',stop:async()=>{}},decide,agentTools:{},allowedActionTools:[],sessionFactory});
  t.after(async()=>{try{await new Promise(r=>service.server.close(r));}catch{}try{service.close();}catch{}try{journal.close();}catch{}try{rmSync(dir,{recursive:true,force:true});}catch{}});
  const post=async(path,body)=>{const res=await fetch(service.url+path,{method:'POST',headers:HEADERS,body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  return {service,store:service.store,journal,state,workerState,post};
}

async function seedAffectCapturedAttempt(f,task,{eventId='affect-task-event',result='affect captured finish',turnStatus=null}={}){
  await f.post('/v1/operator/effect',{type:'task-source',id:task.id,transition:'preview',evidence:{operator:'seed'}});
  const scene=task.target??'agent/task',workspace=f.store.read('ws:'+scene),event=seedEvent(f,eventId);
  const setup=new AffectSession({store:f.store,subjectId:'jingyang',attention:true,maxForeground:16,worker:input=>callWorker(input),
    config:{timezoneMinutes:480,parameters:{}},clock:()=>T,fusion:false,requestJournal:f.journal});
  const taskContext={id:task.id,controlRevision:task.controlRevision??0,leaseToken:task.lease?.token??null,interruptCursor:task.interruptCursor??0,
    goal:task.goal,plan:task.plan,status:task.status,target:task.target??null,threadId:task.threadId??null,processId:task.processId??null,
    stepCount:task.stepCount,budget:task.budget??null,observations:[],earlierObservations:[],observationRefs:[],interrupts:[],
    controlTools:['task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect']};
  const packet=await setup.prepare({instructionSuffix:'affect task step capture',currentEvent:event,workspace:{id:workspace.id,revision:workspace.revision},
    identity:'',style:'',materials:[],previousDecisions:[],investigationContinuityV1:false,experienceLearningV1:false,lookupResults:[],
    mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,algorithmV011:false,apperceptionV1:false,
    subjectiveDomains:false,subjectiveMemory:false,subjectiveMemoryV2:false,taskThreads:false,anchorDirectory:false,socialContext:false,
    localLookupPolicy:{maxReads:1,maxHits:1},allowedActionTools:['task_finish'],budgetBytes:131072,now:T,capabilities:null,task:taskContext});
  const core={...taskReply(result),packetId:packet.packetId};
  const rawObj=JSON.parse(JSON.stringify(core));
  rawObj.affectAppraisal={source_refs:[event],appraisals:[{weight:1,value:{event:'task-step',summary:'affect captured task step',valence:.2,intensity:.6,relevance:.7,agency:'circumstance'}}]};
  const raw=canonical(rawObj);
  if(turnStatus==='prepared'){
    // leave the affect turn prepared: no adoptable capture exists
  }else if(turnStatus==='dispatched'||turnStatus==='uncertain'){
    const turn=f.store.read(affectTurnId(packet));
    f.store.execute({requestId:'seed-affect-dispatched:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'}]});
    if(turnStatus==='uncertain'){const dispatched=f.store.read(affectTurnId(packet));f.store.execute({requestId:'seed-affect-uncertain:'+packet.packetId,commands:[{op:'affect_turn',id:dispatched.id,expectedRevision:dispatched.revision,status:'uncertain',error:'PROBE_UNCERTAIN',failurePhase:'invocation',transportInvoked:null}]});}
  }else await setup.invoke(packet,()=>raw);
  const decisionId='task-decision:'+packet.packetId;
  f.store.execute({requestId:'seed-affect-capture:'+decisionId,commands:[{op:'capture_decision_attempt',id:decisionId+':attempt',decisionId,requestKey:decisionId,invocationKey:null,input:packet,output:core}]});
  const source=f.journal.taskSource({subject:'jingyang',taskId:task.id,step:task.stepCount}),rowId='turn:'+packet.packetId;
  f.journal.reserve(rowId,'f'.repeat(64),10,{source,packetId:packet.packetId});f.journal.dispatch(rowId);f.journal.settle(rowId,{upperMicros:10});f.journal.attachOutput(rowId,raw);
  return {packet,core,raw,decisionId,rowId,source};
}

test('IR-05 affect R1: captured attempt adopts with 0 LLM calls, journal accepted, turn committed, replay idempotent',async t=>{
  const f=await affectFixture(t),task=await f.service.createAgentTask({goal:'affect captured task',metadata:{allowedTools:[]}});
  const cap=await seedAffectCapturedAttempt(f,f.store.read(task.id),{eventId:'affect-r1-event',result:'affect finish'});
  const callsBefore=f.state.calls,workersBefore=f.workerState.calls;
  const step=await f.service.stepAgentTask(task.id);
  assert.equal(step.status,'done');
  assert.equal(f.state.calls,callsBefore,'captured adoption must not call the model');
  assert.ok(f.store.read(cap.decisionId),'captured decision adopted');
  assert.equal(f.journal.find(cap.rowId).validation?.status,'accepted');
  assert.equal(f.journal.blocks(cap.source),false);
  assert.equal(f.store.read(affectTurnId(cap.packet)).status,'committed');
  assert.ok(f.workerState.calls>workersBefore,'affect worker transition replayed without an LLM call');
  const blockedReason=String(f.store.read(task.id).blockedReason??'');
  assert.ok(!blockedReason.includes('MODEL_OUTPUT_INVALID'),'affect R1 must not be a model-output error');
  // Replay/idempotency: no second decision, no additional journal row, no LLM call.
  const decisions=[...f.store.all('decision')].filter(d=>d.id===cap.decisionId).length,rows=f.journal.data.requests.length,calls=f.state.calls;
  await f.service.stepAgentTask(task.id);
  assert.equal(f.state.calls,calls,'replay performs no model call');
  assert.equal([...f.store.all('decision')].filter(d=>d.id===cap.decisionId).length,decisions,'single adopted decision');
  assert.equal(f.journal.data.requests.length,rows,'replay adds no journal row');
  assert.equal(f.journal.find(cap.rowId).validation?.status,'accepted');
  assert.equal(f.store.read(affectTurnId(cap.packet)).status,'committed');
});

test('IR-05 affect R1: worker loss during captured adoption falls back to core-only, 0 LLM calls, journal accepted',async t=>{
  const f=await affectFixture(t),task=await f.service.createAgentTask({goal:'affect worker loss task',metadata:{allowedTools:[]}});
  const cap=await seedAffectCapturedAttempt(f,f.store.read(task.id),{eventId:'affect-worker-loss-event',result:'core only finish'});
  f.workerState.down=true;
  const callsBefore=f.state.calls;
  const step=await f.service.stepAgentTask(task.id);
  assert.equal(step.status,'done');
  assert.equal(f.state.calls,callsBefore,'worker loss must not trigger an LLM call');
  assert.ok(f.store.read(cap.decisionId),'core decision adopted without affect state');
  assert.equal(f.store.read(cap.decisionId).output.affectAppraisal,undefined);
  assert.equal(f.store.read(affectTurnId(cap.packet)).status,'failed');
  assert.equal(f.journal.find(cap.rowId).validation?.status,'accepted');
  assert.equal(f.journal.find(cap.rowId).validation?.status==='rejected',false);
  assert.ok(!String(f.store.read(task.id).blockedReason??'').includes('MODEL_OUTPUT_INVALID'));
});

test('IR-05 affect R1: prepared/dispatched/uncertain turns classify as TASK_MODEL_SOURCE_BLOCKED, not MODEL_OUTPUT_INVALID',async t=>{
  for(const status of ['prepared','dispatched','uncertain']){
    const f=await affectFixture(t),task=await f.service.createAgentTask({goal:'affect unavailable '+status,metadata:{allowedTools:[]}});
    const cap=await seedAffectCapturedAttempt(f,f.store.read(task.id),{eventId:'affect-unavailable-'+status,turnStatus:status});
    const callsBefore=f.state.calls;
    const step=await f.service.stepAgentTask(task.id);
    assert.equal(step.ok,false,status);
    assert.equal(f.state.calls,callsBefore,status+': typed capture refusal happens before any LLM call');
    const blocked=f.store.read(task.id);
    assert.equal(blocked.status,'blocked',status);
    assert.equal(blocked.blockedReason,`TASK_MODEL_SOURCE_BLOCKED:${cap.rowId}`,status);
    assert.ok(!String(blocked.blockedReason).includes('MODEL_OUTPUT_INVALID'),status);
    assert.equal(f.store.read(cap.decisionId),null,status+': no decision is invented');
    assert.equal(f.journal.find(cap.rowId).validation??null,null,status+': journal is not marked accepted or rejected');
    assert.equal(f.store.read(affectTurnId(cap.packet)).status,status);
  }
});

test('IR-05 affect R1: stale workspace ref is not adopted',async t=>{
  const f=await affectFixture(t),task=await f.service.createAgentTask({goal:'affect stale workspace task',metadata:{allowedTools:[]}});
  const cap=await seedAffectCapturedAttempt(f,f.store.read(task.id),{eventId:'affect-stale-ws-event'});
  const workspace=f.store.read('ws:agent/task');
  f.store.execute({requestId:'bump-workspace',commands:[{op:'set_workspace',id:workspace.id,expectedRevision:workspace.revision,scene:workspace.scene,focus:workspace.focus}]});
  const callsBefore=f.state.calls;
  await f.service.stepAgentTask(task.id);
  assert.equal(f.state.calls,callsBefore,'stale workspace must not call the model');
  assert.equal(f.store.read(cap.decisionId),null,'stale captured decision is not adopted');
  assert.notEqual(f.journal.find(cap.rowId).validation?.status,'accepted','journal is not marked adopted');
  assert.equal(f.store.read(task.id).status,'blocked');
});

test('IR-05 affect R1: stale subject/frame refs are not adopted',async t=>{
  const f=await affectFixture(t),task=await f.service.createAgentTask({goal:'affect stale task',metadata:{allowedTools:[]}});
  const cap=await seedAffectCapturedAttempt(f,f.store.read(task.id),{eventId:'affect-stale-event'});
  advanceSubject(f);
  const callsBefore=f.state.calls;
  await f.service.stepAgentTask(task.id);
  assert.equal(f.state.calls,callsBefore,'stale capture must not call the model');
  assert.equal(f.store.read(cap.decisionId),null,'stale captured decision is not adopted');
  assert.notEqual(f.journal.find(cap.rowId).validation?.status,'accepted','journal is not marked adopted');
  assert.equal(f.journal.find(cap.rowId).status,'settled');
  assert.equal(f.store.read(task.id).status,'blocked');
});



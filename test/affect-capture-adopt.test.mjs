// IR-05: AffectSession.commitCaptured adopts a durable captured decision_attempt
// without invoking a model. Real task-source R1 passes decision_attempt.output
// (core output, affectAppraisal stripped) while the affect turn keeps the original
// raw output; this file exercises that exact shape plus the degradation rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {AffectSession,resolveAffectRuntimeAsset} from '../tools/affect-integrated/session.mjs';
import {motivationId,affectTurnId} from '../src/affect-contract.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';

const T=1794400000000;
const ref=x=>({id:x.id,revision:x.revision});
function fakeJournal(){
  const rows=new Map(),validations=[];
  return {
    rows,validations,
    packetRequest:id=>rows.get(id)??null,
    sourceRequest:()=>null,
    blocks:()=>false,find:()=>null,readmit:()=>{},
    recordValidation(id,validation){validations.push({id,validation});const row=rows.get(id);if(row)rows.set(id,{...row,validation});},
    setRow(id,row){rows.set(id,row);}
  };
}
function setup(t){
  const store=new ContinuityStore(':memory:',{clock:()=>T});t.after(()=>store.close());
  store.execute({requestId:'ws',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成场景'}}]});
  const journal=fakeJournal(),diagnostics=[];
  const record=store.recordDiagnostic.bind(store);
  store.recordDiagnostic=value=>{diagnostics.push(value);return record(value);};
  const session=new AffectSession({store,subjectId:'s',fusion:false,clock:()=>T,requestJournal:journal});
  let workerCalls=0,invokeCalls=0;
  const realWorker=session.worker;
  session.worker=async input=>{workerCalls++;return realWorker(input);};
  const addEvent=id=>store.execute({requestId:id,commands:[{op:'append_event',id,body:'合成任务事件',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:T,source:{system:'fixture',key:id}}]}).at(-1);
  const args=currentEvent=>({currentEvent,workspace:{id:'w',revision:1},now:T,identity:'离线合成主体',budgetBytes:131072,
    mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
  const output=packet=>{
    const o=proposal(packet);
    if(packet.payload.current)o.affectAppraisal={source_refs:[ref(packet.payload.current)],
      appraisals:[{weight:1,value:{event:'task-step',summary:'合成任务步',valence:.2,intensity:.6,relevance:.7,agency:'circumstance'}}]};
    return o;
  };
  // Real R1 shape: affect turn raw output keeps affectAppraisal; the captured
  // decision_attempt output is the same proposal with affectAppraisal stripped.
  const strippedOutput=raw=>{const copy=JSON.parse(raw);delete copy.affectAppraisal;return JSON.stringify(copy);};
  const capture=async(id='e1')=>{
    const event=addEvent(id),packet=await session.prepare(args(ref(event))),raw=await session.invoke(packet,()=>{invokeCalls++;return JSON.stringify(output(packet));});
    const coreRaw=strippedOutput(raw);
    journal.setRow(packet.packetId,{packetId:packet.packetId,status:'settled',validation:null,output:coreRaw,requestKey:'request:'+id});
    return {event,packet,raw,coreRaw};
  };
  const commitArgs=(packet,coreRaw,decisionId='task-decision:'+packet.packetId,requestId='request:e1')=>({packet,output:coreRaw,decisionId,requestId,allowedActionTools:[],maxOutputBytes:32768,taskGuard:null});
  return {store,journal,session,addEvent,args,output,strippedOutput,capture,commitArgs,diagnostics,workerCalls:()=>workerCalls,invokeCalls:()=>invokeCalls};
}

test('real R1 shape: captured core output adopts with affect state, 0 model calls, replay idempotent',async t=>{
  assert.equal(resolveAffectRuntimeAsset({root:process.cwd(),env:{}}).exists,true,'packaged affect runtime required');
  const f=setup(t),{packet,raw,coreRaw}=await f.capture('e1');
  const turn=f.store.read(affectTurnId(packet));
  assert.equal(turn.status,'captured');
  assert.ok(turn.rawOutput.includes('affectAppraisal'),'affect turn raw output keeps appraisal');
  assert.equal(JSON.parse(coreRaw).affectAppraisal,undefined,'decision_attempt output is stripped');
  const beforeMotivation=f.store.read(motivationId('s')),beforeWorkers=f.workerCalls();
  const decision=await f.session.commitCaptured(f.commitArgs(packet,coreRaw));
  assert.equal(decision.type,'decision');
  assert.equal(decision.output.affectAppraisal,undefined,'adopted core decision carries no affect appraisal field');
  assert.equal(f.store.read(affectTurnId(packet)).status,'committed');
  assert.ok(f.store.read(motivationId('s')).revision>beforeMotivation.revision,'deterministic worker replay adopts the affect state');
  assert.ok(f.workerCalls()>beforeWorkers,'worker transition replayed without a model call');
  assert.equal(f.invokeCalls(),1,'commitCaptured must not invoke a model');
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='accepted').length,1);
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='rejected').length,0);
  const workersAfter=f.workerCalls();
  const replay=await f.session.commitCaptured(f.commitArgs(packet,coreRaw));
  assert.equal(replay.id,decision.id);
  assert.equal(f.workerCalls(),workersAfter,'replay returns the existing decision without rerunning the worker');
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='accepted').length,1);
});

test('worker unavailable during captured adoption: core-only decision, failed turn, no false affect state',async t=>{
  const f=setup(t),{packet,coreRaw}=await f.capture('e1');
  const beforeMotivation=f.store.read(motivationId('s'));
  f.session.worker=async()=>{throw Object.assign(new Error('worker died'),{code:'WORKER_UNAVAILABLE'});};
  const decision=await f.session.commitCaptured(f.commitArgs(packet,coreRaw));
  assert.equal(decision.type,'decision');
  assert.equal(f.store.read(affectTurnId(packet)).status,'failed');
  assert.equal(f.store.read(affectTurnId(packet)).error,'WORKER_UNAVAILABLE');
  assert.equal(f.store.read(motivationId('s')).revision,beforeMotivation.revision,'no affect state adopted on runtime loss');
  assert.ok(f.diagnostics.some(d=>d.stage==='affect.capture-core-only'));
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='rejected').length,0);
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='accepted').length,1);
});

for(const status of ['prepared','dispatched','uncertain']){
  test('affect turn '+status+': typed AFFECT_CAPTURE_UNAVAILABLE without decision/journal writes',async t=>{
    const f=setup(t);
    const event=f.addEvent('e1'),packet=await f.session.prepare(f.args(ref(event)));
    let turn=f.store.read(affectTurnId(packet));
    assert.equal(turn.status,'prepared');
    if(status==='dispatched')turn=f.store.execute({requestId:'dispatch',commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'}]}).at(-1);
    if(status==='uncertain'){
      turn=f.store.execute({requestId:'dispatch2',commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'}]}).at(-1);
      f.store.execute({requestId:'uncertain',commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'uncertain',error:'SYNTHETIC_UNCERTAIN',failurePhase:'invocation',transportInvoked:true}]});
    }
    const raw=JSON.stringify(f.output(packet)),coreRaw=f.strippedOutput(raw);
    f.journal.setRow(packet.packetId,{packetId:packet.packetId,status:'settled',validation:null,output:coreRaw,requestKey:'request:e1'});
    await assert.rejects(f.session.commitCaptured(f.commitArgs(packet,coreRaw)),error=>error.code==='AFFECT_CAPTURE_UNAVAILABLE'&&error.details?.turnStatus===status);
    assert.equal(f.store.read('task-decision:'+packet.packetId),null);
    assert.equal(f.journal.validations.length,0,'typed refusal must not write accepted or rejected journal validation');
    assert.equal(f.store.read(affectTurnId(packet)).status,status);
  });
}

test('missing affect turn: core-only adoption (no affect state) and journal accepted',async t=>{
  const f=setup(t);
  const event=f.addEvent('core-e1'),packet=await f.session.core.prepare(f.args(ref(event)));
  const raw=JSON.stringify(f.output(packet)),coreRaw=f.strippedOutput(raw);
  f.journal.setRow(packet.packetId,{packetId:packet.packetId,status:'settled',validation:null,output:coreRaw,requestKey:'request:core-e1'});
  const decision=await f.session.commitCaptured(f.commitArgs(packet,coreRaw,'task-decision:'+packet.packetId,'request:core-e1'));
  assert.equal(decision.type,'decision');
  assert.equal(f.store.read(affectTurnId(packet)),null);
  assert.equal(f.store.read(motivationId('s')),null,'missing turn must not create affect state');
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='accepted').length,1);
});

test('failed affect turn: core-only adoption, previous affect state untouched',async t=>{
  const f=setup(t),{packet,coreRaw}=await f.capture('e1');
  const turn=f.store.read(affectTurnId(packet));
  f.store.execute({requestId:'fail-turn',commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'failed',error:'SYNTHETIC_REJECT',failurePhase:'output-validation'}]});
  const before=f.store.read(motivationId('s'));
  const decision=await f.session.commitCaptured(f.commitArgs(packet,coreRaw));
  assert.equal(decision.type,'decision');
  assert.equal(f.store.read(affectTurnId(packet)).status,'failed');
  assert.equal(f.store.read(motivationId('s')).revision,before.revision);
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='rejected').length,0);
});

test('affect-side deterministic validation failure: core-only adopt + failed turn + diagnostic (no journal rejected)',async t=>{
  const f=setup(t);
  const event=f.addEvent('e1'),packet=await f.session.prepare(f.args(ref(event)));
  const brokenRaw=JSON.stringify({...proposal(packet),affectAppraisal:{source_refs:[],appraisals:[]}});
  await f.session.invoke(packet,()=>brokenRaw);
  const coreRaw=f.strippedOutput(brokenRaw);
  f.journal.setRow(packet.packetId,{packetId:packet.packetId,status:'settled',validation:null,output:coreRaw,requestKey:'request:e1'});
  const before=f.store.read(motivationId('s'));
  const decision=await f.session.commitCaptured(f.commitArgs(packet,coreRaw));
  assert.equal(decision.type,'decision','affect-side validation failure must still adopt the captured core decision');
  assert.equal(f.store.read(affectTurnId(packet)).status,'failed');
  assert.equal(f.store.read(motivationId('s')).revision,before.revision,'no affect state adopted on validation fallback');
  assert.ok(f.diagnostics.some(d=>d.stage==='affect.capture-affect-fallback'));
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='accepted').length,1);
  assert.equal(f.journal.validations.filter(v=>v.validation.status==='rejected').length,0);
});

test('identity/output mismatch fails closed: no core-only adoption, typed failure, no journal writes',async t=>{
  const f=setup(t),{packet,coreRaw}=await f.capture('e1');
  const other=JSON.parse(coreRaw);other.summary='tampered captured decision';
  await assert.rejects(f.session.commitCaptured(f.commitArgs(packet,JSON.stringify(other))),
    error=>error.code==='AFFECT_CAPTURE_OUTPUT_MISMATCH','mismatch must surface its typed code');
  assert.equal(f.store.read('task-decision:'+packet.packetId),null,'identity mismatch must not adopt the core decision');
  assert.equal(f.store.read(affectTurnId(packet)).status,'failed');
  assert.equal(f.journal.validations.length,0,'identity mismatch must not write journal accepted or rejected');
  assert.ok(f.diagnostics.some(d=>d.stage==='affect.capture-identity-mismatch'));
});

test('invalid core decision payload stays fail-closed: no decision, no journal validation',async t=>{
  const f=setup(t),{packet,coreRaw}=await f.capture('e1');
  const bad=JSON.parse(coreRaw);delete bad.packetId;
  await assert.rejects(f.session.commitCaptured(f.commitArgs(packet,JSON.stringify(bad))));
  assert.equal(f.store.read('task-decision:'+packet.packetId),null);
  assert.equal(f.store.read(affectTurnId(packet)).status,'failed');
  assert.equal(f.journal.validations.length,0,'core-payload failure must not write journal accepted or rejected');
});

test('stale subject: captured attempt is not adopted and journal stays unadopted',async t=>{
  const f=setup(t),{packet,coreRaw}=await f.capture('e1');
  // Advance the subject revision through a plain core decision so the captured packet is stale.
  const core=new ContinuitySession({store:f.store,subjectId:'s',attention:true,maxForeground:16,requestJournal:f.journal});
  const event2=f.addEvent('e2'),packet2=await core.prepare(f.args(ref(event2))),plain=JSON.stringify(proposal(packet2));
  f.journal.setRow(packet2.packetId,{packetId:packet2.packetId,status:'settled',validation:null,output:plain,requestKey:'request:e2'});
  const advanced=await core.commit({packet:packet2,output:plain,requestId:'request:e2',decisionId:'core-d2',allowedActionTools:[]});
  assert.equal(advanced.type,'decision');
  // The stale captured attempt cannot be adopted; no journal rejection is written for it.
  const validationsBefore=f.journal.validations.length;
  await assert.rejects(f.session.commitCaptured(f.commitArgs(packet,coreRaw)));
  assert.equal(f.store.read('task-decision:'+packet.packetId),null);
  assert.equal(f.journal.validations.length,validationsBefore,'no journal validation for the refused stale capture');
});

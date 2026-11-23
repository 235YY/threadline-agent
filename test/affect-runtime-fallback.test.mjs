// Phase 3.2 Limbic runtime-loss fallback (D ownership).
// Requirement: if the affect worker disappears AFTER startup, a normal turn must
// still complete through the core ContinuitySession: mark this session degraded,
// adopt no affect state, never retry the worker, and never stall the turn beyond
// the worker-call timeout. These tests use the packaged runtime for the healthy
// first turn, then a failing worker to simulate runtime loss.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {motivationId,affectTurnId} from '../src/affect-contract.mjs';
import {AffectSession,affectFactory,resolveAffectRuntimeAsset} from '../tools/affect-integrated/session.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';

const T=1794400000000;
const ref=x=>({id:x.id,revision:x.revision});
const failingWorker=calls=>async input=>{calls.push(input?.action??'unknown');throw Object.assign(new Error('worker died after startup'),{code:'WORKER_UNAVAILABLE'})};
function makeStore(t){
  const store=new ContinuityStore(':memory:',{clock:()=>T});t.after(()=>store.close());
  store.execute({requestId:'ws',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成场景'}}]});
  const diagnostics=[];const record=store.recordDiagnostic.bind(store);
  store.recordDiagnostic=value=>{diagnostics.push(value);return record(value);};
  return {store,diagnostics};
}
function addEvent(store,id,at=T){
  return store.execute({requestId:id,commands:[{op:'append_event',id,body:'合成互动',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:at,source:{system:'fixture',key:id}}]}).at(-1);
}
function sessionArgs(currentEvent){
  return {currentEvent,workspace:{id:'w',revision:1},now:T,identity:'离线合成主体',budgetBytes:131072,
    mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]};
}
function nonFusionOutput(p,appraisal=true){
  const output=proposal(p);
  if(p.payload.current){
    if(appraisal)output.affectAppraisal={source_refs:[ref(p.payload.current)],
      appraisals:[{weight:1,value:{event:'synthetic',summary:'合成评价',valence:.2,intensity:.6,relevance:.7,agency:'circumstance'}}]};
  }else{
    delete output.continuity.observationDisposition;delete output.continuity.expressionChoice;
  }
  return output;
}
async function healthyFirstTurn(session,store,id='e1'){
  const event=addEvent(store,id);
  const packet=await session.prepare(sessionArgs(ref(event)));
  const raw=await session.invoke(packet,()=>JSON.stringify(nonFusionOutput(packet)));
  const decision=await session.commit({packet,output:raw,requestId:'r:'+id,decisionId:'d:'+id});
  return {event,packet,decision,state:store.read(motivationId('s'))};
}

test('worker loss after startup: prepare falls back to a core packet, no affect state, no retry loop',async t=>{
  assert.equal(resolveAffectRuntimeAsset({root:process.cwd(),env:{}}).exists,true,'packaged runtime required');
  const {store,diagnostics}=makeStore(t);
  const session=new AffectSession({store,subjectId:'s',fusion:false,clock:()=>T});
  const first=await healthyFirstTurn(session,store);
  assert.equal(first.state?.type,'motivation_state');assert.ok(first.state.revision>=2);
  const before=store.read(motivationId('s'));
  const calls=[];
  session.worker=failingWorker(calls);
  const event2=addEvent(store,'e2');
  const packet2=await session.prepare(sessionArgs(ref(event2))); // must not reject
  assert.equal(session.status().degraded,true);assert.equal(session.status().reason,'WORKER_UNAVAILABLE');
  assert.equal(packet2.payload.continuity.motivation,undefined,'core fallback packet has no affect projection');
  const raw2=await session.invoke(packet2,()=>JSON.stringify(nonFusionOutput(packet2,false)));
  const decision2=await session.commit({packet:packet2,output:raw2,requestId:'r:e2',decisionId:'d:e2'});
  assert.equal(decision2.type,'decision');
  const after=store.read(motivationId('s'));
  assert.equal(after.revision,before.revision,'no affect state adopted on the degraded turn');
  assert.equal(store.read(affectTurnId(packet2)),null,'no affect_turn for the core fallback packet');
  assert.ok(calls.length>=1);
  assert.ok(diagnostics.some(d=>d.stage==='affect.runtime-degraded'&&d.data?.code==='WORKER_UNAVAILABLE'));
  // Subsequent turns are core-only: the dead worker is never called again.
  const callsBefore=calls.length,event3=addEvent(store,'e3');
  const packet3=await session.prepare(sessionArgs(ref(event3)));
  await session.invoke(packet3,()=>JSON.stringify(nonFusionOutput(packet3,false)));
  await session.commit({packet:packet3,output:JSON.stringify(nonFusionOutput(packet3,false)),requestId:'r:e3',decisionId:'d:e3'});
  assert.equal(calls.length,callsBefore,'degraded session must not retry the worker');
  assert.equal(store.read(motivationId('s')).revision,before.revision);
});

test('worker loss during commit: core decision commits, captured affect turn is closed failed, no state update',async t=>{
  const {store}=makeStore(t);
  const session=new AffectSession({store,subjectId:'s',fusion:false,clock:()=>T});
  const event=addEvent(store,'e1');
  const packet=await session.prepare(sessionArgs(ref(event)));
  const raw=await session.invoke(packet,()=>JSON.stringify(nonFusionOutput(packet)));
  const before=store.read(motivationId('s'));
  const calls=[];session.worker=failingWorker(calls);
  const decision=await session.commit({packet,output:raw,requestId:'r1',decisionId:'d1'}); // must not reject
  assert.equal(decision.type,'decision');
  assert.equal(session.status().degraded,true);
  assert.equal(store.read(affectTurnId(packet))?.status,'failed');
  assert.equal(store.read(affectTurnId(packet))?.error,'WORKER_UNAVAILABLE');
  assert.equal(store.read(motivationId('s')).revision,before.revision,'worker failure must not adopt the preview state');
  assert.equal(decision.affectTurn,undefined);
});

test('TurnDriver normal turn and reflection keep working after worker loss (no stall, no false affect state)',async t=>{
  const {store}=makeStore(t);
  let instance=null;
  const sessionFactory=args=>{instance=new AffectSession({...args,fusion:false,clock:()=>T});return instance;};
  const packets=[];
  const decide=p=>{
    packets.push(p);
    const output=nonFusionOutput(p,Boolean(p.payload.current));
    return JSON.stringify(output);
  };
  const driver=new TurnDriver({store,subjectId:'s',workspace:'w',identity:'离线合成主体',eventBypass:true,sessionFactory,decide});
  driver.ingest({key:'message:1',body:'第一条',scene:'synthetic',at:T});
  assert.equal((await driver.tick({now:T,eventBypass:true})).action,'decided');
  const stateAfterFirst=store.read(motivationId('s'));
  assert.ok(stateAfterFirst?.type==='motivation_state');
  const committedTurns=()=>[...store.all('affect_turn')].filter(x=>x.status==='committed').length;
  assert.equal(committedTurns(),1);
  instance.worker=failingWorker([]);
  driver.ingest({key:'message:2',body:'第二条',scene:'synthetic',at:T+1000});
  const second=await driver.tick({now:T+1000,eventBypass:true}); // must resolve, not throw/stall
  assert.equal(second.action,'decided');
  assert.equal([...store.all('decision')].length,2);
  assert.equal(packets.at(-1).payload.continuity.motivation,undefined,'fallback turn input has no affect projection');
  assert.equal(store.read(motivationId('s')).revision,stateAfterFirst.revision);
  assert.equal(committedTurns(),1,'no new affect turn adopted');
  // Reflection path also degrades to the core session instead of failing.
  const reflected=await driver.tick({now:T+2000,followup:{id:'follow',targetScene:'synthetic'}});
  assert.equal(reflected.action,'reflected');
  assert.equal(packets.at(-1).stage,'reflection');
  assert.equal(store.read(motivationId('s')).revision,stateAfterFirst.revision);
});

test('affectFactory exposes degraded status and callback for host health wiring',async t=>{
  const {store}=makeStore(t);
  const events=[];const factory=affectFactory({fusion:false,clock:()=>T,onDegraded:info=>events.push(info)});
  const session=factory({store,subjectId:'s',attention:true,maxForeground:16});
  await healthyFirstTurn(session,store);
  session.worker=failingWorker([]);
  await session.prepare(sessionArgs(ref(addEvent(store,'e2'))));
  const status=factory.status();
  assert.equal(status.degraded,true);assert.equal(status.reason,'WORKER_UNAVAILABLE');
  assert.equal(events.length,1);assert.equal(events[0].reason,'WORKER_UNAVAILABLE');
  assert.deepEqual(factory.sessions(),[session]);
});

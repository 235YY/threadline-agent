// E-owned Phase 0/1: affect-on capacity refusals are host resource facts.
// Deterministic synthetic worker: no packaged affect runtime / provider / network needed.
// They must stay on the existing deferred/retryAuthorization/requeue primitive:
// no journal accepted/rejected validation, no affect turn auto-close/quarantine,
// and the same source may re-enter after an explicit retry authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {affectTurnId} from '../src/affect-contract.mjs';
import {canonical} from '../src/contracts.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,put,event,frame,ref} from './helpers.mjs';

const T=1794400000000,clone=x=>JSON.parse(JSON.stringify(x));
function initial(){
  return {format:'jingyang-affect-shadow-v1',upstream:'2132fa81b20134f469fd7adeb8e38fa20dd32071',revision:0,wallAt:T,mode:'online',
    config:{timezoneMinutes:480,parameters:{},offlinePolicy:'freeze-lived-time',aggregation:'weighted-counterfactual-v1'},requests:{},sources:{},
    engineState:{drives:{social:.2,novelty:.2,competence:.2,recognition:.2,fatigue:.2,sleepiness:.2,libido:0,intimacy:0},mood:{p:0,a:0,d:0},baseline:{p:0,a:0,d:0},intents:[],sexuality:{},emotions:{}}};
}
async function worker(x){
  if(x.action==='initialize')return {state:initial()};
  const s=clone(x.state),op=x.operation;s.revision++;s.wallAt=op.nowMs;
  if(op.source)s.sources[canonical(op.source)]={fixture:true};
  return {state:s,receipt:{operationId:op.id}};
}
function fakeJournal(){
  const rows=new Map(),validations=[];
  return {
    rows,validations,
    packetRequest:id=>rows.get('turn:'+id)??null,
    sourceRequest:source=>[...rows.values()].find(r=>r.source&&canonical(r.source)===canonical(source))??null,
    blocks:()=>false,find:id=>rows.get(id)??null,readmit:()=>{},
    recordValidation(id,validation){validations.push({id,validation});const row=rows.get('turn:'+id);if(row)rows.set('turn:'+id,{...row,validation});},
    setRow(id,row){rows.set(id,row);},
    tryFind:id=>rows.get(id)??null
  };
}
function setup(t){
  const {store}=memory(t);
  const [eventRecord,workspaceRecord]=put(store,'seed',event('e'),frame());
  const journal=fakeJournal(),diagnostics=[];
  const record=store.recordDiagnostic.bind(store);
  store.recordDiagnostic=value=>{diagnostics.push(value);return record(value);};
  const session=new AffectSession({store,subjectId:'p',worker,clock:()=>T,requestJournal:journal});
  const args=currentEvent=>({currentEvent,workspace:ref(workspaceRecord),now:T,identity:'合成主体',budgetBytes:131072,
    mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
  const output=packet=>({packetId:packet.packetId,options:[{id:'keep',kind:'wait',payload:{}}],selected:'keep',
    summary:'合成容量输出，仅检验提交边界',used:[],
    continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
  return {store,journal,session,eventRecord,args,output,diagnostics};
}

test('affect-on capacity refusal: no journal rejected/accepted, no quarantine, source deferred and requeueable',async t=>{
  const f=setup(t),packet=await f.session.prepare(f.args(ref(f.eventRecord)));
  let invokes=0;
  const raw=await f.session.invoke(packet,()=>{invokes++;return JSON.stringify(f.output(packet));});
  // Emulate the core commit's host capacity branch at the exact seam: it records the
  // existing input-failure deferred attempt and throws the typed capacity ContractError.
  const coreCommit=f.session.core.commit.bind(f.session.core);
  f.session.core.commit=()=>{
    const subject=f.store.read('p');
    f.store.execute({requestId:'test-capacity-defer',commands:[{op:'fail_subject_event',subject:{id:'p',revision:subject.revision},event:ref(f.eventRecord),reason:'FOREGROUND_CAPACITY'}]});
    throw Object.assign(new Error('foreground capacity'),{code:'FOREGROUND_CAPACITY',name:'ContractError'});
  };
  await assert.rejects(()=>f.session.commit({packet,output:raw,requestId:'cap-request',decisionId:'decision:cap'}),
    e=>e.code==='FOREGROUND_CAPACITY');
  assert.equal(f.journal.validations.length,0,'capacity must not write journal accepted/rejected');
  const inbox=f.store.subjectObservation('p',f.eventRecord.id);
  assert.equal(inbox.status,'deferred','capacity keeps the source deferred');
  assert.match(String(inbox.decisionId),/^input-failure:/);
  const turn=f.store.read(affectTurnId(packet));
  assert.equal(turn.status,'failed','turn stays visible as failed, not auto-closed');
  assert.equal(turn.error,'FOREGROUND_CAPACITY');
  assert.equal(turn.failurePhase,'capacity-deferred');
  assert.equal([...f.store.all('decision_attempt')].some(a=>a.status==='quarantined'),false,'no quarantine attempt');
  assert.ok(f.diagnostics.some(d=>d.stage==='affect.capacity-deferred'),'deferred diagnostic recorded');
  // Existing requeue primitive: a settled+unvalidated journal row can be authorized
  // and the deferred source requeued; the failed turn must not block #prepare when the
  // journal carries retryAuthorization.
  const row={id:'turn:'+packet.packetId,packetId:packet.packetId,status:'settled',validation:null,output:raw,
    source:{subject:'p',kind:'event',event:ref(f.eventRecord)}};
  f.journal.setRow(row.id,row);
  f.store.execute({requestId:'requeue-fixture',commands:[{op:'requeue_subject_event',subjectId:'p',event:ref(f.eventRecord),reason:'capacity released synthetic'}]});
  assert.equal(f.store.subjectObservation('p',f.eventRecord.id).status,'received');
  row.retryAuthorization={evidenceHash:'synthetic',evidence:{requestId:row.id,capacityReleased:true,operator:'fixture'}};
  await assert.doesNotReject(()=>f.session.prepare(f.args(ref(f.eventRecord))),'authorized capacity retry can re-enter prepare');
  f.session.core.commit=coreCommit;
  assert.equal(invokes,1,'the fixture made exactly the initial model invocation');
});

test('capacity codes are shared host-resource classification, not model output codes',async()=>{
  const {isAttentionCapacityError}=await import('../src/attention.mjs');
  for(const code of ['FOREGROUND_CAPACITY','ATTENTION_CAPACITY'])assert.equal(isAttentionCapacityError(code),true,code);
  for(const code of ['MODEL_OUTPUT_INVALID','OUTPUT_SHAPE','STALE_MOTIVATION',null,undefined])assert.equal(isAttentionCapacityError(code),false,String(code));
});

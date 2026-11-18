import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {fusionContext,meaningId} from '../tools/affect-integrated/fusion.mjs';
import {motivationId,affectTurnId} from '../src/affect-contract.mjs';
import {normalizeApperception} from '../src/cognition.mjs';
import {intentPacket} from '../src/intent-protocol.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';
import {callWorker} from '../tools/affect-shadow/bridge.mjs';
import {disk} from './helpers.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {affectFactory} from '../tools/affect-integrated/session.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';

const T=1794400000000,ref=x=>({id:x.id,revision:x.revision});
function setup(t,path=':memory:'){
 const store=new ContinuityStore(path,{clock:()=>T});t.after(()=>store.close());
 store.execute({requestId:'world',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成场景'}}]});
 const session=new AffectSession({store,subjectId:'s',fusion:true,clock:()=>T});let n=0;
 const event=(id)=>{store.execute({requestId:id,commands:[{op:'append_event',id,body:'合成互动',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:T,source:{system:'fixture',key:id}}]});return {id,revision:1};};
 const args=currentEvent=>({currentEvent,workspace:{id:'w',revision:1},now:T,identity:'离线合成主体',budgetBytes:131072,mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
 const capture=async(p,o)=>{const raw=await session.invoke(p,()=>o);return {raw,commit:()=>session.commit({packet:p,output:raw,requestId:'r'+(++n),decisionId:'d'+n})};};
 const commit=async(p,o)=>{const c=await capture(p,o);return c.commit();};
 const reflect=()=>session.prepareReflection({workspace:{id:'w',revision:1},internal:{format:'reflection-frame-v1'},budgetBytes:131072,now:T});
 return {store,session,event,args,commit,capture,reflect};
}
function output(p,{mode='encounter',sources=[ref(p.payload.current)],previous=null,text='我对这一结果仍不确定',valence=-.4,appraisal=true}={}){
 const o=proposal(p);
 if(!p.payload.current){delete o.continuity.observationDisposition;delete o.continuity.expressionChoice;}
 o.apperception={schema_version:'apperception.slice.v1',integrated_understanding:text,activated_cells:[{domain:'self',perspective:'meaning',content:text,epistemic_status:'interpretation',source_refs:[...sources,p.payload.continuity.motivation.projectionRef],uncertainty:'合成情境，仍待验证'}]};
 if(appraisal)o.affectAppraisal={schema_version:'affect.appraisal.v2',mode,source_refs:sources,previous,reason:'当前理解的形成或变化',appraisals:[{weight:1,value:{event:'synthetic-result',summary:text,valence,intensity:.7,relevance:.8,agency:'circumstance',competence:.8}}]};
 return o;
}
test('compact affect appraisal enters the existing engine and the next cognitive view',async t=>{
 const s=setup(t),e=s.event('compact-emotion'),p=await s.session.prepare({...s.args(e),intentProtocol:true});
 const w=intentPacket(p),view=JSON.parse(w.messages[1].content).view;
 assert.equal(view.canEvaluateMood,true);
 const raw={packetId:w.packetId,decision:{type:'wait'},perception:{domain:'world',meaning:'一次令人惊喜的发现'},
   moodEval:{meaning:'惊喜',event:'discovery',valence:.9,intensity:.9,agency:'circumstance'}};
 await s.commit(p,raw);
 assert.equal(s.store.read(meaningId('s',[e])).value.interpretation.activated_cells[0].domain,'world');
 const next=await s.session.prepare({...s.args(s.event('after-emotion')),intentProtocol:true});
 const delivered=JSON.parse(intentPacket(next).messages[1].content).view;
 assert.ok(delivered.mood?.length,'computed emotions reach a later compact input');
 assert.equal([...s.store.all('personal_state')].length,0,'affect does not manufacture personal memories');
});
async function encountered(s){const e=s.event('e'),p=await s.session.prepare(s.args(e));await s.commit(p,output(p));return e;}

test('fusion delivers a typed time-specific internal source and preserves task instructions',async t=>{
 const s=setup(t),p=await s.session.prepare({...s.args(s.event('e')),instructionSuffix:'TASK-CONTRACT-MUST-STAY'});
 assert.equal(p.payload.apperceptionV1.enabled,true);assert.match(p.instruction,/TASK-CONTRACT-MUST-STAY/);
 const m=p.payload.continuity.motivation,source=p.payload.continuity.internalSources[0];
 assert.deepEqual(source.ref,m.projectionRef);assert.equal(source.kind,'computed-internal');assert.equal(source.value.asOf,T);
 assert.equal(source.value.projectionPath,'continuity.motivation.projection');
 assert.doesNotThrow(()=>normalizeApperception(output(p).apperception,p));
 const wrong=output(p).apperception;wrong.activated_cells[0].source_refs=[{id:'internal:invented',revision:1}];
 assert.throws(()=>normalizeApperception(wrong,p),{code:'UNDELIVERED_REFERENCE'});
});

test('encounter atomically saves shared interpretation, computed state and decision, not a new endorsed concern',async t=>{
 const s=setup(t),e=await encountered(s),h=s.store.read(meaningId('s',[e]));
 assert.deepEqual(h.value.interpretation,s.store.read('d1').output.apperception);
 assert.equal(h.value.mode,'encounter');assert.deepEqual(h.value.decision,{id:'d1',revision:1});
 assert.equal(s.store.read(motivationId('s')).revision,2);assert.equal([...s.store.all('personal_state')].length,0);
 assert.equal([...s.store.all('event')].length,1);
});

test('reflection recall changes current affect without repeating events, drives, relationships or contact rewards',async t=>{
 const s=setup(t),e=await encountered(s),before=s.store.read(motivationId('s')).snapshot;
 const p=await s.reflect();assert.equal(p.stage,'reflection');assert.equal(p.payload.apperceptionV1.enabled,true);assert.equal(p.payload.current,undefined);
 const d=await s.commit(p,output(p,{mode:'recall',sources:[e],text:'回想当时的失望'}));
 const after=s.store.read(motivationId('s')).snapshot;
 for(const k of ['events','drives','relationships','last_interaction','fatigue_src'])assert.deepEqual(after.engineState[k],before.engineState[k],k);
 assert.notDeepEqual(after.engineState.emotions,before.engineState.emotions);
 assert.equal([...s.store.all('event')].length,1);assert.equal(d.reflection,true);
 assert.equal(s.store.read(motivationId('s')).receipts[0].receipt.effects.policy,'upstream-recall-weighted-v1');
});

test('reappraisal versions the interpretation without rewriting earlier experience or explanation',async t=>{
 const s=setup(t),e=await encountered(s),id=meaningId('s',[e]),old=s.store.read(id),before=s.store.read('e');
 const p=await s.reflect();assert.ok(p.payload.continuity.internalSources.some(x=>x.ref.id===id));
 await s.commit(p,output(p,{mode:'reappraisal',sources:[e],previous:ref(old),text:'我现在保留另一种解释',valence:.5}));
 assert.equal(s.store.read(id).revision,2);assert.deepEqual(s.store.read(id,1),old);assert.deepEqual(s.store.read('e'),before);
 assert.deepEqual(s.store.read(id).value.previous,ref(old));
 const p2=await s.reflect(),o=output(p2,{mode:'reappraisal',sources:[e],previous:ref(s.store.read(id)),text:'我现在保留另一种解释',valence:.5});
 await assert.rejects(s.commit(p2,o),{code:'AFFECT_NO_CHANGE'});
 assert.equal(s.store.read(id).revision,2);
});

test('reappraisal cannot cite a stale interpretation',async t=>{
 const s=setup(t),e=await encountered(s),id=meaningId('s',[e]),p=await s.reflect();
 await assert.rejects(s.commit(p,output(p,{mode:'reappraisal',sources:[e],previous:{id,revision:999}})),{code:'AFFECT_PREVIOUS'});
 assert.equal(s.store.read(motivationId('s')).revision,2);
});

for(const kind of ['undelivered-event','missing-interpretation','forged-concern','encounter-on-reflection'])test(`reject ${kind} without partial affect/history commit`,async t=>{
 const s=setup(t),e=await encountered(s),p=await s.reflect(),o=output(p,{mode:'recall',sources:[e]});
 if(kind==='undelivered-event')o.affectAppraisal.source_refs=[s.event('unseen')];
 if(kind==='missing-interpretation')delete o.apperception;
 if(kind==='forged-concern')o.affectAppraisal.concern_refs=[e];
 if(kind==='encounter-on-reflection')o.affectAppraisal.mode='encounter';
 const before=s.store.read(motivationId('s'));
 await assert.rejects(s.commit(p,o));assert.deepEqual(s.store.read(motivationId('s')),before);
 assert.equal(s.store.read(meaningId('s',[e])).revision,1);assert.equal([...s.store.all('decision')].length,1);
});

test('no appraisal and no apperception are permitted; no emotional report or state write is forced',async t=>{
 const s=setup(t),p=await s.session.prepare(s.args(s.event('e'))),o=proposal(p);await s.commit(p,o);
 assert.equal([...s.store.all('extension_record')].length,0);assert.equal([...s.store.all('personal_state')].length,0);
});

test('extension conflict rolls back decision and engine update in the same transaction',async t=>{
 const s=setup(t),e=s.event('e'),p=await s.session.prepare(s.args(e)),{raw}=await s.capture(p,output(p)),before=s.store.read(motivationId('s'));
 const id=meaningId('s',[e]);
 // A competing theory record must never be overwritten by this turn.

 // Force conflict after candidate calculation, not by silently adopting the latest record.
 const original=s.session.worker;s.session.worker=async x=>{const r=await original(x);if(x.operation?.kind==='experience'&&x.operation.appraisals?.length){const h=s.store.read(id);s.store.execute({requestId:'conflict2',commands:[{op:'put_extension_record',id,owner:'s',theory:'affect',stateType:'event-meaning',schemaVersion:'other',expectedRevision:h?.revision??0,value:{conflict:2}}]});}return r;};
 await assert.rejects(s.session.commit({packet:p,output:raw,requestId:'reject',decisionId:'rejected'}),{code:'EXTENSION_CONFLICT'});
 assert.equal(s.store.read('rejected'),null);assert.deepEqual(s.store.read(motivationId('s')),before);
});

test('captured fusion output survives worker failure without another model call',async t=>{
 const s=setup(t),p=await s.session.prepare(s.args(s.event('e'))),{raw}=await s.capture(p,output(p));
 const worker=s.session.worker;s.session.worker=async()=>{throw Object.assign(Error('worker down'),{code:'WORKER_EXIT'});};
 await assert.rejects(s.session.commit({packet:p,output:raw,requestId:'r',decisionId:'d'}),{code:'WORKER_EXIT'});
 assert.equal(s.store.read(affectTurnId(p)).status,'captured');assert.equal(s.store.read('d'),null);
 s.session.worker=worker;await s.session.commit({packet:p,output:raw,requestId:'r',decisionId:'d'});assert.equal(s.store.read('d').type,'decision');
});

test('restart retains meaning history and completed invocation never resends',async t=>{
 const path=disk(t),s=setup(t,path),e=s.event('e'),args={...s.args(e),requestId:'r',decisionId:'d'};let calls=0;
 await s.session.run({...args,invoke:p=>{calls++;return output(p);}});
 const store=new ContinuityStore(path,{clock:()=>T});t.after(()=>store.close());const restored=new AffectSession({store,subjectId:'s',fusion:true,clock:()=>T});
 const result=await restored.run({...args,invoke:()=>{throw Error('must not send');}});
 assert.equal(result.modelCalled,false);assert.equal(calls,1);assert.equal(store.read(meaningId('s',[e])).revision,1);store.close();s.store.close();
});

test('current target outranks stronger unrelated emotion; full host pagination is read-only',async t=>{
 const s=setup(t);await s.session.initialize(T);
 s.store.execute({requestId:'person',commands:[{op:'write_entity',id:'ann',kind:'person',name:'Ann',aliases:[],description:'合成'}]});
 const m={ref:{id:'m',revision:1},asOf:T,previewHash:'x',projection:{mood:{p:0,a:0,d:0},emotions:Array.from({length:20},(_,i)=>({name:'worry',target:i===19?'ann':'other'+i,intensity:i===19?.01:.9}))}};
 const e=s.event('e'),record=s.store.read(e.id);record.sender={entityId:'ann'};
 const realRead=s.store.read.bind(s.store);s.store.read=(id,rev)=>id===e.id?record:realRead(id,rev);
 const c=fusionContext({store:s.store,subjectId:'s',motivation:m,currentEvent:e});
 assert.equal(c.motivation.projection.emotions[0].target,'ann');assert.equal(c.motivation.selection.omitted,8);
 const before=s.store.read(motivationId('s'));s.session.readEmotions();assert.deepEqual(s.store.read(motivationId('s')),before);
});

test('worker cognitive operations forbid facts and deduplicate actual operation identity',async()=>{
 const {state}=await callWorker({action:'initialize',nowMs:T});
 const operation={id:'recall-once',kind:'cognitive',expectedRevision:0,nowMs:T,source:{id:'recall-source',revision:1},memoryKey:'a'.repeat(64),appraisals:[{weight:1,value:{event:'x'.repeat(80),summary:'合成回忆',valence:.5,intensity:.5,relevance:.5,agency:'self',competence:1}}]};
 await assert.rejects(callWorker({action:'transition',state,operation:{...operation,facts:{contacts:['fake']}}}),{code:'COGNITIVE_FACTS_FORBIDDEN'});
 const a=await callWorker({action:'transition',state,operation}),b=await callWorker({action:'transition',state:a.state,operation});
 assert.deepEqual(b.state,a.state);assert.equal(b.receipt.duplicate,true);assert.equal(a.state.engineState.events,state.engineState.events);
 assert.equal(a.state.cognitiveCounts[operation.memoryKey],1);
 const next=await callWorker({action:'transition',state:a.state,operation:{...operation,id:'recall-twice',source:{id:'recall-second',revision:1},expectedRevision:a.state.revision}});
 assert.equal(next.receipt.effects.timesRecalledBefore,1);assert.equal(next.receipt.effects.components[0].factor,.35*.6);
 assert.deepEqual(next.state.engineState.drives,state.engineState.drives);
});

test('same stored version at a different projection time receives a different source identity',async t=>{
 const s=setup(t),e=s.event('e');await s.session.initialize(T);
 const m={ref:{id:'persisted',revision:1},asOf:T,previewHash:'x',projection:{mood:{p:0,a:0,d:0},emotions:[]}};
 const a=fusionContext({store:s.store,subjectId:'s',motivation:m,currentEvent:e});
 const b=fusionContext({store:s.store,subjectId:'s',motivation:{...m,asOf:T+1000},currentEvent:e});
 assert.deepEqual(a.motivation.ref,b.motivation.ref);assert.notDeepEqual(a.motivation.projectionRef,b.motivation.projectionRef);
});

test('TurnDriver uses fusion for an actual decision and its subsequent reflection with no additional call',async t=>{
 const s=setup(t);let calls=0;
 const driver=new TurnDriver({store:s.store,subjectId:'s',workspace:'w',identity:'离线合成主体',eventBypass:true,
  sessionFactory:affectFactory({fusion:true,clock:()=>T}),decide:p=>{
   calls++;assert.equal(p.payload.apperceptionV1.enabled,true);
   if(p.payload.current)return output(p);
   const o=proposal(p);delete o.continuity.observationDisposition;delete o.continuity.expressionChoice;return o;
  }});
 driver.ingest({key:'message',body:'合成测试消息',scene:'synthetic',at:T});
 assert.equal((await driver.tick({now:T,eventBypass:true})).action,'decided');
 assert.equal((await driver.tick({now:T,followup:{id:'follow',targetScene:'synthetic'}})).action,'reflected');
 assert.equal(calls,2);assert.equal([...s.store.all('decision')].length,2);
});

test('disabling affect on the same database preserves history and ordinary decisions still work',async t=>{
 const s=setup(t),e=await encountered(s),history=s.store.read(meaningId('s',[e])),state=s.store.read(motivationId('s'));
 const plain=new ContinuitySession({store:s.store,subjectId:'s',attention:true,maxForeground:16});
 const p=plain.prepare(s.args(s.event('plain')));
 assert.equal(p.payload.continuity.motivation,undefined);assert.equal(p.payload.continuity.internalSources,undefined);
 plain.commit({packet:p,output:proposal(p),requestId:'request:plain',decisionId:'decision:plain'});
 assert.deepEqual(s.store.read(motivationId('s')),state);assert.deepEqual(s.store.read(history.id),history);
 const legacy=new AffectSession({store:s.store,subjectId:'s',clock:()=>T});
 const lp=await legacy.prepare(s.args(s.event('legacy'))),o=proposal(lp);
 o.affectAppraisal={source_refs:[ref(lp.payload.current)],appraisals:[{weight:1,value:{event:'ordinary',summary:'原协议仍可用',valence:0,intensity:0,relevance:0,agency:'circumstance'}}]};
 const raw=await legacy.invoke(lp,()=>o);await legacy.commit({packet:lp,output:raw,requestId:'request:legacy',decisionId:'decision:legacy'});
 assert.deepEqual(s.store.read(history.id),history);assert.equal(s.store.read('decision:legacy').type,'decision');
});

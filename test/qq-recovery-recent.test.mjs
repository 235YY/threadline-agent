import test from 'node:test';import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';import {ContinuitySession} from '../src/continuity-session.mjs';
const server=await import(process.env.JY_TEST_PREVIOUS_HANDOFF==='1'?new URL('../../candidate-v5/tools/brain-service/server.mjs',import.meta.url):new URL('../tools/brain-service/server.mjs',import.meta.url));
const handoff=server.focusedProcessMaterials,ref=r=>({id:r.id,revision:r.revision});
function fixture(){const store=new ContinuityStore(':memory:');store.execute({requestId:'seed',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'private:7',focus:{id:'now',label:'now'}},...['prior','now','other'].map(id=>({op:'append_event',id,body:id==='prior'?'earlier conversation':id,origin:'reported',actor:'fixture',scene:id==='other'?'private:8':'private:7',occurredAt:id==='prior'?1000:2000,source:{system:'fixture',key:id}}))]});const session=new ContinuitySession({store,subjectId:'s',attention:true});return {store,session};}
test('a concern citing an earlier visible chat message can commit only after its complete pinned event is delivered',()=>{
 const {store,session}=fixture();try{
  const materials=handoff({store,subjectId:'s',event:{id:'now',revision:1}}),packet=session.prepare({workspace:{id:'w',revision:1},currentEvent:{id:'now',revision:1},materials,mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072});
  const out={packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'ordinary response'}}],selected:'r',summary:'synthetic counterexample',used:[],continuity:{changes:[{id:'concern',expectedRevision:0,kind:'concern',nature:'encounter',body:'a qualified concern about the conversation',scope:['private:7'],mind:{role:'concern',confidence:'uncertain',orientation:'seek',unresolved:[]},basis:{observations:[{id:'prior',revision:1},{id:'now',revision:1}],priorStates:[],memories:[]}}],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};
  session.commit({packet,requestId:'commit',decisionId:'d',output:out});assert.equal(store.read('concern').body,out.continuity.changes[0].body);assert.equal(packet.payload.materials.find(m=>m.ref.id==='prior').record.body,'earlier conversation');
 }finally{store.close();}
});
test('another conversation and the current event are not smuggled into historical materials',()=>{const {store}=fixture();try{const rows=handoff({store,subjectId:'s',event:{id:'now',revision:1}});assert.deepEqual(rows,[{ref:{id:'prior',revision:1},aspect:'experience'}]);}finally{store.close();}});
test('a large timeline keeps the newest bounded sources and reserves room for actual lookups',()=>{const {store}=fixture();try{
 store.execute({requestId:'many',commands:Array.from({length:40},(_,i)=>({op:'append_event',id:'history-'+i,body:'event '+i,origin:'reported',actor:'fixture',scene:'private:7',occurredAt:3000+i,source:{system:'fixture',key:'history-'+i}}))});
 const rows=handoff({store,subjectId:'s',event:{id:'now',revision:1}});assert.equal(rows.length,16);assert.ok(rows.some(r=>r.ref.id==='history-39'));assert.ok(!rows.some(r=>r.ref.id==='history-0'));
}finally{store.close();}});
test('recent text is not used as a fabricated full source: long messages use the real fixed record and normal packet budget still applies',()=>{
 const {store,session}=fixture();try{store.execute({requestId:'long',commands:[{op:'append_event',id:'long',body:'whole '.repeat(24000),origin:'reported',actor:'fixture',scene:'private:7',occurredAt:1500,source:{system:'fixture',key:'long'}}]});
  const rows=handoff({store,subjectId:'s',event:{id:'now',revision:1}});assert.ok(rows.some(r=>r.ref.id==='long'&&r.ref.revision===1));
  assert.throws(()=>session.prepare({workspace:{id:'w',revision:1},currentEvent:{id:'now',revision:1},materials:rows,budgetBytes:8192}),{code:'INPUT_OVERFLOW'});
 }finally{store.close();}
});

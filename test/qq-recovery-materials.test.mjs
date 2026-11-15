import test from 'node:test';import assert from 'node:assert/strict';
import {focusedProcessMaterials} from '../tools/brain-service/server.mjs';import {ContinuityStore} from '../src/store.mjs';import {ContinuitySession} from '../src/continuity-session.mjs';import {attentionId} from '../src/attention.mjs';import {verifiedModelInput} from '../src/cognition.mjs';
test('focused fixed source becomes a full qualified material in the sealed request and supports a process update',()=>{
 const store=new ContinuityStore(':memory:');try{
 store.execute({requestId:'seed',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'now'}},...['old','now'].map(id=>({op:'append_event',id,body:id==='old'?'original fixed evidence':'new feedback',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:1000,source:{system:'fixture',key:id}}))]});
 const session=new ContinuitySession({store,subjectId:'s',attention:true}),frame={subject:'s',focus:{selection:[{kind:'process',id:'p'}]},processes:[{id:'p',basis:[{id:'old',revision:1}]},{id:'unselected',basis:[{id:'not-readable',revision:1}]}]};
 const reader={read:(id,rev)=>id===attentionId('s')?frame:store.read(id,rev),all:type=>store.all(type)};
 const materials=focusedProcessMaterials({store:reader,subjectId:'s',event:{id:'now',revision:1}});assert.deepEqual(materials,[{ref:{id:'old',revision:1},aspect:'experience'}]);
 const p=session.prepare({workspace:{id:'w',revision:1},currentEvent:{id:'now',revision:1},materials,mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072});
 assert.equal(p.payload.materials[0].record.body,'original fixed evidence');assert.equal(verifiedModelInput(p).bytes,p.bytes);
 const d=session.commit({packet:p,requestId:'finish',decisionId:'finish',output:{packetId:p.packetId,options:[{id:'r',kind:'respond',payload:{text:'offline result'}}],selected:'r',summary:'synthetic',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[{id:'done',expectedRevision:0,label:'done',body:'offline',status:'completed',world:'actual',intervals:[],basis:[{id:'old',revision:1},{id:'now',revision:1}]}],relations:[],residency:{upsert:[],remove:[]},questions:[]}}}});assert.equal(d.id,'finish');
 }finally{store.close();}
});
test('a missing pinned version never falls back to the latest version or grants a personal-state read',()=>{
 const frame={subject:'s',focus:{selection:[{kind:'process',id:'p'}]},processes:[{id:'p',basis:[{id:'old',revision:1}]}]},seen=[];
 const store={read:(id,rev)=>{seen.push([id,rev]);return id===attentionId('s')?frame:rev===undefined?{type:'event',revision:2}:null;}};
 assert.throws(()=>focusedProcessMaterials({store,subjectId:'s',event:{id:'now',revision:1}}),{code:'PROCESS_MATERIAL_MISSING'});assert.ok(!seen.some(([id,rev])=>id==='old'&&rev===undefined));
});
test('current source is not duplicated; oversized dependency sets fail explicitly before model use',()=>{
 const frame={subject:'s',focus:{selection:[{kind:'process',id:'p'}]},processes:[{id:'p',basis:[{id:'now',revision:1}]}]},store={read:()=>frame};
 assert.deepEqual(focusedProcessMaterials({store,subjectId:'s',event:{id:'now',revision:1}}),[]);
 frame.processes[0].basis=Array.from({length:33},(_,i)=>({id:'e'+i,revision:1}));assert.throws(()=>focusedProcessMaterials({store,subjectId:'s',event:{id:'now',revision:1}}),{code:'PROCESS_MATERIAL_LIMIT'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId,keepAttention} from '../src/attention.mjs';
import {eventProcessId,eventProcessLinks,threadUnits,taskThreads} from '../src/task-threads.mjs';
import {prepareReflection,commitDecision,verifiedModelInput} from '../src/cognition.mjs';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {put,event,frame,ref,memory,disk} from './helpers.mjs';
const pin=(id,revision=1)=>({id,revision});
const proc=(id,status='active',expectedRevision=0)=>({id,expectedRevision,label:id,body:id+' research',status,world:'actual',intervals:[],basis:[]});
function setup(t,file=null){
 const store=file?new ContinuityStore(file):memory(t).store;if(file)t.after(()=>store.close());
 const session=new ContinuitySession({store,subjectId:'S',attention:true});
 const [e,w]=put(store,'init',event('initial',{body:'Two independent investigations'}),frame());
 return {store,session,e,w,n:0};
}
const prepare=(s,extra={})=>s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,taskThreads:true,subjectiveMemoryV2:true,...extra});
const ordinaryOutput=(p,attention=keepAttention(),changes=[])=>({packetId:p.packetId,options:[{id:'wait',kind:'wait',payload:{}}],selected:'wait',summary:'explicit attribution fixture',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}});
const output=(p,attention=keepAttention(),changes=[])=>{const out=ordinaryOutput(p,attention,changes);if(p.stage==='reflection'){delete out.continuity.expressionChoice;delete out.continuity.observationDisposition;}return out;};
function commit(s,attention=keepAttention(),{materials=[],changes=[],p=null,id=null,extra={}}={}){p??=prepare(s,{materials,...extra});id??='d-'+(++s.n);return s.session.commit({packet:p,output:output(p,attention,changes),decisionId:id,requestId:id});}
const delta=(processes=[],add=[],remove=[])=>({...keepAttention(),processes,eventProcesses:{add,remove}});
const pair=(e,p,revision=1)=>({event:ref(e),process:pin(p,revision)});
const material=e=>({ref:ref(e),aspect:'experience'});
const history=(s,p)=>threadUnits({store:s.store,subjectId:'S',threadId:p}).units;
function next(s,body='Unrelated ordinary message') {s.e=put(s.store,'e-'+(++s.n),event('e-'+s.n,{body})).at(-1);return s.e;}
const record=(s,e,p)=>s.store.read(eventProcessId('S',ref(e),p));

test('no proposal leaves ordinary QQ event unassigned; capability is explicit',t=>{
 const s=setup(t),p=prepare(s);assert.deepEqual(p.payload.continuity.attention.eventProcessSupport.events,[ref(s.e)]);
 commit(s);assert.equal(eventProcessLinks({store:s.store,subjectId:'S'}).length,0);assert.equal(s.store.read(s.e.id).threadId,undefined);
});
test('one event can explicitly belong to A and B; unrelated events do not leak',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A'),proc('B')],[pair(source,'A'),pair(source,'B')]));
 next(s);const q=prepare(s);assert.equal(history(s,'A').length,1);assert.equal(history(s,'B').length,1);
 assert.ok(q.payload.continuity.threads.foreground.units.some(u=>u.id===source.id));
 assert.ok(!history(s,'A').some(u=>u.id===s.e.id));assert.equal(s.store.read(source.id).threadId,undefined);
 assert.equal(record(s,source,'A').value.processSource.ref.revision,1);
});
test('Process revision advances without breaking stable identity; repeated links are idempotent',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A')],[pair(source,'A'),pair(source,'A')]));const original=record(s,source,'A');
 next(s);commit(s,delta([proc('A','active',1)],[pair(source,'A')]),{materials:[material(source)]});
 assert.deepEqual(record(s,source,'A'),original);assert.equal(s.store.read(attentionId('S')).processes[0].revision,2);
 assert.equal(history(s,'A')[0].ref.id,source.id);
 next(s);commit(s,delta([],[pair(source,'A',2)]),{materials:[material(source)]});assert.deepEqual(record(s,source,'A'),original);
});
test('withdrawal affects only A, preserves version1, re-link is a new version',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A'),proc('B')],[pair(source,'A'),pair(source,'B')]));
 next(s);commit(s,delta([],[],[pair(source,'A')]),{materials:[material(source)]});
 assert.equal(history(s,'A').length,0);assert.equal(history(s,'B').length,1);
 const old=record(s,source,'A');assert.equal(old.revision,2);assert.equal(s.store.read(old.id,1).value.status,'active');
 next(s);commit(s,delta([],[],[pair(source,'A')]),{materials:[material(source)]});assert.deepEqual(record(s,source,'A'),old);
 next(s);commit(s,delta([],[pair(source,'A')]),{materials:[material(source)]});assert.equal(record(s,source,'A').revision,3);assert.equal(history(s,'A').length,1);
});
test('legacy threadId union does not duplicate and explicit withdrawal preserves legacy fact',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));s.e=put(s.store,'legacy',event('legacy',{threadId:'A'})).at(-1);
 commit(s,delta([],[pair(s.e,'A')]));assert.equal(history(s,'A').length,1);
 const source=s.e;next(s);commit(s,delta([],[],[pair(source,'A')]),{materials:[material(source)]});assert.equal(history(s,'A').length,1);
});
test('UNDELIVERED_EVENT rejects recent-only snippet, atomic Decision/Attention/state rollback',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));const old=s.e;next(s);const p=prepare(s),before=s.store.read(attentionId('S'));
 assert.ok(p.payload.continuity.recent.items.some(x=>x.ref.id===old.id));
 assert.throws(()=>commit(s,delta([proc('B')],[pair(old,'B')]),{p,id:'reject-undelivered',changes:[{id:'rollback-state',expectedRevision:0,kind:'feeling',body:'fixture',nature:'self-report',status:'open',scope:[]}]}),e=>e.code==='UNDELIVERED_EVENT');
 assert.equal(s.store.read('reject-undelivered'),null);assert.equal(s.store.read('rollback-state'),null);assert.deepEqual(s.store.read(attentionId('S')),before);
 assert.equal(record(s,old,'B'),null);
});
test('cross-subject event and foreign Process are rejected',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));const other=new ContinuitySession({store:s.store,subjectId:'T',attention:true});
 const foreign=put(s.store,'foreign-event',event('foreign')).at(-1);other.prepare({currentEvent:ref(foreign),workspace:ref(s.w),budgetBytes:131072});
 next(s);assert.throws(()=>commit(s,delta([],[pair(foreign,'A')]),{materials:[material(foreign)]}),e=>e.code==='EVENT_SUBJECT');
 assert.throws(()=>commit(s,delta([],[pair(s.e,'T-only')])),e=>e.code==='PROCESS_SUBJECT');
});
test('undelivered Process version and Event version refuse association',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));next(s);
 assert.throws(()=>commit(s,delta([],[pair(s.e,'A',99)])),e=>e.code==='UNREAD_PROCESS');
 const wrong={event:pin(s.e.id,2),process:pin('A')};assert.throws(()=>commit(s,delta([],[wrong])),e=>e.code==='MISSING_REFERENCE'||e.code==='REFERENCE_TYPE');
});
test('conflicting add/remove and disabled capability refuse; stale packet cannot resurrect withdrawal',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A')],[pair(source,'A')]));next(s);
 assert.throws(()=>commit(s,delta([],[pair(source,'A')],[pair(source,'A')]),{materials:[material(source)]}),e=>e.code==='EVENT_PROCESS_CONFLICT');
 assert.throws(()=>commit(s,delta([],[pair(source,'A')]),{materials:[material(source)],extra:{taskThreads:false}}),e=>e.code==='EVENT_PROCESS_DISABLED');
 const stale=prepare(s,{materials:[material(source)]});commit(s,delta([],[],[pair(source,'A')]),{p:stale});
 assert.throws(()=>commit(s,delta([],[pair(source,'A')]),{p:stale}),e=>e.code==='STALE_SUBJECT'||e.code==='VERSION_CONFLICT');assert.equal(record(s,source,'A').value.status,'withdrawn');
});
test('completed A keeps stored associations and B history; background is bounded metadata',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A'),proc('B')],[pair(source,'A'),pair(source,'B')]));next(s);commit(s,delta([proc('A','completed',1)]));
 assert.equal(history(s,'A').length,1);assert.equal(history(s,'B').length,1);const q=prepare(s);assert.equal(q.payload.continuity.threads.foreground.id,'B');
 assert.equal(record(s,source,'A').value.status,'active');
});
test('Schema12 restart preserves withdrawn A/active B and pinned historical source',t=>{
 const file=disk(t),s=setup(t,file),source=s.e;commit(s,delta([proc('A'),proc('B')],[pair(source,'A'),pair(source,'B')]));next(s);commit(s,delta([],[],[pair(source,'A')]),{materials:[material(source)]});
 s.store.close();const reopened=new ContinuityStore(file);try{assert.equal(SCHEMA_VERSION,12);const ss={...s,store:reopened};assert.equal(history(ss,'A').length,0);assert.equal(history(ss,'B').length,1);assert.equal(reopened.read(record(ss,source,'A').id,1).value.status,'active');}finally{reopened.close();}
});
test('reflection uses the same explicit contract and atomic commit',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A')]));
 const p=prepareReflection({store:s.store,subjectId:'S',workspace:ref(s.w),internal:{format:'reflection-frame-v1'},materials:[material(source)],taskThreads:true,budgetBytes:131072});
 const result=commitDecision({store:s.store,packet:p,output:output(p,delta([],[pair(source,'A')])),decisionId:'reflect-link',requestId:'reflect-link'});
 assert.equal(result.reflection,true);assert.equal(history(s,'A').length,1);
});


test('same shared Event has only own-subject exchanges in explicitly linked history',t=>{
 const s=setup(t),source=s.e;commit(s,delta([proc('A')],[pair(source,'A')]));
 const other=new ContinuitySession({store:s.store,subjectId:'T',attention:true});
 const p=other.prepare({currentEvent:ref(source),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,taskThreads:true});
 const out=output(p,delta([proc('T-only')],[pair(source,'T-only')]));out.summary='private T interpretation';
 other.commit({packet:p,output:out,decisionId:'T-decision',requestId:'T-decision'});
 const ours=history(s,'A');assert.ok(ours[0].exchanges.length>0);assert.ok(!JSON.stringify(ours).includes('private T interpretation'));assert.ok(!JSON.stringify(ours).includes('T-decision'));
 assert.equal(eventProcessLinks({store:s.store,subjectId:'S'}).length,1);assert.equal(eventProcessLinks({store:s.store,subjectId:'T'}).length,1);
});

test('budget compaction includes eligible event directory before sealing; exact re-seal stable',t=>{
 const s=setup(t);for(let i=0;i<70;i++)put(s.store,'bulk'+i,event('bulk'+i,{body:'context '.repeat(150),occurredAt:1100+i}));
 s.store.execute({requestId:'admit-bulk',commands:Array.from({length:70},(_,i)=>({op:'admit_subject_event',subjectId:'S',event:{id:'bulk'+i,revision:1}}))});
 next(s);const materials=[];for(let i=0;i<20;i++)materials.push(material(s.store.read('bulk'+i)));
 const p=prepare(s,{materials,capabilities:[],budgetBytes:98304});
 assert.equal(p.payload.continuity.attention.eventProcessSupport.events.length,21);
 assert.ok(p.bytes<=98304);assert.ok(p.payload.continuity.recent.items.some(x=>x.bodyDelivery)||p.payload.continuity.recent.omitted>0);
 assert.doesNotThrow(()=>verifiedModelInput(p));
});


test('late failure rolls back association, Decision, Attention and subject together',t=>{
 const s=setup(t),p=prepare(s),before=s.store.read(attentionId('S')),subject=s.store.read('S');
 assert.throws(()=>s.session.commit({packet:p,output:output(p,delta([proc('A')],[pair(s.e,'A')])),decisionId:'late-fail',requestId:'late-fail',extensionWrites:[{id:'extension:missing:x:test',owner:'missing',theory:'x',stateType:'x',schemaVersion:'1',value:{}}]}),e=>e.code==='EXTENSION_OWNER');
 assert.equal(s.store.read('late-fail'),null);assert.equal(record(s,s.e,'A'),null);assert.deepEqual(s.store.read(attentionId('S')),before);assert.deepEqual(s.store.read('S'),subject);
});
test('exact committed request replay does not create another association version',t=>{
 const s=setup(t),p=prepare(s),patch=delta([proc('A')],[pair(s.e,'A')]);commit(s,patch,{p,id:'fixed-request'});const before=record(s,s.e,'A');commit(s,patch,{p,id:'fixed-request'});assert.deepEqual(record(s,s.e,'A'),before);
});
test('existing but not delivered Process cannot acquire an event',t=>{
 const s=setup(t);commit(s,delta(Array.from({length:16},(_,i)=>proc('A'+String(i).padStart(2,'0')))));next(s);commit(s,delta([proc('Z-hidden')]));next(s);const p=prepare(s);
 assert.ok(!p.payload.continuity.attention.processes.some(x=>x.id==='Z-hidden'));
 assert.throws(()=>commit(s,delta([],[pair(s.e,'Z-hidden')]),{p}),e=>e.code==='UNREAD_PROCESS');
});


test('same Process ID in another subject cannot expose foreign legacy event body',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));const other=new ContinuitySession({store:s.store,subjectId:'T',attention:true});
 const foreign=put(s.store,'T-source',event('T-source',{threadId:'A',body:'foreign private incoming body'})).at(-1);
 other.prepare({currentEvent:ref(foreign),workspace:ref(s.w),budgetBytes:131072});
 assert.ok(!JSON.stringify(history(s,'A')).includes('foreign private incoming body'));
 const threads=taskThreads({store:s.store,frame:s.store.read(attentionId('S')),foregroundId:'A'});assert.equal(threads.foreground.history.total,0);
 assert.ok(!JSON.stringify(threads).includes('foreign private incoming body'));
 assert.equal(threadUnits({store:s.store,threadId:'A'}).units.length,1,'legacy unscoped API remains unchanged');
});

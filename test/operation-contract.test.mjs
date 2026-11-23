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


import {runtimeFeedback} from '../src/runtime-feedback.mjs';
test('typed catalog separates Process, personal state and used materials; seal stays stable',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));next(s);const p=prepare(s);
 assert.equal(p.payload.operationContract.processes[0].type,'process');assert.equal(p.payload.operationContract.processes[0].updatePath,'continuity.attention.processes');
 assert.deepEqual(p.payload.operationContract.personalStates,[]);assert.deepEqual(p.payload.operationContract.usedMaterials,[]);assert.doesNotThrow(()=>verifiedModelInput(p));
});
test('Process id in continuity.changes is a precise WRONG_OBJECT_KIND, never a silent shadow state',t=>{
 // Real-run failure: two Process ids were copied into personal_state updates.
 for(const [label,extra] of [['process revision',{expectedRevision:1}],['zero revision',{expectedRevision:0}],['omitted revision',{}]]){
  const s=setup(t);commit(s,delta([proc('A')]));next(s);const p=prepare(s),id='bad-'+label.replace(' ','-');
  assert.throws(()=>commit(s,keepAttention(),{p,id,changes:[{id:'A',...extra,kind:'activity',body:'x',status:'open',nature:'self-report'}]}),
   e=>e.code==='WRONG_OBJECT_KIND'&&e.details.updatePath==='continuity.attention.processes'&&e.details.id==='A',label);
  assert.equal(s.store.read(id),null,label);assert.equal(s.store.read('A'),null,label);
  const feedback=runtimeFeedback({store:s.store,subjectId:'S',now:2000}).recentFeedback.find(x=>x.error==='WRONG_OBJECT_KIND');
  assert.ok(feedback,label);assert.equal(feedback.adopted,false);assert.equal(feedback.execution,'not-started');
 }
});
test('omitted revisions are derived from this packet only; explicit wrong revisions stay strict',t=>{
 const s=setup(t);
 // New personal state and new Process without expectedRevision.
 commit(s,delta([(({expectedRevision,...p})=>p)(proc('A'))]),{changes:[{id:'state-new',kind:'feeling',body:'curious',status:'open',nature:'self-report'}]});
 assert.equal(s.store.read('state-new').revision,1);assert.equal(s.store.read(attentionId('S')).processes[0].revision,1);
 const audit=[...s.store.all('extension_record')].filter(r=>r.stateType==='proposal-normalization').flatMap(r=>r.value.diagnostics).filter(d=>d.code==='EXPECTED_REVISION_DERIVED');
 assert.deepEqual(audit.map(d=>[d.path,d.value,d.basis]).sort(),[['continuity.attention.processes[0].expectedRevision',0,'new-process'],['continuity.changes[0].expectedRevision',0,'new-state']]);
 // Update the delivered Process without expectedRevision: derived from the delivered frame.
 next(s);commit(s,delta([{id:'A',label:'A',body:'A research, second step',status:'active',world:'actual',intervals:[],basis:[]}]));
 assert.equal(s.store.read(attentionId('S')).processes[0].revision,2);
 // An explicit stale revision is still a conflict, not silently corrected.
 next(s);assert.throws(()=>commit(s,delta([proc('A','active',1)])),e=>e.code==='PROCESS_CONFLICT');
 // Existing but undelivered personal state: reported as unread, not as a revision mismatch.
 next(s);assert.throws(()=>commit(s,keepAttention(),{changes:[{id:'state-new',body:'changed',nature:'reappraisal'}]}),e=>e.code==='UNREAD_STATE');
 assert.equal(s.store.read('state-new').revision,1);
});
test('used rejection lists exact allowed materials and leaves proposal unadopted',t=>{
 const s=setup(t),p=prepare(s);const out=output(p);out.used=[{ref:ref(s.e),aspect:'knowledge',effect:'context'}];
 assert.throws(()=>s.session.commit({packet:p,output:out,decisionId:'bad-used',requestId:'bad-used'}),e=>e.code==='UNDELIVERED_REFERENCE'&&e.details.path==='used'&&e.details.allowedMaterials.length===0);
 assert.equal(s.store.read('bad-used'),null);assert.equal(runtimeFeedback({store:s.store,subjectId:'S',now:2000}).recentFeedback[0].details.path,'used');
});
test('legitimate new personal state remains autonomous and accepted without borrowing Process ID',t=>{
 const s=setup(t);commit(s,delta([proc('A')]),{changes:[{id:'state-separate',expectedRevision:0,kind:'feeling',body:'feeling',status:'open',nature:'self-report'}]});
 assert.equal(s.store.read('state-separate').kind,'feeling');assert.equal(s.store.read(attentionId('S')).processes[0].id,'A');
});
test('delivered personal state is revised without the model transcribing its revision',t=>{
 const store=memory(t).store,session=new ContinuitySession({store,subjectId:'P'});
 let [e,w]=put(store,'init',event('first',{body:'hello'}),frame());
 const run=(id,changes)=>{const p=session.prepare({currentEvent:ref(e),workspace:ref(w),budgetBytes:131072});
  return {p,d:session.commit({packet:p,output:{packetId:p.packetId,options:[{id:'wait',kind:'wait',payload:{}}],selected:'wait',summary:'s',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled'}},decisionId:id,requestId:id})};};
 run('d1',[{id:'mood',kind:'feeling',body:'calm',status:'open',nature:'self-report'}]);
 e=put(store,'e2',event('second',{body:'again'})).at(-1);
 const {p}=run('d2',[{id:'mood',body:'a little tired',nature:'reappraisal'}]);
 assert.ok(p.payload.continuity.foreground.some(s=>s.ref.id==='mood'&&s.ref.revision===1));
 const mood=store.read('mood');assert.equal(mood.revision,2);assert.equal(mood.body,'a little tired');assert.deepEqual(mood.predecessor,{id:'mood',revision:1});
 e=put(store,'e3',event('third',{body:'later'})).at(-1);
 assert.throws(()=>run('d3',[{id:'mood',expectedRevision:1,body:'stale',nature:'reappraisal'}]),err=>err.code==='STATE_CONFLICT');
 assert.equal(store.read('mood').revision,2);
});

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
test('STATE_CONFLICT gives precise personal-state revision and next-opportunity feedback without adopting',t=>{
 const s=setup(t);commit(s,delta([proc('A')]));next(s);const p=prepare(s);
 assert.throws(()=>commit(s,keepAttention(),{p,id:'bad-state',changes:[{id:'A',expectedRevision:1,kind:'activity',body:'x',status:'open',nature:'self-report'}]}),e=>e.code==='STATE_CONFLICT'&&e.details.actualPersonalStateRevision===0&&e.details.path==='continuity.changes');
 assert.equal(s.store.read('bad-state'),null);assert.equal(s.store.read('A'),null);
 const feedback=runtimeFeedback({store:s.store,subjectId:'S',now:2000}).recentFeedback.find(x=>x.error==='STATE_CONFLICT');assert.ok(feedback);assert.equal(feedback.adopted,false);assert.equal(feedback.execution,'not-started');
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

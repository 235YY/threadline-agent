import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {prepareDecision,commitDecision} from '../src/cognition.mjs';
import {keepAttention} from '../src/attention.mjs';
import {stateCard,normalizeDomains} from '../src/personal-state.mjs';
import {readPersonalState,stateCandidates} from '../src/continuity.mjs';
import {anchorView} from '../src/anchor.mjs';
import {put,event,frame,ref,note,memory} from './helpers.mjs';

const pin=(id,revision=1)=>({id,revision});
const mindMeta=role=>({role,confidence:'tentative',unresolved:[],
  ...(role==='concern'?{orientation:'seek'}:role==='condition'?{assessment:'unknown'}
    :role==='expectation'?{action:{tool:'fixture.ping',args:{}},when:{constant:true},likelihood:'possible',effects:[]}
    :role==='readiness'?{concerns:[],appraisals:[],conditions:[],expectations:[]}:{alternatives:[]})});
const roleKind={belief:'appraisal',concern:'concern',condition:'condition',expectation:'expectation',readiness:'readiness'};
function state(id,role,body,domains,extra={}){
  return {id,expectedRevision:0,kind:roleKind[role],body,status:'open',scope:['qq:brother'],nature:'self-report',
    mind:mindMeta(role),...(domains!==undefined?{domains}:{}),...extra};
}
function setup(t){
  const holder=memory(t),store=holder.store;
  const session=new ContinuitySession({store,subjectId:'p0',attention:true});
  const [e,w]=put(store,'p0-init',event('p0-e1',{sender:{system:'fixture',id:'sender',name:'朋友',entityId:'e1',isOwner:false}}),frame());
  return {store,session,e,w,seq:0,holder};
}
function nextEvent(s){
  const id=`p0-e${++s.seq+1}`;[s.e]=put(s.store,`p0-event-${id}`,event(id,{sender:{system:'fixture',id:'sender',name:'朋友',entityId:'e1',isOwner:false}}));return s.e;
}
function prepare(s,extra={}){
  return s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,
    workbenchFocus:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,subjectiveDomains:true,anchorDirectory:true,...extra});
}
function output(p,{changes=[],attention=keepAttention()}={}){
  return {packetId:p.packetId,options:[{id:'choice',kind:'wait',payload:{}}],selected:'choice',
    summary:'P0 fixture',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,
    observationDisposition:'handled',attention}};
}
function commit(s,{changes=[],attention=keepAttention(),extra={}}={}){
  const p=prepare(s,extra),id=`p0-decision-${++s.seq}`;
  return s.session.commit({packet:p,output:output(p,{changes,attention}),decisionId:id,requestId:id,allowedActionTools:[]});
}

test('T1 五种 BCRZ 角色兼容，domains 不改变 role',t=>{
  const s=setup(t);
  commit(s,{changes:[
    state('b','belief','我有一种判断',['self']),
    state('c','concern','我在意一件事',['relationship']),
    state('r','condition','条件未知',['world']),
    state('e','expectation','我预期一个结果',['world','self']),
    state('z','readiness','我准备继续',['self','relationship'])
  ]});
  for(const [id,role] of [['b','belief'],['c','concern'],['r','condition'],['e','expectation'],['z','readiness']]){
    assert.equal(s.store.read(id).mind.role,role);
    assert.ok(Array.isArray(s.store.read(id).domains));
  }
});

test('T2/T3 domains 单选、多选、空与非法值',t=>{
  const s=setup(t);
  commit(s,{changes:[
    state('single','belief','单选',['self']),
    state('multi','belief','多选',['relationship','self']),
    state('empty','belief','空',[])
  ]});
  assert.deepEqual(s.store.read('single').domains,['self']);
  assert.deepEqual(s.store.read('multi').domains,['relationship','self']);
  assert.deepEqual(s.store.read('empty').domains,[]);
  assert.throws(()=>normalizeDomains(['bad']),e=>e.code==='INVALID_INPUT');
  const before=[...s.store.all('personal_state')].length;
  assert.throws(()=>commit(s,{changes:[state('illegal','belief','非法',['bad'])]}),e=>e.code==='INVALID_INPUT');
  assert.equal([...s.store.all('personal_state')].length,before);
});

test('T4/T5/T6 state 更新保留、显式清空 domains',t=>{
  const s=setup(t);
  commit(s,{changes:[state('keep','belief','旧正文',['self','relationship'])]});
  nextEvent(s);
  commit(s,{changes:[{id:'keep',expectedRevision:1,body:'新正文',nature:'reappraisal'}],extra:{stateRefs:[pin('keep')]}});
  assert.deepEqual(s.store.read('keep').domains,['relationship','self']);
  nextEvent(s);
  commit(s,{changes:[{id:'keep',expectedRevision:2,domains:[],nature:'reappraisal'}],extra:{stateRefs:[pin('keep',2)]}});
  assert.deepEqual(s.store.read('keep').domains,[]);
});

test('T4 note 保存、更新保留、显式清空 domains',t=>{
  const s=setup(t);
  put(s.store,'p0-note',note('p0-note',[],{domains:['self','relationship']}));
  assert.deepEqual(s.store.read('p0-note').domains,['relationship','self']);
  put(s.store,'p0-note-update',{op:'write_note',id:'p0-note',expectedRevision:1,body:'更新',kind:'interpretation',change:'self_report',evidence:[]});
  assert.deepEqual(s.store.read('p0-note').domains,['relationship','self']);
  put(s.store,'p0-note-clear',{op:'write_note',id:'p0-note',expectedRevision:2,body:'清除',kind:'interpretation',change:'self_report',evidence:[],domains:[]});
  assert.deepEqual(s.store.read('p0-note').domains,[]);
});

test('T7 旧记录无 domains 可读，stateCard 不伪造',t=>{
  const s=setup(t);
  commit(s,{changes:[state('old','belief','旧记录',undefined)]});
  assert.equal(Object.hasOwn(s.store.read('old'),'domains'),false);
  const card=stateCard(s.store.read('old'));
  assert.equal(Object.hasOwn(card,'domains'),false);
  put(s.store,'p0-old-note',note('p0-old-note',[]));
  assert.equal(Object.hasOwn(s.store.read('p0-old-note'),'domains'),false);
});

test('T8/T9 anchor directory 不泄漏正文，closed/historical 有准入',t=>{
  const s=setup(t);
  commit(s,{changes:[state('anchored','belief','锚定正文',['relationship'],{anchor:{kind:'entity',id:'e1'},status:'open'})]});
  put(s.store,'p0-note-anchor',note('p0-note-anchor',[],{body:'笔记正文',domains:['self'],anchor:{kind:'entity',id:'e1'}}));
  const normal=anchorView({store:s.store,subjectId:'p0',currentEvent:s.store.read(s.e.id,s.e.revision),mode:'directory',limit:12});
  assert.ok(normal.records.length>=2);
  for(const r of normal.records){
    assert.equal(Object.hasOwn(r,'body'),false);
    assert.equal(r.bodyAvailable,false);
    assert.ok(r.ref);
  }
  commit(s,{changes:[{id:'anchored',expectedRevision:1,status:'closed',nature:'reappraisal'}],extra:{stateRefs:[pin('anchored')]}});
  const hidden=anchorView({store:s.store,subjectId:'p0',currentEvent:s.store.read(s.e.id,s.e.revision),mode:'directory',limit:12});
  assert.equal(hidden.records.some(r=>r.ref.id==='anchored'),false);
  const history=anchorView({store:s.store,subjectId:'p0',currentEvent:s.store.read(s.e.id,s.e.revision),mode:'directory',limit:12,includeHistorical:true});
  assert.equal(history.records.some(r=>r.ref.id==='anchored'),true);
  assert.equal(history.records.find(r=>r.ref.id==='anchored').bodyAvailable,false);
});

test('T10/T11 20 条材料先过滤后截断，omitted=4',t=>{
  const s=setup(t);
  const world=[];for(let i=1;i<=8;i++)world.push(state(`w${i}`,'belief',`world ${i}`,['world']));
  commit(s,{changes:world});
  const relation=[];for(let i=1;i<=12;i++)relation.push(state(`r${i}`,'belief',`relationship ${i}`,['relationship']));
  for(let i=0;i<12;i+=8){nextEvent(s);commit(s,{changes:relation.slice(i,i+8)});}
  const selected=stateCandidates({store:s.store,subjectId:'p0',workbenchFocus:true,mind:true,domains:['relationship'],limit:8,extended:true});
  assert.equal(selected.items.length,8);
  assert.equal(selected.omitted,4);
  assert.equal(selected.total,12);
  assert.ok(selected.items.every(x=>x.domains.includes('relationship')));
});

test('T12/T13 fixed-version state/note refs remain stable',t=>{
  const s=setup(t);
  commit(s,{changes:[state('versioned','belief','v1',['self'])]});
  nextEvent(s);
  commit(s,{changes:[{id:'versioned',expectedRevision:1,body:'v2',nature:'reappraisal'}],extra:{stateRefs:[pin('versioned')]}});
  assert.equal(s.store.read('versioned').revision,2);
  assert.equal(readPersonalState({store:s.store,subjectId:'p0',state:pin('versioned',1)}).ref.revision,1);
  assert.equal(readPersonalState({store:s.store,subjectId:'p0',state:pin('versioned',2)}).ref.revision,2);
  put(s.store,'p0-version-note',note('p0-version-note',[],{body:'n1',domains:['world']}));
  put(s.store,'p0-version-note-2',{op:'write_note',id:'p0-version-note',expectedRevision:1,body:'n2',kind:'interpretation',change:'self_report',evidence:[]});
  assert.equal(s.store.read('p0-version-note',1).revision,1);
  assert.equal(s.store.read('p0-version-note',2).revision,2);
});

test('T14 state residence 后正文进入 foreground',t=>{
  const s=setup(t);
  const residence={id:'p0-res',target:{kind:'state',ref:pin('res')},cue:'继续关心',
    purposes:[{kind:'active-task',eventIds:[],questionId:null,appliesTo:null}]};
  const attention={...keepAttention(),residency:{upsert:[residence],remove:[]}};
  commit(s,{changes:[state('res','concern','驻留的关切',['relationship'])],attention});
  const p=prepare(s,{stateRefs:[pin('res')]});
  assert.equal(p.payload.continuity.foreground.some(x=>x.ref.id==='res'),true);
});

test('T15 flag off retains legacy anchor body and no domains prompt',t=>{
  const s=setup(t);
  const p=s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,
    workbenchFocus:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,subjectiveDomains:false,anchorDirectory:false});
  assert.equal(p.payload.subjectiveDomains,undefined);
  assert.equal(p.payload.anchorDirectory,undefined);
  assert.doesNotMatch(p.instruction,/四域归档协议/);
});

test('T16 transaction invalid domain rolls back the whole decision',t=>{
  const s=setup(t);
  assert.throws(()=>commit(s,{changes:[state('ok','belief','ok',['self']),state('bad','belief','bad',['nope'])]}),e=>e.code==='INVALID_INPUT');
  assert.equal(s.store.read('ok'),null);
  assert.equal(s.store.read('bad'),null);
});

test('T17 conflicting same-role states coexist',t=>{
  const s=setup(t);
  commit(s,{changes:[state('v1','belief','我倾向于相信他',['relationship']),state('v2','belief','我也怀疑他在回避',['relationship'])]});
  assert.equal(s.store.read('v1').mind.role,'belief');
  assert.equal(s.store.read('v2').mind.role,'belief');
});

test('T18 directory read/recall does not change state confidence',t=>{
  const s=setup(t);
  commit(s,{changes:[state('stable','belief','稳定认识',['self'])]});
  const before=JSON.stringify(s.store.read('stable'));
  anchorView({store:s.store,subjectId:'p0',currentEvent:s.store.read(s.e.id,s.e.revision),mode:'directory',limit:12});
  assert.equal(JSON.stringify(s.store.read('stable')),before);
});

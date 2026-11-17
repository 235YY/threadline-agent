import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {prepareDecision,prepareReflection} from '../src/cognition.mjs';
import {attentionId,keepAttention} from '../src/attention.mjs';
import {stateCandidates,shortTermView} from '../src/continuity.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {anchorView} from '../src/anchor.mjs';
import {put,event,frame,ref,note,memory,disk} from './helpers.mjs';

const pin=(id,revision=1)=>({id,revision});
const mindMeta=role=>({role,confidence:'tentative',unresolved:[],
  ...(role==='concern'?{orientation:'seek'}:role==='condition'?{assessment:'unknown'}
    :role==='expectation'?{action:{tool:'fixture.ping',args:{}},when:{constant:true},likelihood:'possible',effects:[]}
    :role==='readiness'?{concerns:[],appraisals:[],conditions:[],expectations:[]}:{alternatives:[]})});
const roleKind={belief:'appraisal',concern:'concern',condition:'condition',expectation:'expectation',readiness:'readiness'};
function bcrz(id,role,body,extra={}){
  return {id,expectedRevision:0,kind:roleKind[role],body,status:'open',scope:['qq:brother'],nature:'self-report',
    mind:mindMeta(role),...(extra.about?{about:extra.about}:{}),...(extra.domains?{domains:extra.domains}:{}),...extra};
}
function impression(id,body,about,basis,extra={}){
  return {id,expectedRevision:0,kind:'impression',body,status:'open',scope:['qq:brother'],nature:'self-report',
    about,domains:['relationship','self'],basis:{observations:basis,priorStates:[],memories:[]},...extra};
}
function setup(t){
  const holder=memory(t),store=holder.store;
  const session=new ContinuitySession({store,subjectId:'p1',attention:true});
  const [entity]=put(store,'p1-entity',{op:'write_entity',id:'e1',kind:'person',name:'哥哥'});
  const [e,w]=put(store,'p1-init',event('p1-e1',{sender:{system:'fixture',id:'sender',name:'哥哥',entityId:'e1',isOwner:false}}),frame());
  return {store,session,e,w,entity,holder,seq:0};
}
function nextEvent(s){
  const id=`p1-e${++s.seq+2}`;[s.e]=put(s.store,`p1-event-${id}`,event(id,{sender:{system:'fixture',id:'sender',name:'哥哥',entityId:'e1',isOwner:false}}));return s.e;
}
function prepare(s,extra={}){
  return s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,
    workbenchFocus:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,subjectiveDomains:true,subjectiveMemory:true,...extra});
}
function output(p,{changes=[],attention=keepAttention()}={}){
  return {packetId:p.packetId,options:[{id:'choice',kind:'wait',payload:{}}],selected:'choice',summary:'P1 fixture',used:[],
    continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}};
}
function commit(s,{changes=[],attention=keepAttention(),extra={}}={}){
  const p=prepare(s,extra),id=`p1-decision-${++s.seq}`;
  return s.session.commit({packet:p,output:output(p,{changes,attention}),decisionId:id,requestId:id,allowedActionTools:[]});
}

test('P1 impression 合法创建，无 mind，有 event basis',t=>{
  const s=setup(t);
  commit(s,{changes:[impression('i1','哥哥可能只是累了',[{kind:'entity',id:'e1'}],[ref(s.e)])]});
  const v=s.store.read('i1');
  assert.equal(v.kind,'impression');
  assert.equal(v.mind,undefined);
  assert.deepEqual(v.about,[{kind:'entity',id:'e1'}]);
  assert.deepEqual(v.basis.observations,[ref(s.e)]);
});

test('P1 impression 禁止 mind，且必须有 observation',t=>{
  const s=setup(t);
  assert.throws(()=>commit(s,{changes:[impression('bad-mind','x',[{kind:'entity',id:'e1'}],[ref(s.e)],{mind:mindMeta('belief')})]}),e=>e.code==='IMPRESSION_MIND');
  assert.throws(()=>commit(s,{changes:[impression('bad-source','x',[{kind:'entity',id:'e1'}],[])]}),e=>e.code==='IMPRESSION_SOURCE');
});

test('P1 about 多对象、上限、重复、非法与 anchor 一致性',t=>{
  const s=setup(t);
  commit(s,{changes:[bcrz('a1','belief','认识',{about:[{kind:'entity',id:'e1'},{kind:'event',id:s.e.id},{kind:'scene',id:'qq:brother'}],domains:['relationship','self'],anchor:{kind:'entity',id:'e1'}})]});
  assert.deepEqual(s.store.read('a1').about.map(x=>x.kind),['entity','event','scene']);
  assert.throws(()=>commit(s,{changes:[bcrz('bad-about','belief','x',{about:[{kind:'entity',id:'missing'}]})]}),e=>e.code==='ABOUT_REFERENCE');
  assert.throws(()=>commit(s,{changes:[bcrz('bad-anchor','belief','x',{about:[{kind:'entity',id:'e1'}],anchor:{kind:'entity',id:'other'}})]}),e=>e.code==='ABOUT_ANCHOR_MISMATCH');
  assert.throws(()=>commit(s,{changes:[bcrz('bad-max','belief','x',{about:[{kind:'entity',id:'e1'},{kind:'event',id:s.e.id},{kind:'scene',id:'a'},{kind:'scene',id:'b'},{kind:'scene',id:'c'}]})]}),e=>e.code==='ABOUT_LIMIT');
});

test('P1 about 重复引用去重，不产生重复索引',t=>{
  const s=setup(t);
  commit(s,{changes:[bcrz('dup','belief','认识',{about:[{kind:'entity',id:'e1'},{kind:'entity',id:'e1'}]})]});
  assert.deepEqual(s.store.read('dup').about,[{kind:'entity',id:'e1'}]);
});
test('P1 note 支持 domains/about 且保留旧值',t=>{
  const s=setup(t);
  put(s.store,'p1-note',note('p1-note',[],{domains:['self'],about:[{kind:'entity',id:'e1'}],anchor:{kind:'entity',id:'e1'}}));
  assert.deepEqual(s.store.read('p1-note').about,[{kind:'entity',id:'e1'}]);
  put(s.store,'p1-note-2',{op:'write_note',id:'p1-note',expectedRevision:1,body:'更新',kind:'interpretation',change:'self_report',evidence:[]});
  assert.deepEqual(s.store.read('p1-note').domains,['self']);
  assert.deepEqual(s.store.read('p1-note').about,[{kind:'entity',id:'e1'}]);
});

test('P1 shortTerm 只取 impression，不进入 BCRZ 候选',t=>{
  const s=setup(t);
  commit(s,{changes:[impression('i1','短期印象',[{kind:'entity',id:'e1'}],[ref(s.e)]),bcrz('b1','belief','当前认识',{domains:['relationship'],about:[{kind:'entity',id:'e1'}]})]});
  nextEvent(s);
  const p=prepare(s);
  assert.equal(p.payload.continuity.shortTerm.items.some(x=>x.ref.id==='i1'),true);
  assert.equal(p.payload.continuity.shortTerm.items.some(x=>x.ref.id==='b1'),false);
  assert.equal(stateCandidates({store:s.store,subjectId:'p1',workbenchFocus:true,mind:true,about:[{kind:'entity',id:'e1'}],extended:true}).items.some(x=>x.ref.id==='i1'),false);
});

test('P1 anchorView 普通目录不泄漏 impression，显式历史目录可给引用但不给正文',t=>{
  const s=setup(t);
  commit(s,{changes:[impression('i1','短期印象',[{kind:'entity',id:'e1'}],[ref(s.e)])]});
  const normal=anchorView({store:s.store,subjectId:'p1',currentEvent:s.store.read(s.e.id),mode:'directory',about:[{kind:'entity',id:'e1'}]});
  assert.equal(normal.records.some(r=>r.ref.id==='i1'),false);
  const history=anchorView({store:s.store,subjectId:'p1',currentEvent:s.store.read(s.e.id),mode:'directory',about:[{kind:'entity',id:'e1'}],includeHistorical:true,includeImpressions:true});
  const row=history.records.find(r=>r.ref.id==='i1');
  assert.ok(row);assert.equal(row.bodyAvailable,false);assert.equal(Object.hasOwn(row,'body'),false);assert.equal(row.historical,true);
});

test('P1 shortTerm 50/51 窗口是动态投影，不删除旧记录',t=>{
  const now=1000;
  const records=Array.from({length:51},(_,i)=>({id:`i${i}`,subject:'p1',kind:'impression',status:'open',recordedAt:now+i,revision:1,body:`b${i}`,about:[{kind:'entity',id:'e1'}],domains:['relationship']}));
  const view=shortTermView({store:{all:()=>records},subjectId:'p1',about:[{kind:'entity',id:'e1'}],maxBodies:8,maxBytes:1000000});
  assert.equal(view.window,50);assert.equal(view.items.length,8);assert.equal(view.omitted,42);
  assert.equal(records.length,51);
});

test('P1 shortTerm 排序确定且正文预算有 omitted',t=>{
  const records=Array.from({length:12},(_,i)=>({id:`i${i}`,subject:'p1',kind:'impression',status:'open',recordedAt:100+i,revision:1,body:'x'.repeat(2048),about:[{kind:'entity',id:'e1'}],domains:['relationship']}));
  const view=shortTermView({store:{all:()=>records},subjectId:'p1',about:[{kind:'entity',id:'e1'}],maxBodies:8,maxBytes:2500});
  assert.equal(view.items.length,1);assert.ok(view.omitted>0);assert.equal(view.items[0].ref.id,'i11');
});

test('P1 impression 更新保留 about/basis，新版本保留 predecessor',t=>{
  const s=setup(t);
  commit(s,{changes:[impression('i1','旧印象',[{kind:'entity',id:'e1'}],[ref(s.e)])]});
  nextEvent(s);
  commit(s,{changes:[{id:'i1',expectedRevision:1,body:'修订印象',nature:'reappraisal',basis:{observations:[ref(s.e)],priorStates:[],memories:[]}}],extra:{stateRefs:[pin('i1',1)]}});
  const v=s.store.read('i1');
  assert.equal(v.revision,2);assert.deepEqual(v.about,[{kind:'entity',id:'e1'}]);assert.deepEqual(v.basis.observations,[ref(s.e)]);
  assert.deepEqual(v.predecessor,{id:'i1',revision:1});
});

test('P1 低价值事件不产生 impression，也不产生状态',t=>{
  const s=setup(t);
  const before=[...s.store.all('personal_state')].length;
  commit(s,{changes:[]});
  assert.equal([...s.store.all('personal_state')].length,before);
});

test('P1 冲突主观认识并存，不自动合并',t=>{
  const s=setup(t);
  commit(s,{changes:[
    bcrz('c1','belief','他可能只是累了',{about:[{kind:'entity',id:'e1'}],domains:['relationship']}),
    bcrz('c2','belief','他可能想疏远',{about:[{kind:'entity',id:'e1'}],domains:['relationship']})
  ]});
  assert.equal(s.store.read('c1').mind.role,'belief');
  assert.equal(s.store.read('c2').mind.role,'belief');
  assert.notDeepEqual(s.store.read('c1').body,s.store.read('c2').body);
});

test('P1 非法 about 使整个事务回滚',t=>{
  const s=setup(t);
  assert.throws(()=>commit(s,{changes:[
    bcrz('ok','belief','有效',{about:[{kind:'entity',id:'e1'}]}),
    bcrz('bad','belief','无效',{about:[{kind:'entity',id:'missing'}]})
  ]}),e=>e.code==='ABOUT_REFERENCE');
  assert.equal(s.store.read('ok'),null);
  assert.equal(s.store.read('bad'),null);
});

test('P1 通过 ContinuitySession.run 的 fake decision 形成并召回 impression',async t=>{
  const s=setup(t);
  const base={currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,
    localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,subjectiveDomains:true,subjectiveMemory:true};
  const result=await s.session.run({...base,requestId:'p1-run',decisionId:'p1-run',allowedActionTools:[],
    invoke:async packet=>{
      const p=JSON.parse(JSON.stringify(packet));
      return JSON.stringify({packetId:p.packetId,options:[{id:'choice',kind:'wait',payload:{}}],selected:'choice',summary:'fake decision',used:[],
        continuity:{changes:[impression('run-i','fake 形成的印象',[{kind:'entity',id:'e1'}],[ref(s.e)])],residency:{add:[],remove:[]},
          expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
    }});
  assert.equal(result.modelCalled,true);
  assert.equal(s.store.read('run-i').kind,'impression');
  nextEvent(s);
  const p=await s.session.prepare({...base,currentEvent:ref(s.e)});
  assert.equal(p.payload.continuity.shortTerm.items.some(x=>x.ref.id==='run-i'),true);
});

test('P1 历史 impression 窗口外目录、正常选择、交付和自主修订',async t=>{
  const s=setup(t);
  const base={currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,
    localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,subjectiveDomains:true,subjectiveMemory:true};
  for(let i=0;i<51;i+=16){
    const batch=[];
    for(let j=i;j<Math.min(51,i+16);j++)batch.push(impression(`hist-${String(j+1).padStart(2,'0')}`,`历史印象 ${j+1}`,[{kind:'entity',id:'e1'}],[ref(s.e)]));
    s.holder.setTime(1000+i);
    commit(s,{changes:batch});
    nextEvent(s);
  }
  // The oldest impression is outside the 50-item shortTerm window.
  const p=prepare(s);
  assert.equal(p.payload.continuity.shortTerm.window,50);
  assert.equal(p.payload.continuity.shortTerm.items.some(x=>x.ref.id==='hist-01'),false);
  const history=p.payload.continuity.historicalImpressions.records;
  const old=history.find(x=>x.ref.id==='hist-01');
  assert.ok(old);assert.equal(old.bodyAvailable,false);assert.equal(Object.hasOwn(old,'body'),false);
  assert.equal(history.some(x=>x.ref.id==='hist-51'),false);

  // Select the historical impression through the normal lookup stateRef path.
  const lp=prepare(s);
  const lid=`p1-lookup-${++s.seq}`;
  const decision=s.session.commit({packet:lp,
    output:{packetId:lp.packetId,options:[{id:'look',kind:'lookup',payload:{stateRef:old.ref}}],selected:'look',summary:'select history',used:[],
      continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'deferred',attention:keepAttention()}},
    decisionId:lid,requestId:lid,allowedActionTools:[]});
  const lookup=new LocalLookupSession({store:s.store,subjectId:'p1',policy:{maxReads:2,maxHits:4}});
  const result=lookup.execute({decision:ref(decision)});
  assert.equal(result.states[0].ref.id,'hist-01');

  // The ordinary next packet carries the selected body as recalled.
  const delivered=prepare(s,{lookupResults:[ref(result)]});
  assert.equal(delivered.payload.continuity.recalled.some(x=>x.ref.id==='hist-01'),true);
  const oldBody=delivered.payload.continuity.recalled.find(x=>x.ref.id==='hist-01').body;
  assert.equal(oldBody,'历史印象 1');

  // Revise through continuity.changes; no manual stateRefs.
  const rid=`p1-revise-${++s.seq}`;
  const revision={id:'hist-01',expectedRevision:1,body:'修订后的历史印象',nature:'reappraisal',
    basis:{observations:[ref(s.e)],priorStates:[{id:'hist-01',revision:1}],memories:[]}};
  s.session.commit({packet:delivered,output:output(delivered,{changes:[revision]}),decisionId:rid,requestId:rid,allowedActionTools:[]});
  const updated=s.store.read('hist-01');
  assert.equal(updated.revision,2);assert.equal(updated.body,'修订后的历史印象');assert.deepEqual(updated.predecessor,{id:'hist-01',revision:1});
  assert.deepEqual(updated.basis.priorStates,[{id:'hist-01',revision:1}]);
  assert.equal(s.store.read('hist-01',1).body,'历史印象 1');
});


for(const flags of [{subjectiveMemory:false,subjectiveMemoryV2:false},{subjectiveMemory:true,subjectiveMemoryV2:false},{subjectiveMemory:false,subjectiveMemoryV2:true},{subjectiveMemory:true,subjectiveMemoryV2:true}])
for(const stage of ['ordinary','reflection'])test('impression contract enum '+stage+' '+JSON.stringify(flags),t=>{
  const s=setup(t);
  const p=stage==='ordinary'?prepare(s,flags):prepareReflection({store:s.store,subjectId:'p1',workspace:ref(s.w),internal:{format:'reflection-frame-v1'},budgetBytes:131072,...flags});
  const kinds=[...p.instruction.matchAll(/kind\s*为\s*(feeling(?:\/[a-z_]+)+)/g)];
  assert.ok(kinds.length>0,'main state-kind contract must be present');
  for(const match of kinds)assert.equal(match[1].split('/').includes('impression'),flags.subjectiveMemory||flags.subjectiveMemoryV2);
});

test('impression V2 proposal persists and is delivered after database restart',t=>{
 const file=disk(t);let store=new ContinuityStore(file);
 try{
  const session=new ContinuitySession({store,subjectId:'p1',attention:true});
  put(store,'entity',{op:'write_entity',id:'e1',kind:'person',name:'synthetic person'});
  const [e,w]=put(store,'init',event('restart-e'),frame());
  const s={store,session,e,w,seq:0};
  commit(s,{changes:[impression('restart-impression','可能是在认真考虑',[{kind:'entity',id:'e1'}],[ref(e)])],extra:{subjectiveMemory:false,subjectiveMemoryV2:true}});
  store.close();store=new ContinuityStore(file);
  assert.equal(store.read('restart-impression').kind,'impression');
  assert.deepEqual(store.read('restart-impression').basis.observations,[ref(e)]);
  const next=put(store,'next',event('restart-next',{sender:{system:'fixture',id:'sender',name:'synthetic person',entityId:'e1',isOwner:false}}))[0];
  const restored=new ContinuitySession({store,subjectId:'p1',attention:true});
  const p=prepare({store,session:restored,e:next,w},{subjectiveMemory:false,subjectiveMemoryV2:true});
  assert.ok(JSON.stringify(p.payload.continuity.subjectiveMemory).includes('restart-impression'));
  assert.ok(JSON.stringify(p.payload.continuity.subjectiveMemory).includes('可能是在认真考虑'));
 }finally{store.close();}
});

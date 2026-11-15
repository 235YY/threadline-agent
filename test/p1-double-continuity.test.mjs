import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {keepAttention, attentionId} from '../src/attention.mjs';
import {taskThreads, threadUnits} from '../src/task-threads.mjs';
import {subjectiveMemoryView, impressionMaintenanceView} from '../src/continuity.mjs';
import {recentContext} from '../src/recent-context.mjs';
import {queryAnchor} from '../src/anchor.mjs';
import {put,event,frame,ref,memory} from './helpers.mjs';

const pin=(id,revision=1)=>({id,revision});
const process=(id,label='任务')=>({id,expectedRevision:0,label,body:`${label} 正文`,status:'active',world:'actual',intervals:[],basis:[]});
function setup(t,{processes=[],eventExtra={}}={}){
  const holder=memory(t),store=holder.store,session=new ContinuitySession({store,subjectId:'p',attention:true});
  put(store,'entity',{op:'write_entity',id:'e1',kind:'person',name:'用户'});
  const [initial,w]=put(store,'init',event('p-e1',{sender:{system:'fixture',id:'u',name:'用户',entityId:'e1',isOwner:false},...eventExtra}),frame());
  const s={store,session,e:initial,w,holder,seq:0};
  if(processes.length)s.attention=put(store,'proc',{op:'initialize_attention',subjectId:'p'});
  return s;
}
function prepare(s,extra={}){
  return s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,
    workbenchFocus:true,workbenchRecovery:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,
    taskThreads:true,subjectiveMemoryV2:true,...extra});
}
function output(p,{changes=[],attention=keepAttention(),selected='choice',options=null}={}){
  return {packetId:p.packetId,options:options??[{id:'choice',kind:'wait',payload:{}}],selected,
    summary:'P1 final fixture',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,
      observationDisposition:'handled',attention}};
}
function commit(s,{changes=[],attention=keepAttention(),selected='choice',options=null,allowed=[],extra={}}={}){
  const p=prepare(s,{...extra,allowedActionTools:allowed}),id=`d-${++s.seq}`;
  return s.session.commit({packet:p,output:output(p,{changes,attention,selected,options}),decisionId:id,requestId:id,allowedActionTools:allowed});
}
function nextEvent(s,{threadId=null,body=null}={}){
  const id=`p-e${++s.seq+1}`;s.e=put(s.store,`ev-${id}`,event(id,{sender:{system:'fixture',id:'u',name:'用户',entityId:'e1',isOwner:false},...(threadId?{threadId}:{}),...(body?{body}:{})})).at(-1);return s.e;
}
function attentionWith(s,processes,extra={}){
  return {processes,relations:[],residency:{upsert:[],remove:[]},questions:[],...extra};
}
function createProcesses(s,ids){
  const refs=[];
  const procs=ids.map((id,i)=>({...process(id,`任务${i+1}`),basis:[ref(s.e)]}));
  commit(s,{attention:attentionWith(s,procs)});
  return procs;
}
function impression(id,body,source,extra={}){
  return {id,expectedRevision:0,kind:'impression',stage:'recent',body,status:'open',scope:['qq:brother'],nature:'reappraisal',
    about:[{kind:'entity',id:'e1'}],domains:['relationship'],basis:{observations:[ref(source)],priorStates:[],memories:[]},...extra};
}

test('P1 final 1/2/3/5 任务的活动工作集最多四个，第5个不改变生命周期',t=>{
  const s=setup(t);const ids=['p1','p2','p3','p4','p5'];createProcesses(s,ids);
  const frameRecord=s.store.read(attentionId('p'));
  const statuses=frameRecord.processes.map(p=>p.status);
  const view=taskThreads({store:s.store,frame:frameRecord,foregroundId:'p1'});
  assert.equal(view.activeCount,4);assert.equal(view.foreground.id,'p1');assert.equal(view.background.length,3);
  assert.equal(view.suspended.length,1);assert.equal(view.background.every(x=>!Object.hasOwn(x,'units')),true);
  assert.deepEqual(frameRecord.processes.map(p=>p.status),statuses);
  for(const n of [1,2,3,4]){const v=taskThreads({store:s.store,frame:{...frameRecord,processes:frameRecord.processes.slice(0,n)},foregroundId:'p1'});assert.equal(v.activeCount,n);}
  const four=taskThreads({store:s.store,frame:{...frameRecord,processes:frameRecord.processes.slice(0,4)},foregroundId:'p1'});
  assert.equal(four.activeCount,4);assert.equal(four.suspended.length,0);
});

test('P1 final 30 个交互单元，前台完整、后台不泄漏、31 条可分页',t=>{
  const s=setup(t,{processes:['p1']});createProcesses(s,['p1']);
  const frameRecord=s.store.read(attentionId('p'));
  for(let i=1;i<=31;i++)put(s.store,`unit-${i}`,event(`unit-e-${i}`,{body:`消息 ${i}`,threadId:'p1',occurredAt:1000+i}));
  const view=taskThreads({store:s.store,frame:frameRecord,foregroundId:'p1'});
  assert.equal(view.foreground.history.units.length,30);
  assert.equal(view.foreground.history.units[0].incoming.body,'消息 2');
  assert.equal(view.foreground.history.olderAvailable,true);
  assert.equal(view.background.length,0);
  const older=threadUnits({store:s.store,threadId:'p1',before:view.foreground.history.nextBefore,limit:30});
  assert.equal(older.units.length,1);assert.equal(older.units[0].incoming.body,'消息 1');
  const nullEvent=put(s.store,'null-event',event('null-e',{threadId:null,body:'未归属',occurredAt:999})).at(-1);
  const v2=taskThreads({store:s.store,frame:frameRecord,foregroundId:'p1'});
  assert.ok(v2.unassignedCount>=1);
});

test('P1 final 工具回执归入同一交互单元，不单独占 30 条',t=>{
  const s=setup(t,{processes:['p1']});createProcesses(s,['p1']);
  nextEvent(s,{threadId:'p1',body:'请执行'});
  const p=prepare(s);
  commit(s,{options:[{id:'act',kind:'act',payload:{tool:'fixture.ping',args:{}}}],selected:'act',allowed:['fixture.ping'],extra:{}});
  const action=[...s.store.all('action')].at(-1);
  put(s.store,'receipt',{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',
    eventId:'receipt-1',body:'执行回执',source:{system:'fixture',key:'receipt-1'},actor:'host'});
  const history=threadUnits({store:s.store,threadId:'p1',limit:30});
  assert.equal(history.units.length,1);
  assert.equal(history.units[0].exchanges[0].action.tool,'fixture.ping');
  assert.equal(history.units[0].exchanges[0].receipt.body,'执行回执');
});

test('P1 final 20+30：21 条 recent 不自动压缩，olderRecent 提供来源',t=>{
  const s=setup(t);const created=[];
  for(let batch=0;batch<2;batch++){
    const changes=[];
    nextEvent(s,{body:`经历批次 ${batch+1}`});
    for(let i=batch*16;i<Math.min(21,(batch+1)*16);i++){
      const id=`imp-${String(i+1).padStart(2,'0')}`;created.push(id);changes.push(impression(id,`印象 ${i+1}`,s.e));
    }
    commit(s,{changes});
  }
  const view=subjectiveMemoryView({store:s.store,subjectId:'p'});
  assert.equal(view.recent.count,21);assert.equal(view.recent.items.length,20);
  assert.equal(view.compressed.count,0);
  assert.equal(view.maintenance.due,true);assert.equal(view.maintenance.recentOverflow,1);
  assert.equal(view.maintenance.olderRecent.length,1);
  assert.deepEqual(view.recent.items.map(x=>x.ref.id).sort(),created.slice(1).sort());
});

test('P1 final 压缩来源只指向原始 impression，递归和超限都被拒绝',t=>{
  const s=setup(t);const sources=[];
  for(let i=0;i<2;i++){nextEvent(s,{body:`来源 ${i}`});const id=`src-${i}`;sources.push(id);commit(s,{changes:[impression(id,`原始 ${i}`,s.e)]});}
  const p1=prepare(s);
  commit(s,{changes:[{id:'c1',expectedRevision:0,kind:'impression',stage:'compressed',body:'主题压缩',status:'open',nature:'reappraisal',
    about:[{kind:'entity',id:'e1'}],domains:['relationship'],basis:{observations:[],priorStates:[pin('src-0')],memories:[]}}]});
  assert.equal(s.store.read('c1').stage,'compressed');
  assert.throws(()=>commit(s,{changes:[{id:'recursive',expectedRevision:0,kind:'impression',stage:'compressed',body:'递归',status:'open',
    nature:'reappraisal',basis:{observations:[],priorStates:[pin('c1')],memories:[]}}]}),e=>e.code==='COMPRESSION_CHAIN');
  const noteRec=put(s.store,'compression-note',{op:'write_note',id:'compression-note',expectedRevision:0,body:'不是来源的长期笔记',
    kind:'interpretation',change:'self_report',evidence:[],scope:{scenes:[],people:[],validFrom:null,validUntil:null}}).at(-1).record;
  const p2=prepare(s,{materials:[{ref:ref(noteRec),aspect:'experience'}]});
  assert.throws(()=>s.session.commit({packet:p2,output:output(p2,{changes:[{id:'with-note',expectedRevision:0,kind:'impression',stage:'compressed',body:'note',status:'open',
    nature:'reappraisal',basis:{observations:[],priorStates:[pin('src-0')],memories:[ref(noteRec)]}}]}),decisionId:'with-note-decision',requestId:'with-note-decision',allowedActionTools:[]}),e=>e.code==='COMPRESSION_SOURCE');
  assert.equal(s.store.read('recursive'),null);assert.equal(s.store.read('with-note'),null);
});

test('P1 final 30 个 compressed 上限、31 拒绝、退休仍可按 about 召回',t=>{
  const s=setup(t);nextEvent(s,{body:'来源'});
  const source='source-1';commit(s,{changes:[impression(source,'原始来源',s.e)]});
  const make=(i)=>({id:`c-${i}`,expectedRevision:0,kind:'impression',stage:'compressed',body:`主题 ${i}`,status:'open',nature:'reappraisal',
    about:[{kind:'entity',id:'e1'}],domains:['relationship'],basis:{observations:[],priorStates:[pin(source)],memories:[]}});
  commit(s,{changes:Array.from({length:16},(_,i)=>make(i+1))});
  commit(s,{changes:Array.from({length:14},(_,i)=>make(i+17))});
  assert.equal([...s.store.all('personal_state')].filter(r=>r.stage==='compressed'&&r.status==='open').length,30);
  assert.throws(()=>commit(s,{changes:[make(31)]}),e=>e.code==='COMPRESSION_FULL');
  assert.equal(s.store.read('c-31'),null);
  const before=s.store.read('c-1');
  commit(s,{changes:[{id:'c-1',expectedRevision:before.revision,status:'closed',body:before.body,nature:'reappraisal'}]});
  assert.equal(s.store.read('c-1').status,'closed');
  const dir=s.store.read(attentionId('p'));
  assert.ok([...s.store.all('personal_state')].some(r=>r.id==='c-1'&&r.status==='closed'));
});

test('P1 final 合并使用原始来源并保留旧单元；不自动创建 Note',t=>{
  const s=setup(t);nextEvent(s,{body:'合并来源'});
  const source='merge-src';commit(s,{changes:[impression(source,'原始来源',s.e)]});
  const mk=(id,basis)=>({id,expectedRevision:0,kind:'impression',stage:'compressed',body:id,status:'open',nature:'reappraisal',
    about:[{kind:'entity',id:'e1'}],domains:['relationship'],basis:{observations:[],priorStates:basis,memories:[]}});
  commit(s,{changes:[mk('m1',[pin(source)]),mk('m2',[pin(source)])]});
  const old1=s.store.read('m1'),old2=s.store.read('m2');
  commit(s,{changes:[
    {id:'m3',expectedRevision:0,kind:'impression',stage:'compressed',body:'合并主题',status:'open',nature:'reappraisal',
      about:[{kind:'entity',id:'e1'}],domains:['relationship'],basis:{observations:[],priorStates:[pin(source)],memories:[]}},
    {id:'m1',expectedRevision:old1.revision,status:'closed',body:old1.body,nature:'reappraisal'},
    {id:'m2',expectedRevision:old2.revision,status:'closed',body:old2.body,nature:'reappraisal'}
  ]});
  assert.equal(s.store.read('m3').stage,'compressed');
  assert.equal(s.store.read('m1').status,'closed');assert.equal(s.store.read('m2').status,'closed');
  assert.equal([...s.store.all('note')].length,0);
});

test('P1 final V2 视图和 old P1 shortTerm 兼容',t=>{
  const s=setup(t);nextEvent(s,{body:'兼容'});
  const old=impression('old-imp','旧印象',s.e);commit(s,{changes:[old]});
  const v2=subjectiveMemoryView({store:s.store,subjectId:'p'});
  assert.equal(v2.recent.items.length,1);assert.equal(v2.recent.items[0].ref.id,'old-imp');
  assert.equal(v2.maintenance.due,false);
  const payload=prepare(s);
  assert.equal(payload.payload.continuity.subjectiveMemory.format,'subjective-memory-v2');
  assert.equal(payload.payload.continuity.threads.format,'task-threads-v1');
  const p=prepare(s,{subjectiveMemoryV2:false,subjectiveMemory:true});
  assert.ok(p.payload.continuity.shortTerm);assert.equal(p.payload.continuity.subjectiveMemory,undefined);
});

test('P1 final 0/1/19/20/21 recent 窗口边界',t=>{
  const make=n=>Array.from({length:n},(_,i)=>({id:`win-${i}`,revision:1,subject:'p',kind:'impression',stage:'recent',status:'open',body:`印象 ${i}`,about:[],domains:[],basis:null,recordedAt:100+i}));
  for(const [n,want] of [[0,0],[1,1],[19,19],[20,20],[21,20]]){
    const view=subjectiveMemoryView({store:{all:()=>make(n)},subjectId:'p'});
    assert.equal(view.recent.items.length,want);
    assert.equal(view.maintenance.due,n>20);
  }
});

test('P1 final 跨场景 recent 默认隔离，anchor_recall 不返回 impression 正文',t=>{
  const s=setup(t);
  put(s.store,'scene-a',event('scene-a',{scene:'qq/private/a',body:'A 场景'}));
  put(s.store,'scene-b',event('scene-b',{scene:'qq/group/b',body:'B 场景'}));
  const a=recentContext({store:s.store,subjectId:'p',scene:'qq/private/a',limit:50});
  assert.deepEqual(a.items.map(x=>x.text),['A 场景']);
  assert.equal(a.items.some(x=>x.text==='B 场景'),false);
  nextEvent(s,{body:'印象来源'});
  commit(s,{changes:[impression('anchor-imp','不应泄漏',s.e,{anchor:{kind:'entity',id:'e1'}})]});
  const found=queryAnchor({store:s.store,subjectId:'p',anchor:{kind:'entity',id:'e1'},role:null,limit:20});
  assert.equal(found.records.some(r=>r.ref.id==='anchor-imp'),false);
});

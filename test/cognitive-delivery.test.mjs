import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {apperceptionSources,normalizeApperception} from '../src/cognition.mjs';
import {shortTermView,subjectiveMemoryView,impressionMaintenanceView} from '../src/continuity.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,disk,put,event,note,frame,ref} from './helpers.mjs';

const policy={maxReads:2,maxHits:4};
function setup(t,{path=null}={}){
  const holder=path?{store:new ContinuityStore(path,{clock:()=>2000})}:memory(t);
  const store=holder.store,session=new ContinuitySession({store,subjectId:'p',attention:true});
  const [e,w]=put(store,'seed',event('e'),frame(),note('old-note',[],{body:'旧笔记的完整正文'}));
  return {...holder,session,e,w,n:store.read('old-note'),seq:0};
}
function prepare(s,extra={}){return s.session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),mind:true,workbenchMaterials:true,workbenchFocus:true,localLookupPolicy:policy,budgetBytes:131072,...extra});}
function reflect(s,extra={}){return s.session.prepareReflection({workspace:ref(s.w),internal:{format:'reflection-frame-v1',now:9000},localLookupPolicy:policy,budgetBytes:131072,...extra});}
function out(p,{changes=[],kind='wait',payload={},used=[],attention=keepAttention()}={}){
  return {packetId:p.packetId,options:[{id:'next',kind,payload}],selected:'next',summary:'仅验证材料和状态接线的合成提案',used,
    continuity:{changes,residency:{add:[],remove:[]},attention,...(p.stage==='reflection'?{}:{expressionChoice:null,observationDisposition:'handled'})}};
}
function commit(s,p,options={}){const id=`d-${++s.seq}`;return s.session.commit({packet:p,output:out(p,options),requestId:id,decisionId:id});}
function read(s,p,query){const d=commit(s,p,{kind:'lookup',payload:query});return new LocalLookupSession({store:s.store,subjectId:'p',policy}).execute({decision:ref(d)});}
const change=(id,body,extra={})=>({id,expectedRevision:0,kind:'feeling',body,nature:'self-report',...extra});
const impression=(s,id,body,extra={})=>change(id,body,{kind:'impression',about:[{kind:'self',id:'p'}],basis:{observations:[ref(s.e)],priorStates:[],memories:[]},...extra});

test('反思查阅：标记呈现的旧笔记必须有完整正文，允许公开引用且不制造新事件',t=>{
  const s=setup(t),result=read(s,reflect(s),{ref:ref(s.n)}),p=reflect(s,{lookupResults:[ref(result)],apperceptionV1:true});
  assert.deepEqual(p.payload.information.presentation.presented,[ref(s.n)]);
  assert.equal(p.payload.materials[0]?.record.body,s.n.body);
  assert.ok(apperceptionSources(p).has('old-note@1'));
  const a=normalizeApperception({schema_version:'apperception.slice.v1',activated_cells:[{domain:'self',perspective:'meaning',content:'这只是重新阅读旧笔记',epistemic_status:'interpretation',source_refs:[ref(s.n)],uncertainty:null}],integrated_understanding:'旧材料不是新经历'},p);
  assert.equal(a.activated_cells.length,1);
  const count=[...s.store.all('event')].length;
  commit(s,p,{used:[{ref:ref(s.n),aspect:'belief',effect:'context'}],changes:[change('review','重新考虑它',{nature:'reappraisal',basis:{memories:[ref(s.n)]}})]});
  assert.equal([...s.store.all('event')].length,count);
});

test('反思查到的状态进入 recalled，后续提案能以该状态为依据',t=>{
  const s=setup(t);commit(s,prepare(s),{changes:[change('earlier','原有感受')]});
  const state=s.store.read('earlier'),result=read(s,reflect(s),{stateRef:ref(state)}),p=reflect(s,{lookupResults:[ref(result)]});
  assert.equal(p.payload.continuity.recalled.find(x=>x.ref.id===state.id)?.body,state.body);
  commit(s,p,{changes:[change('review','重新理解原有感受',{nature:'reappraisal',basis:{priorStates:[ref(state)]}})]});
  assert.deepEqual(s.store.read('review').basis.priorStates,[ref(state)]);
});

test('反思查到的旧观察可支持重新评价，不能冒充当前 encounter',t=>{
  const s=setup(t);prepare(s); // admit the event without creating a new encounter
  const result=read(s,reflect(s),{ref:ref(s.e)}),p=reflect(s,{lookupResults:[ref(result)]});
  commit(s,p,{changes:[impression(s,'retelling','对旧事的新解释',{nature:'reappraisal'})]});
  assert.deepEqual(s.store.read('retelling').basis.observations,[ref(s.e)]);
  const again=reflect(s,{materials:[{ref:ref(s.e),aspect:'experience'}]});
  assert.throws(()=>commit(s,again,{changes:[impression(s,'fake-new','不能重复算新经历',{nature:'encounter'})]}),e=>e.code==='ENCOUNTER_REQUIRED');
  assert.equal(s.store.read('fake-new'),null);
});

test('反思按启用协议提供主观记忆与对应指令，不需要伪造 current',t=>{
  const s=setup(t);commit(s,prepare(s),{changes:[impression(s,'i','已经形成的印象')]});
  const p=reflect(s,{subjectiveDomains:true,subjectiveMemoryV2:true,taskThreads:true});
  assert.equal(p.payload.current,undefined);
  assert.equal(p.payload.subjectiveMemoryV2?.enabled,true);
  assert.equal(p.payload.subjectiveDomains?.enabled,true);
  assert.equal(p.payload.taskThreads?.enabled,true);
  assert.equal(p.payload.continuity.subjectiveMemory?.recent.items[0]?.body,'已经形成的印象');
  assert.ok(p.instruction.includes('subjective-memory-v2')||p.instruction.includes('compressed'));
  const legacy=reflect(s,{subjectiveMemory:true});
  assert.equal(legacy.payload.continuity.shortTerm?.items[0]?.body,'已经形成的印象');
  commit(s,legacy,{changes:[change('via-short-term','确实拿到旧印象',{nature:'reappraisal',basis:{priorStates:[{id:'i',revision:1}]}})]});
});

function viewStore(rows){return {all:()=>rows};}
const row=(id,body,at)=>({id,revision:1,subject:'p',kind:'impression',status:'open',stage:'recent',body,recordedAt:at,about:[],domains:[]});
test('合法 Unicode 长记忆完整交付，超过字节预算时整条略过而不截正文',()=>{
  const body='🌊'.repeat(2048),store=viewStore([row('big',body,2),row('small','较小的下一条',1)]);
  assert.equal(shortTermView({store,subjectId:'p'}).items[0].body,body);
  assert.equal(subjectiveMemoryView({store,subjectId:'p'}).recent.items[0].body,body);
  assert.equal(impressionMaintenanceView({store,subjectId:'p'}).olderRecent[0].body,body);
  const a=shortTermView({store,subjectId:'p',maxBytes:1000}),b=subjectiveMemoryView({store,subjectId:'p',maxRecentBytes:1000,maxSourceBodies:0});
  assert.deepEqual(a.items.map(x=>x.ref.id),['small']);assert.equal(a.omitted,1);
  assert.deepEqual(b.recent.items.map(x=>x.ref.id),['small']);assert.equal(b.recent.omitted,1);
});

test('主观记忆交付后版本改变，旧版本不能冒充当前依据提交',t=>{
  let s;const path=disk({after:fn=>t.after(()=>{s?.store.close();fn();})});
  s=setup(t,{path});commit(s,prepare(s),{changes:[impression(s,'i','原印象')]});
  const stale=reflect(s,{subjectiveMemoryV2:true});
  // Simulate another writer advancing only this memory head while the model is working.
  const DB=sqlite.Database??sqlite.DatabaseSync,db=new DB(path),next={...s.store.read('i'),revision:2,body:'新的印象'};
  try{db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO versions(id,revision,body) VALUES(?,?,?)').run('i',2,JSON.stringify(next));db.prepare('UPDATE objects SET current_revision=2 WHERE id=?').run('i');db.exec('COMMIT');}finally{db.close();}
  assert.throws(()=>commit(s,stale,{changes:[change('based-on-stale','旧版不是当前版',{nature:'reappraisal',basis:{priorStates:[{id:'i',revision:1}]}})]}),e=>e.code==='STALE_STATE');
  assert.equal(s.store.read('based-on-stale'),null);
});

test('反思材料超预算时明确省略，目录条目不能获得正文引用权限',t=>{
  const s=setup(t);put(s.store,'long-note',note('large',[],{body:'长'.repeat(5000)}));const large=s.store.read('large');
  const result=read(s,reflect(s),{ref:ref(large)}),full=reflect(s,{lookupResults:[ref(result)]});
  // Leave room for the query directory/report, but not a full material body.
  const budgetBytes=full.bytes-Buffer.byteLength(JSON.stringify(full.payload.materials))+700;
  assert.ok(budgetBytes>0&&budgetBytes<full.bytes);
  const small=reflect(s,{lookupResults:[ref(result)],budgetBytes});
  assert.deepEqual(small.payload.materials,[]);
  assert.deepEqual(small.payload.information.presentation.presented,[]);
  assert.equal(small.payload.information.presentation.omitted[0].ref.id,'large');
  assert.equal(apperceptionSources(small).has('large@1'),false);
  assert.throws(()=>commit(s,small,{used:[{ref:ref(large),aspect:'belief',effect:'目录不算正文'}]}),e=>e.code==='UNDELIVERED_REFERENCE');
});

test('反思保留主体选择驻留的必要旧材料，缺预算不悄悄丢弃',t=>{
  const s=setup(t),target=ref(s.n),attention={...keepAttention(),
    processes:[{id:'task',expectedRevision:0,label:'核对记录',body:'稍后继续对照原文',status:'active',world:'actual',intervals:[],basis:[]}],
    focus:{select:[{kind:'process',id:'task',path:[]}]},
    residency:{upsert:[{id:'held',target:{kind:'material',ref:target},cue:'稍后继续核对',purposes:[{kind:'active-task',eventIds:['task'],questionId:null,appliesTo:null}],presentation:'full'}],remove:[]}};
  commit(s,prepare(s,{materials:[{ref:target,aspect:'belief'}]}),{attention});
  const p=reflect(s);
  assert.equal(p.payload.materials[0].record.body,s.n.body);
  assert.equal(p.payload.continuity.attention.materialSupport.enabled,true);
  assert.throws(()=>reflect(s,{budgetBytes:p.bytes-1000}),e=>e.code==='WORKBENCH_REQUIRED_OVERFLOW');
});

test('反思查阅在一次机会内共用预算，独立机会不被历史 null 锚点耗尽',t=>{
  const s=setup(t),initial=reflect(s),r1=read(s,initial,{ref:ref(s.n)});
  const continued=reflect(s,{lookupResults:[ref(r1)]});
  assert.equal(continued.payload.memoryAccess.remainingReads,1);
  assert.equal(continued.payload.memoryAccess.roundScope,initial.payload.memoryAccess.roundScope);
  const r2=read(s,continued,{ref:ref(s.e)}),last=reflect(s,{lookupResults:[ref(r1),ref(r2)]});
  assert.equal(last.payload.memoryAccess.remainingReads,0);
  const r3=read(s,last,{terms:['没有读取额度']});
  assert.equal(r3.readPerformed,false);assert.equal(r3.remainingReads,0);
  commit(s,reflect(s,{lookupResults:[ref(r2),ref(r3)]}));
  const fresh=reflect(s,{internal:{format:'reflection-frame-v1',now:10000}});
  assert.equal(fresh.payload.memoryAccess.remainingReads,2);
  assert.notEqual(fresh.payload.memoryAccess.roundScope,initial.payload.memoryAccess.roundScope);
  assert.equal(read(s,fresh,{ref:ref(s.n)}).readPerformed,true);
});

test('跨反思机会混入历史查询结果会被拒绝',t=>{
  const s=setup(t),old=read(s,reflect(s),{ref:ref(s.n)});
  commit(s,reflect(s,{lookupResults:[ref(old)]}));
  const fresh=read(s,reflect(s,{internal:{format:'reflection-frame-v1',now:11000}}),{ref:ref(s.e)});
  assert.throws(()=>reflect(s,{lookupResults:[ref(old),ref(fresh)]}),e=>e.code==='LOOKUP_CONTEXT_MISMATCH');
});

test('真实 TurnDriver 接续将查询正文交给下一次判断，并可在下一次反思继续查阅',async t=>{
  const s=setup(t);let n=0;
  const driver=new TurnDriver({store:s.store,subjectId:'p',workspace:ref(s.w),maxForeground:8,decide:p=>{
    n++;assert.equal(p.stage,'reflection');
    assert.ok(p.payload.memoryAccess.remainingReads>=1);
    if(n%2)return JSON.stringify(out(p,{kind:'lookup',payload:{ref:ref(s.n)}}));
    assert.equal(p.payload.materials[0]?.record.body,s.n.body);
    assert.equal(p.payload.memoryAccess.remainingReads,1);
    return JSON.stringify(out(p,{used:[{ref:ref(s.n),aspect:'belief',effect:'context'}]}));
  }});
  const count=[...s.store.all('event')].length;
  await driver.tick({now:100000,localHour:12});
  await driver.tick({now:2000000,idleReflection:true,localHour:12});
  await driver.tick({now:4000000,idleReflection:true,localHour:12});
  assert.equal(n,4);assert.equal([...s.store.all('event')].length,count);
});

test('图谱补充材料重建输入时，不丢失主观记忆、任务和能力协议',t=>{
  const s=setup(t);commit(s,prepare(s),{changes:[impression(s,'i','此前形成的认识')]});
  const flags={unified:true,subjectiveDomains:true,subjectiveMemoryV2:true,taskThreads:true,anchorDirectory:true,capabilities:['remember']};
  const result=read(s,prepare(s,flags),{trace:{route:'grounds',seeds:[{kind:'record',...ref(s.n)}],maxDepth:4,maxNodes:8,maxBytes:16384,includeHistorical:false,offset:0,scope:[],need:'核对旧笔记'}});
  const p=prepare(s,{...flags,lookupResults:[ref(result)]});
  assert.ok(p.payload.knowledge);
  assert.equal(p.payload.continuity.subjectiveMemory?.recent.items[0]?.body,'此前形成的认识');
  assert.ok(p.payload.continuity.threads);
  assert.deepEqual(p.payload.continuity.capabilities.enabled,['remember']);
  assert.equal(p.payload.subjectiveMemoryV2.enabled,true);
});

test('目录预览与未交付的记忆不能冒充完整状态来源',t=>{
  const s=setup(t);commit(s,prepare(s),{changes:[impression(s,'i','保留的认识')]});
  const p=reflect(s);
  assert.equal(apperceptionSources(p).has('i@1'),false);
  assert.throws(()=>normalizeApperception({schema_version:'apperception.slice.v1',activated_cells:[{domain:'self',perspective:'meaning',content:'只知道有这个条目',epistemic_status:'uncertain',source_refs:[{id:'i',revision:1}],uncertainty:'未读正文'}],integrated_understanding:'不能把目录当依据'},p),e=>e.code==='UNDELIVERED_REFERENCE');
  assert.throws(()=>commit(s,p,{changes:[change('unread','不能偷用未交付状态',{nature:'reappraisal',basis:{priorStates:[{id:'i',revision:1}]}})]}),e=>e.code==='UNDELIVERED_BASIS');
});

test('时间线保留事件位置，重复正文指向本轮已交付的同一版本',t=>{
  const s=setup(t),p=prepare(s);
  const timeline=p.payload.continuity.recent.items.find(x=>x.ref.id===s.e.id);
  assert.deepEqual(timeline.bodySource,{path:'current',ref:ref(s.e)});
  assert.equal(timeline.text,undefined);
  assert.equal(p.messages[1].content.split(s.e.body).length-1,1);
  assert.ok(apperceptionSources(p).has('e@1'));
  const result=read(s,reflect(s),{ref:ref(s.e)}),r=reflect(s,{lookupResults:[ref(result)]});
  const old=r.payload.continuity.recent.items.find(x=>x.ref.id===s.e.id);
  assert.deepEqual(old.bodySource,{path:'materials',ref:ref(s.e)});
  assert.equal(r.messages[1].content.split(s.e.body).length-1,1);
});

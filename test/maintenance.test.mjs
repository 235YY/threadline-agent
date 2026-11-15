import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {MaintenanceSession,startMaintenanceHeartbeat} from '../src/maintenance.mjs';
import {MAINTENANCE_DEFAULTS,maintenancePolicy,maintenanceSlot,maintenanceScheduleId,maintenanceJobId,pin} from '../src/maintenance-protocol.mjs';
import {keepAttention,attentionId} from '../src/attention.mjs';
import {claimResponse,recordResponseDelivery} from '../src/continuity.mjs';
import {canonical} from '../src/contracts.mjs';
import * as sqlite from 'node:sqlite';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {memory,disk,event,frame,note,put,ref,code} from './helpers.mjs';
const DAY=86400000,START=Date.UTC(2026,10,3,20,0);
function setup(t,{path=null,policy=MAINTENANCE_DEFAULTS}={}){
  const holder=memory(t);let clock=START;
  const store=path?new ContinuityStore(path,{clock:()=>clock}):holder.store;
  if(path)t.after(()=>store.close());else holder.setTime(START);
  const setTime=value=>{clock=value;if(!path)holder.setTime(value);};
  const normal=new ContinuitySession({store,subjectId:'person',attention:true}),maint=new MaintenanceSession({store,subjectId:'person',policy});
  const [o,w]=put(store,'setup',event('o'),frame());return {store,normal,maint,o,w,setTime,seq:0};
}
const state=(id='mood',fields={})=>({id,expectedRevision:0,kind:'feeling',body:'仍有点失落，但愿望没有变',nature:'self-report',...fields});
function turn(s,{changes=[],attention=keepAttention(),kind='wait',payload={},stateRefs=[]}={}){
  const id=`normal:${++s.seq}`,packet=s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536,stateRefs});
  return s.normal.commit({packet,decisionId:id,requestId:id,output:{packetId:packet.packetId,options:[{id:'a',kind,payload}],selected:'a',summary:'手工结构夹具',used:[],
    continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}}});
}
function answer(input,fields={}){return {packetId:input.packetId,disposition:'keep',summary:'没有新的理解，保持原样',changes:[],attention:keepAttention(),noteUpdates:[],observations:[],requests:[],...fields};}
const parsed=input=>JSON.parse(input.messages[1].content);
const allowed=()=>true;
const tick=(s,client=input=>answer(input),extra={})=>s.maint.tick({authorize:allowed,invoke:client,...extra});
function seed(s){turn(s,{changes:[state()]});return s;}
const job=s=>s.store.read(maintenanceJobId('person',maintenanceSlot(s.store.clockNow(),MAINTENANCE_DEFAULTS).day));
function send(s,d,outcome='sent'){
  const response=s.store.read(`${d.id}:response`),claimId=`send:${d.id}`;
  const claimed=claimResponse({store:s.store,response:ref(response),claimId,worker:'fixture',requestId:claimId});
  return recordResponseDelivery({store:s.store,response:ref(claimed),claimId,outcome,eventId:`sent:${d.id}`,body:'受控发送结果，无真实QQ发送',source:{system:'fixture',key:d.id},actor:'sender',requestId:`receipt:${d.id}`});
}

test('固定时段是宿主时区策略，不是模型自己定义时间',()=>{
  assert.equal(maintenanceSlot(Date.UTC(2026,10,3,19,29),MAINTENANCE_DEFAULTS).due,false);
  assert.deepEqual(maintenanceSlot(Date.UTC(2026,10,3,19,30),MAINTENANCE_DEFAULTS),{day:'2026-11-04',due:true});
  assert.throws(()=>maintenancePolicy({...MAINTENANCE_DEFAULTS,hour:25}),code('MAINTENANCE_POLICY'));
});
test('不够时间、忙碌、关闭时不调用模型',async t=>{
  const s=seed(setup(t));let calls=0;const invoke=()=>{calls++;throw Error('not called');};
  s.setTime(Date.UTC(2026,10,3,19,29));assert.equal((await tick(s,invoke)).status,'not-due');
  s.setTime(START);assert.equal((await tick(s,invoke,{busy:true})).status,'busy');
  s.maint.configure({policy:{...MAINTENANCE_DEFAULTS,enabled:false}});assert.equal((await tick(s,invoke)).status,'disabled');assert.equal(calls,0);
});
test('没有积压不产生感悟或调用，同日后来有内容仍可检查',async t=>{
  const s=setup(t);let calls=0;const invoke=input=>{calls++;return answer(input);};
  assert.equal((await tick(s,invoke)).status,'empty');assert.equal(calls,0);seed(s);
  assert.equal((await tick(s,invoke)).status,'adopted');assert.equal(calls,1);
});
test('预算未授权只延期；没有预算接口不能调用',async t=>{
  const s=seed(setup(t));let calls=0;const invoke=input=>{calls++;return answer(input);};
  assert.equal((await tick(s,invoke,{authorize:()=>false})).status,'budget-deferred');assert.equal(job(s).calls,0);
  await assert.rejects(s.maint.tick({invoke}),code('MAINTENANCE_BUDGET_REQUIRED'));assert.equal(calls,0);
  assert.equal((await tick(s,invoke)).status,'adopted');assert.equal(calls,1);
});
test('keep不改状态、笔记或主体版本，也不生成个人定时事件',async t=>{
  const s=seed(setup(t));put(s.store,'n',note('n',[ref(s.o)]));
  const before=[s.store.read('mood'),s.store.read('n'),s.store.read('person')].map(canonical),events=[...s.store.all('event')].length;
  const result=await tick(s);assert.equal(result.status,'adopted');assert.equal(result.job.disposition,'keep');
  assert.deepEqual([s.store.read('mood'),s.store.read('n'),s.store.read('person')].map(canonical),before);assert.equal([...s.store.all('event')].length,events);assert.deepEqual(s.store.uses('mood'),[]);
});
test('每天最多一次派发；错过多天不补跑，次日可再检查',async t=>{
  const s=seed(setup(t));let calls=0;const invoke=input=>{calls++;return answer(input);};
  await tick(s,invoke);await tick(s,invoke);assert.equal(calls,1);
  s.setTime(START+5*DAY);await tick(s,invoke);assert.equal(calls,2);assert.equal([...s.store.all('maintenance_job')].length,2);
});
test('相同时刻的重复检查复用准备包，不每次写一份完整输入',t=>{
  const s=seed(setup(t)),first=s.maint.inspect();s.setTime(START+1000);const second=s.maint.inspect();
  assert.deepEqual(second.job,first.job);assert.equal(second.job.status,'prepared');
});
test('两个会话并发只允许一个派发，运行中重复tick复用Promise',async t=>{
  const s=seed(setup(t)),other=new MaintenanceSession({store:s.store,subjectId:'person'});let calls=0,release;
  const pending=new Promise(resolve=>{release=resolve;});const invoke=async input=>{calls++;await pending;return answer(input);};
  const a=tick(s,invoke),again=tick(s,invoke);assert.equal(a,again);
  const b=other.tick({invoke,authorize:allowed});await Promise.resolve();release();const results=await Promise.all([a,b]);
  assert.equal(calls,1);assert.ok(results.some(r=>r.status==='adopted'));assert.equal(job(s).calls,1);
});
test('客户端失败保留未知，不自动重试或保存可能含密钥的错误正文',async t=>{
  const s=seed(setup(t));let calls=0;
  const invoke=()=>{calls++;throw Error('sensitive provider error must not be copied');};
  assert.equal((await tick(s,invoke)).status,'uncertain');await tick(s,invoke);assert.equal(calls,1);
  assert.equal(canonical(job(s)).includes('sensitive provider'),false);assert.equal(job(s).error.code,'client-error');
});
test('原始错误JSON先保存，不能冒充已采用，也不再付费重问',async t=>{
  const s=seed(setup(t));let calls=0;const invoke=()=>{calls++;return 'not-json';};
  assert.equal((await tick(s,invoke)).status,'rejected');assert.equal(job(s).status,'failed');assert.equal(job(s).output,'not-json');
  await tick(s,invoke);assert.equal(calls,1);assert.equal(s.store.read('mood').revision,1);
});
test('过大的输出失败不复制整份大对象，不动个人状态',async t=>{
  const s=seed(setup(t)),r=await tick(s,()=> 'x'.repeat(40000));assert.equal(r.status,'failed');assert.equal(job(s).output,null);assert.equal(s.store.read('mood').revision,1);
});
test('主体在整理期间被聊天推进，后台提案不能覆盖',async t=>{
  const s=seed(setup(t));const result=await tick(s,input=>{turn(s);return answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,body:'不应覆盖的新内容',nature:'reappraisal'})]});});
  assert.equal(result.status,'stale');assert.equal(s.store.read('mood').revision,1);assert.equal(job(s).output.includes('不应覆盖'),true);
});
test('长期笔记在思考期间更新会使旧提案过期',async t=>{
  const s=setup(t);put(s.store,'n',note('n',[ref(s.o)]));
  const result=await tick(s,input=>{put(s.store,'n2',note('n',[ref(s.o)],{expectedRevision:1,body:'新认识',change:'reinterpretation'}));return answer(input);});
  assert.equal(result.status,'stale');assert.equal(s.store.read('n').body,'新认识');
});
test('没有新外部来源也可保存主观重评，旧版本仍在且不加深曝光',async t=>{
  const s=seed(setup(t));const r=await tick(s,input=>answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,nature:'reappraisal',body:'还是有点失落，但不再认为他故意冷落我',basis:{priorStates:[{id:'mood',revision:1}]}})]}));
  assert.equal(r.status,'adopted');assert.equal(s.store.read('mood').revision,2);assert.equal(s.store.read('mood',1).body,'仍有点失落，但愿望没有变');
  assert.deepEqual(s.store.uses('mood'),[]);assert.equal(s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),stateRefs:[{id:'mood',revision:2}],budgetBytes:65536}).payload.continuity.recalled[0].ref.revision,2);
});
test('长期笔记从原始来源重新理解，不从维护摘要制造新证据',async t=>{
  const s=setup(t);put(s.store,'n',note('n',[ref(s.o)]));let saw=false;
  const r=await tick(s,input=>{const p=parsed(input);saw=p.sources.some(x=>x.ref.id==='o');return answer(input,{disposition:'update',noteUpdates:[{
    id:'n',expectedRevision:1,body:'我以前的理解不完整，现在仍没想好',kind:'tension',change:'reinterpretation',confidence:'tentative',status:'current',scope:{scenes:[],people:[],validFrom:null,validUntil:null},evidence:[ref(s.o)]}]});});
  assert.equal(saw,true);assert.equal(r.status,'adopted');assert.equal(s.store.read('n').revision,2);assert.equal(s.store.read('n',1).body,'认识 n');
  assert.equal([...s.store.all('event')].length,1);
});
test('一条非法长期写入会回滚同批个人状态和观察处理',async t=>{
  const s=seed(setup(t));const r=await tick(s,input=>answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,body:'不应部分采用'})],noteUpdates:[{
    id:'bad',expectedRevision:0,body:'没有新来源却宣称有证据',kind:'interpretation',change:'new_evidence',confidence:'confident',status:'current',scope:{scenes:[],people:[],validFrom:null,validUntil:null},evidence:[]}]}));
  assert.equal(r.status,'rejected');assert.equal(s.store.read('mood').revision,1);assert.equal(s.store.read('bad'),null);assert.equal(job(s).output.includes('不应部分采用'),true);
});
test('keep或defer不能夹带修改；缺信息可以保留请求不执行外部动作',async t=>{
  const s=seed(setup(t));assert.equal((await tick(s,input=>answer(input,{changes:[state('bad')]}))).status,'rejected');
  s.setTime(START+DAY);const r=await tick(s,input=>answer(input,{disposition:'defer',requests:['还需要当时的原始对话，暂不下结论']}));
  assert.equal(r.status,'adopted');assert.equal(r.job.requests.length,1);assert.equal(s.store.read('bad'),null);
});
test('维护不制造新encounter、问题或发送意图',async t=>{
  const s=seed(setup(t));const r=await tick(s,input=>answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,nature:'encounter',basis:{observations:[ref(s.o)]}})]}));
  assert.equal(r.status,'rejected');assert.equal([...s.store.all('response')].length,0);assert.equal(s.store.read('mood').revision,1);
});
test('长期笔记候选轮转，不让相同前缀每天占着机会',async t=>{
  const s=setup(t,{policy:{...MAINTENANCE_DEFAULTS,maxCandidates:1}});for(let i=0;i<5;i++)put(s.store,`note:${i}`,note(`n${i}`));
  const selected=[];for(let day=0;day<5;day++){s.setTime(START+DAY*day);await tick(s,input=>{selected.push(parsed(input).candidates[0].key);return answer(input);});}
  assert.deepEqual(selected,['n0','n1','n2','n3','n4']);
});
test('未交付的消息不自动handled；整理keep不消费积压',async t=>{
  const s=setup(t);s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});await tick(s);
  assert.equal(s.store.subjectObservation('person','o').status,'received');
});
test('可显式处理已交付的积压，未读引用拒绝',async t=>{
  const s=setup(t);s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});
  const r=await tick(s,input=>answer(input,{disposition:'update',observations:[{ref:ref(s.o),status:'handled'}]}));
  assert.equal(r.status,'adopted');assert.equal(s.store.subjectObservation('person','o').status,'handled');
  s.setTime(START+DAY);turn(s,{changes:[state()]});const bad=await tick(s,input=>answer(input,{disposition:'update',observations:[{ref:{id:'not-read',revision:1},status:'handled'}]}));assert.equal(bad.status,'rejected');
});
test('超大原文不会被截成残缺事实，不阻碍检查其他小项目',async t=>{
  const s=seed(setup(t));const [huge]=put(s.store,'huge',event('huge',{body:'长'.repeat(50000)}));s.store.execute({requestId:'admit-huge',commands:[{op:'admit_subject_event',subjectId:'person',event:ref(huge)}]});
  const r=await tick(s,input=>{const p=parsed(input);assert.ok(p.omissions.some(o=>['input-budget','record-byte-budget'].includes(o.reason)));assert.equal(p.materials.some(m=>m.ref.id==='huge'),false);return answer(input);});
  assert.equal(r.status,'adopted');assert.equal(s.store.subjectObservation('person','huge').status,'received');
});
test('采用前关闭开关使提案过期，不改变原状态',async t=>{
  const s=seed(setup(t));const r=await tick(s,input=>{s.maint.configure({policy:{...MAINTENANCE_DEFAULTS,enabled:false}});return answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,body:'不能采用'})]});});
  assert.equal(r.status,'stale');assert.equal(s.store.read('mood').revision,1);assert.equal(s.maint.inspect().status,'disabled');
});
test('授权等待期间有新聊天，不派发过期输入',async t=>{
  const s=seed(setup(t));let calls=0;const r=await tick(s,input=>{calls++;return answer(input);},{authorize:()=>{turn(s);return true;}});
  assert.equal(r.status,'needs-refresh');assert.equal(calls,0);assert.equal(job(s).calls,0);
});
test('时钟回退不重置当天请求上限',async t=>{
  const s=seed(setup(t));await tick(s);s.setTime(START-DAY);assert.equal(s.maint.inspect().status,'clock-regressed');
  s.setTime(START);assert.equal(s.maint.inspect().status,'adopted');assert.equal([...s.store.all('maintenance_job')].length,1);
});
test('提案可先保存再采用，重入不会再调用模型',async t=>{
  const s=seed(setup(t));let calls=0;const r=await tick(s,input=>{calls++;return answer(input);},{autoAdopt:false});assert.equal(r.status,'proposed');
  await tick(s,()=>{calls++;throw Error('no');});assert.equal(calls,1);assert.equal(s.maint.adopt({job:pin(r.job)}).status,'adopted');
});
test('重启保留已派发标志，不自动重试未知请求',async t=>{
  const path=disk(t),s=seed(setup(t,{path})),prepared=s.maint.inspect().job;
  s.store.execute({requestId:'dispatch-before-crash',commands:[{op:'dispatch_maintenance',job:pin(prepared),claimId:'crashed-worker'}]});s.store.close();
  const reopened=new ContinuityStore(path,{clock:()=>START});const maint=new MaintenanceSession({store:reopened,subjectId:'person'});let calls=0;
  const r=await maint.tick({authorize:allowed,invoke:()=>{calls++;throw Error('no');}});assert.equal(r.status,'dispatched');assert.equal(calls,0);reopened.close();
});
test('心跳使用宿主空闲标志，停止后不再发起检查',async t=>{
  const s=seed(setup(t));let calls=0;const h=startMaintenanceHeartbeat({session:s.maint,isBusy:()=>true,invoke:()=>{calls++;},authorize:allowed});
  await h.tick();h.stop();await h.tick();assert.equal(calls,0);assert.equal(job(s),null);
});

const purpose=kind=>({kind,eventIds:[],questionId:null,appliesTo:null});
const resident=(target,revision=1)=>({id:'r',target:{kind:'state',ref:{id:target,revision}},cue:'旧入口',purposes:[purpose('self-directed')]});
const q={id:'q',expectedRevision:0,op:'open',text:'你想吃什么',awaitingResponseFrom:'brother',responseEvent:null};
test('维护只更新过时cue，不改写心情正文或制造新状态版本',async t=>{
  const s=setup(t);turn(s,{changes:[state()],attention:{...keepAttention(),residency:{upsert:[resident('mood')],remove:[]}}});
  turn(s,{stateRefs:[{id:'mood',revision:1}],changes:[state('mood',{expectedRevision:1,body:'仍然烦，但不想拿聊天出气',nature:'reappraisal'})]});
  const before=canonical(s.store.read('mood'));
  const result=await tick(s,input=>{const p=parsed(input);assert.ok(p.candidates.some(c=>c.reasons.includes('outdated-entry')));
    return answer(input,{disposition:'update',attention:{...keepAttention(),residency:{upsert:[{...resident('mood',2),cue:'还没消化完的烦躁，暂不展开'}],remove:[]}}});});
  assert.equal(result.status,'adopted');assert.equal(canonical(s.store.read('mood')),before);
  assert.equal(s.store.read(attentionId('person')).residences[0].cueFor.revision,2);
});
test('可以收束驻留但不删记忆，也可自选新的非任务关注',async t=>{
  const s=setup(t);turn(s,{changes:[state()],attention:{...keepAttention(),residency:{upsert:[resident('mood')],remove:[]}}});
  const before=canonical(s.store.read('mood'));const r=await tick(s,input=>answer(input,{disposition:'update',attention:{...keepAttention(),residency:{upsert:[],remove:['r']}}}));
  assert.equal(r.status,'adopted');assert.equal(s.store.read(attentionId('person')).residences.length,0);assert.equal(canonical(s.store.read('mood')),before);
  s.setTime(START+DAY);const restored=await tick(s,input=>answer(input,{disposition:'update',attention:{...keepAttention(),residency:{upsert:[resident('mood')],remove:[]}}}));
  assert.equal(restored.status,'adopted');assert.equal(s.store.read('mood').revision,1);
});
test('新聊天已经开始但还没提交，也能抢占后台提案而保留正常回应',async t=>{
  const s=seed(setup(t));let normalPacket;
  const r=await tick(s,input=>{normalPacket=s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});return answer(input,{disposition:'update',changes:[state('mood',{expectedRevision:1,body:'不该抢在聊天前写进去'})]});});
  assert.equal(r.status,'stale');assert.equal(s.store.read('mood').revision,1);
  const decision=s.normal.commit({packet:normalPacket,requestId:'normal-wins',decisionId:'normal-wins',output:{packetId:normalPacket.packetId,options:[{id:'r',kind:'respond',payload:{text:'继续聊呀'}}],selected:'r',summary:'前台优先',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}}});
  assert.equal(s.store.read(`${decision.id}:response`).status,'pending');
});
test('每次只看一个候选时五条通路也会轮转，不被驻留永久占满',async t=>{
  const s=setup(t,{policy:{...MAINTENANCE_DEFAULTS,maxCandidates:1}});
  turn(s,{changes:[state()],kind:'respond',payload:{text:'你想吃什么'},attention:{...keepAttention(),questions:[q],residency:{upsert:[resident('mood')],remove:[]}}});
  const [pending]=put(s.store,'pending',event('pending'));s.normal.prepare({currentEvent:ref(pending),workspace:ref(s.w),budgetBytes:65536});put(s.store,'note',note('n'));
  const lanes=[];for(let day=0;day<5;day++){s.setTime(START+DAY*day);await tick(s,input=>{lanes.push(parsed(input).candidates[0].lane);return answer(input);});}
  assert.deepEqual(lanes,['residences','questions','inbox','experiences','objects']);
});
test('模型可根据已送达问题与真实积压回答，关闭同一个问题',async t=>{
  const s=setup(t),d=turn(s,{kind:'respond',payload:{text:'你想吃什么'},attention:{...keepAttention(),questions:[q]}});send(s,d);
  const [e]=put(s.store,'answer',event('answer',{body:'想吃面条'}));s.normal.prepare({currentEvent:ref(e),workspace:ref(s.w),budgetBytes:65536});
  const r=await tick(s,input=>answer(input,{disposition:'update',attention:{...keepAttention(),questions:[{...q,expectedRevision:1,op:'handle',responseEvent:ref(e)}]},observations:[{ref:ref(e),status:'handled'}]}));
  assert.equal(r.status,'adopted');assert.equal(s.store.read(attentionId('person')).questions[0].status,'handled');assert.equal(s.store.subjectObservation('person','answer').status,'handled');
});
test('发送回执晚到也使旧维护包过期，不能误认回答情况',async t=>{
  const s=setup(t),d=turn(s,{kind:'respond',payload:{text:'你想吃什么'},attention:{...keepAttention(),questions:[q]}});
  const r=await tick(s,input=>{send(s,d);return answer(input);});assert.equal(r.status,'stale');assert.equal(s.store.read(attentionId('person')).questions[0].status,'open');
});
test('背景维护不自动发起追问或把计划当成行动',async t=>{
  const s=setup(t);turn(s,{kind:'respond',payload:{text:'你想吃什么'},attention:{...keepAttention(),questions:[q]}});
  const before=[...s.store.all('response')].length;
  const r=await tick(s,input=>answer(input,{disposition:'update',attention:{...keepAttention(),questions:[{...q,expectedRevision:1,op:'followup'}]}}));
  assert.equal(r.status,'rejected');assert.equal([...s.store.all('response')].length,before);
});
test('直接来源超预算明确标缺，不用二手摘要补成原始事实',async t=>{
  const s=setup(t,{policy:{...MAINTENANCE_DEFAULTS,maxSources:0}});put(s.store,'note',note('n',[ref(s.o)]));
  const r=await tick(s,input=>{const p=parsed(input);assert.equal(p.sources.length,0);assert.ok(p.missingSources.some(x=>x.reason==='source-budget'));return answer(input,{disposition:'defer',requests:['原始来源没交付，先不改认识']});});
  assert.equal(r.status,'adopted');assert.equal(s.store.read('n').revision,1);
});
test('预算授权跨过午夜时不派发昨日输入，今天可以重新检查',async t=>{
  const s=seed(setup(t));let calls=0;
  const r=await tick(s,input=>{calls++;return answer(input);},{authorize:()=>{s.setTime(START+DAY);return true;}});
  assert.equal(r.status,'needs-refresh');assert.equal(calls,0);assert.equal((await tick(s)).status,'adopted');
});
test('更改时间和重新开启不能重置同一天的调用上限',async t=>{
  const s=seed(setup(t));let calls=0;const invoke=input=>{calls++;return answer(input);};await tick(s,invoke);
  s.maint.configure({policy:{...MAINTENANCE_DEFAULTS,enabled:false}});s.maint.configure({policy:{...MAINTENANCE_DEFAULTS,hour:2}});
  await tick(s,invoke);assert.equal(calls,1);assert.equal(job(s).calls,1);
});

test('单记录字节上限在SQL读取时生效，原始内容仍完整保留',t=>{
  const s=setup(t);const [large]=put(s.store,'large',event('large',{body:'原'.repeat(20000)}));
  const bounded=s.store.readBounded(large.id,1,4096);assert.equal(bounded.omitted,'record-byte-budget');assert.equal(bounded.body,undefined);
  assert.equal(s.store.read(large.id,1).body.length,20000);assert.ok(bounded.byteSize>4096);
});
test('宿主客户端收到生成token上限和禁止自动重试的约定',async t=>{
  const s=seed(setup(t));let settings;
  await tick(s,(input,options)=>{settings=options;return answer(input);});
  assert.equal(settings.maxOutputTokens,2048);assert.equal(settings.automaticRetries,0);assert.equal(settings.category,'autonomous-maintenance');
});
test('未交付的驻留不能靠猜ID删除',async t=>{
  const s=setup(t,{policy:{...MAINTENANCE_DEFAULTS,maxCandidates:1}});turn(s,{changes:[state('a'),state('b')],attention:{...keepAttention(),residency:{upsert:[{...resident('a'),id:'r1'},{...resident('b'),id:'r2'}],remove:[]}}});
  const r=await tick(s,input=>{assert.equal(parsed(input).continuity.attention.residences.length,1);return answer(input,{disposition:'update',attention:{...keepAttention(),residency:{upsert:[],remove:['r2']}}});});
  assert.equal(r.status,'rejected');assert.equal(s.store.read(attentionId('person')).residences.length,2);
});
test('两个SQLite连接也不能因幂等回执误拿两次调用许可',async t=>{
  const path=disk(t),s=seed(setup(t,{path})),other=new ContinuityStore(path,{clock:()=>START});
  const second=new MaintenanceSession({store:other,subjectId:'person'});let calls=0,release;const waiting=new Promise(r=>{release=r;});
  const invoke=async input=>{calls++;await waiting;return answer(input);};
  const a=tick(s,invoke),b=second.tick({invoke,authorize:allowed});await Promise.resolve();release();await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(job(s).status,'adopted');other.close();s.store.close();
});
test('schema4需审核副本后显式升级，保留旧来源与前台',t=>{
  const path=disk(t),s=seed(setup(t,{path})),old=s.store.read('mood');s.store.close();
  const DB=sqlite.Database??sqlite.DatabaseSync,db=new DB(path);db.exec('PRAGMA user_version=4');db.close();
  assert.throws(()=>new ContinuityStore(path),code('MIGRATION_REQUIRED'));
  const opened=new ContinuityStore(path,{migrateV4:true});assert.deepEqual(opened.read('mood'),old);assert.equal(opened.snapshot().schemaVersion,SCHEMA_VERSION);opened.close();
});

test('即使前台再次准备完全相同的输入，也必须重新抢占旧后台提案',async t=>{
  const s=seed(setup(t)),args={currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536},first=s.normal.prepare(args);
  const r=await tick(s,input=>{const again=s.normal.prepare(args);assert.equal(again.packetId,first.packetId);return answer(input);});
  assert.equal(r.status,'stale');assert.equal(s.store.read('mood').revision,1);
});

test('已经正常回复过的经历也会进入有限回顾，不只处理deferred',async t=>{
  const s=setup(t);turn(s);assert.equal(s.store.subjectObservation('person','o').status,'handled');
  const r=await tick(s,input=>{const p=parsed(input);assert.ok(p.candidates.some(c=>c.lane==='experiences'));assert.equal(p.pendingObservations.length,0);
    return answer(input,{disposition:'update',noteUpdates:[{id:'experience-note',expectedRevision:0,body:'保留这次实际接收的经历',kind:'fact_claim',change:'new_evidence',confidence:'tentative',status:'current',scope:{scenes:[],people:[],validFrom:null,validUntil:null},evidence:[ref(s.o)]}]});});
  assert.equal(r.status,'adopted');assert.deepEqual(s.store.read('experience-note').rootIds,['o']);assert.equal(s.store.subjectObservation('person','o').status,'handled');
});
test('当天回顾过的原始经历不按日从头再扫；两条入口同源只交付一次',async t=>{
  const s=setup(t);s.normal.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});
  const r=await tick(s,input=>{const p=parsed(input);assert.equal(p.materials.filter(m=>m.ref.id==='o').length,1);assert.equal(p.candidates.filter(c=>c.kind==='event').length,1);
    return answer(input,{disposition:'update',observations:[{ref:ref(s.o),status:'handled'}]});});
  assert.equal(r.status,'adopted');s.setTime(START+DAY);assert.equal((await tick(s)).status,'empty');
});

test('超大经历被跳过后仍未标为已回顾，其他小经历不会每天重复呈现',async t=>{
  const s=setup(t),[big,small]=put(s.store,'mixed',event('big',{body:'大'.repeat(30000)}),event('small'));
  for(const e of [big,small])s.store.execute({requestId:`admit:${e.id}`,commands:[{op:'admit_subject_event',subjectId:'person',event:ref(e)}]});
  const first=await tick(s,input=>answer(input,{disposition:'update',observations:[{ref:ref(small),status:'handled'}]}));assert.equal(first.status,'adopted');
  const remaining=s.store.maintenanceExperiences({subjectId:'person',afterSeq:999,limit:32});assert.deepEqual(remaining.items.map(e=>e.eventId),['big']);
  assert.equal(s.store.subjectObservation('person','big').status,'received');assert.deepEqual(s.store.uses('small'),[]);
});

test('维护会话不能采用另一主体的后台提案',async t=>{
  const s=seed(setup(t)),proposed=await tick(s,input=>answer(input),{autoAdopt:false});
  new ContinuitySession({store:s.store,subjectId:'other',attention:true});const other=new MaintenanceSession({store:s.store,subjectId:'other'});
  assert.throws(()=>other.adopt({job:pin(proposed.job)}),code('SUBJECT_MISMATCH'));assert.equal(job(s).status,'proposed');
});
test('自动采用开关类型错误时不准备任务或调用客户端',async t=>{
  const s=seed(setup(t));await assert.rejects(tick(s,()=>{throw Error('no');},{autoAdopt:'false'}),code('MAINTENANCE_POLICY'));
  assert.equal(job(s),null);
});

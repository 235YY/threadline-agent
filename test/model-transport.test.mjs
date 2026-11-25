import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {prepareReflection,verifiedModelInput} from '../src/cognition.mjs';
import {admitSubjectEvent} from '../src/continuity.mjs';
import {reflectionFrame} from '../src/reflection-frame.mjs';
import {createModelDecision,DailyBudgetLedger} from '../src/model-transport.mjs';
import {memory,event,frame,put,ref} from './helpers.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {writeFileSync,readFileSync} from 'node:fs';
const tmp=t=>{const dir=mkdtempSync(join(tmpdir(),'jingyang-transport-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

const KEY='sk-abcdefghijklmnop';
function packet(t,now=1000,style=''){
  const {store}=memory(t);
  new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
  const w=store.read('qq')??put(store,'workspace',frame())[0];
  return prepareReflection({store,subjectId:'actor',workspace:ref(w),identity:'你是小栈。',style,
    internal:reflectionFrame({read:(id,rev)=>store.read(id,rev),subjectId:'actor',workspace:ref(w),now}),budgetBytes:90000});
}
function response(content){
  return new Response(JSON.stringify({id:'r1',created:1,model:'deepseek-flash',
    choices:[{finish_reason:'stop',message:{content}}],
    usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60}}),
  {status:200,headers:{'content-type':'application/json'}});
}
const okNetwork=async()=>({ok:true,classification:'test'});
test('official mode ignores old financial halt while retaining exact request dedupe and immutable history',async t=>{const dir=tmp(t),history=join(dir,'old.json'),raw=JSON.stringify({halted:'old unknown',requests:[{id:'old-request',status:'uncertain',reserveMicros:9000000}]});writeFileSync(history,raw);let sends=0;const journal=new RequestJournal(join(dir,'requests.json'),{history}),model=createModelDecision({ledgerPath:join(dir,'requests.json'),requestJournal:journal,getKey:()=>KEY,networkCheck:okNetwork,transport:async()=>{sends++;return response('synthetic result');}});try{const p=packet(t),options={source:{subject:'actor',kind:'reflection',opportunity:{id:'persisted-fixture-opportunity',revision:1}}};assert.equal(await model.decide(p,options),'synthetic result');assert.equal(await model.decide(p,options),'synthetic result');assert.equal(sends,1);assert.equal(journal.find('turn:'+p.packetId).reserveMicros,undefined);assert.equal(readFileSync(history,'utf8'),raw);}finally{model.close();}});

test('不可用的服务商结束结果保留公开正文和原因，仍不重发',async t=>{
 const ledgerPath=join(tmp(t),'budget.json');let calls=0;
 const model=createModelDecision({ledgerPath,getKey:()=>KEY,networkCheck:okNetwork,transport:async()=>{calls++;return new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'content_filter',message:{content:'模拟拒答'}}],usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60}}),{status:200});}});
 try{const p=packet(t);await assert.rejects(model.decide(p),{code:'MODEL_INCOMPLETE'});const row=model.ledger.data.requests[0];assert.equal(row.status,'settled');assert.equal(row.providerResult.finishReason,'content_filter');assert.equal(row.providerResult.output,'模拟拒答');await assert.rejects(model.decide(p),{code:'TRANSPORT_REPLAY'});assert.equal(calls,1);}finally{model.close();}
});

test('一次成功：计费结算、记录输出；同一 packet 重放不再发送',async t=>{
  const dir=tmp(t),ledgerPath=join(dir,'budget.json');
  let calls=0;const transport=async()=>{calls++;return response('{"她":"决定"}');};
  const {decide,state,close}=createModelDecision({ledgerPath,getKey:()=>KEY,transport,networkCheck:okNetwork});
  const p=packet(t);
  try{
    const out=await decide(p);
    assert.equal(out,'{"她":"决定"}');
    assert.equal(calls,1);
    const s=state();assert.equal(s.calls,1);assert.equal(s.settled,1);assert.ok(s.costMicros>0&&s.costMicros<3000000);
    const again=await decide(p);
    assert.equal(again,out);assert.equal(calls,1,'重放走账本记录，不重复付费');
  }finally{close();}
});

test('staged reflection sends the same sealed data with a longer stable prefix',async t=>{
 const requests=[];
 const model=createModelDecision({ledgerPath:join(tmp(t),'reflection.json'),getKey:()=>KEY,
  networkCheck:okNetwork,profile:{wireLayout:'staged-v1'},transport:async(_url,init)=>{
    requests.push(JSON.parse(init.body).messages);return response('synthetic result');
  }});
 try{
  const style='长时间保持一致的表达偏好';
  const first=packet(t,1000,style),second=packet(t,2000,style);
  await model.decide(first);await model.decide(second);
  const original=first.messages[1].content;
  const changed=requests[0][1].content;
  assert.equal(requests[0][0].content,first.messages[0].content);
  assert.deepEqual(JSON.parse(changed),JSON.parse(original));
  assert.equal(Object.keys(JSON.parse(changed)).at(-1),'packetId');
  assert.ok(changed.startsWith('{"identity":"你是小栈。","style":'));
  const prefix=(a,b)=>{let i=0;while(i<Math.min(a.length,b.length)&&a[i]===b[i])i++;return i;};
  assert.ok(prefix(changed,requests[1][1].content)>prefix(original,second.messages[1].content));
  assert.equal(model.ledger.find('turn:'+first.packetId).wireTelemetry.variant,'reflection-prefix-v1');
 }finally{model.close();}
});

test('compact memory reflection omits previous dialogue and keeps new delayed events and pinned material',t=>{
 const {store,setTime}=memory(t);
 new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
 setTime(2000);
 const [w,old,archived]=put(store,'old',frame(),event('old',{occurredAt:1800}),
   event('archived',{body:'更早的完整历史'.repeat(75),occurredAt:1800}));
 setTime(3000);
 const [anchor]=put(store,'anchor',event('anchor',{occurredAt:2900}));
 setTime(4000);
 const [fresh]=put(store,'fresh',event('fresh',{occurredAt:1500,body:'刚入账的迟到消息'}));
 for(const row of [old,archived,anchor,fresh])admitSubjectEvent({store,subjectId:'actor',event:ref(row),requestId:'admit:'+row.id});
 const base={store,subjectId:'actor',workspace:ref(w),identity:'你是小栈。',
   internal:reflectionFrame({read:(id,rev)=>store.read(id,rev),subjectId:'actor',workspace:ref(w),now:5000}),
   budgetBytes:90000,memoryUpdateDue:true,localLookupPolicy:{maxReads:2,maxHits:4},materials:[{ref:ref(old),aspect:'experience'}]};
 const compact=prepareReflection({...base,reflectionAfterEventId:anchor.id});
 const legacy=prepareReflection(base);
 assert.ok(compact.bytes<legacy.bytes);
 assert.ok(compact.payload.continuity.recent.items.some(item=>item.ref.id===fresh.id));
 assert.equal(compact.payload.continuity.recent.batchDelivery.omittedEarlierTurns,2);
 assert.deepEqual(compact.payload.materials,legacy.payload.materials);
 assert.equal(verifiedModelInput(compact).packetId,compact.packetId);
 assert.equal(prepareReflection({...base,reflectionAfterEventId:'missing'}).packetId,legacy.packetId);
});

test('an interrupted reflection repair resumes with the original staged messages',async t=>{
 const path=join(tmp(t),'reflection-repair.json'),p=packet(t),sent=[];
 const fixed=JSON.stringify({packetId:p.packetId,options:[{id:'wait'}],selected:'wait',continuity:{}});
 const open=wireLayout=>createModelDecision({ledgerPath:path,getKey:()=>KEY,networkCheck:okNetwork,
  profile:{wireLayout,formatRecovery:true},transport:async(_url,init)=>{
    sent.push(JSON.parse(init.body).messages);return response(sent.length===1?'{':fixed);
  }});
 const first=open('staged-v1');
 try{
  await assert.rejects(first.decide(p,{beforeCorrection:()=>{throw Error('repair interrupted');}}),/repair interrupted/);
  assert.equal(sent.length,1);
 }finally{first.close();}
 const reopened=open('legacy');
 try{
  assert.equal(await reopened.decide(p),fixed);
  assert.deepEqual(sent[1].slice(0,sent[0].length),sent[0]);
  assert.equal(await reopened.decide(p),fixed);
  assert.equal(sent.length,2);
 }finally{reopened.close();}
});

test('configured upstream SSE settles complete replies and fences a truncated request',async t=>{
 const dir=tmp(t),requests=[];
 const model=createModelDecision({ledgerPath:join(dir,'sse.json'),getKey:()=>KEY,networkCheck:okNetwork,
  profile:{upstreamSse:true},transport:async(_url,init)=>{
   requests.push(JSON.parse(init.body));
   const frames=[
    {choices:[{delta:{reasoning_content:'private reasoning'}}]},
    {choices:[{delta:{content:'streamed answer'},finish_reason:'stop'}]},
   ];
   if(requests.length===1)frames.push({choices:[],usage:{prompt_tokens:10,completion_tokens:3,prompt_cache_hit_tokens:4,prompt_cache_miss_tokens:6}},'[DONE]');
   return new Response(frames.map(value=>'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n').join(''),
    {headers:{'content-type':'text/event-stream'}});
  }});
 try{
  const first=packet(t);
  assert.equal(await model.decide(first),'streamed answer');
  assert.equal(requests[0].stream,true);
  assert.equal(requests[0].stream_options.include_usage,true);
  assert.equal(model.ledger.find('turn:'+first.packetId).status,'settled');
  const second=packet(t,2000);
  assert.notEqual(second.packetId,first.packetId);
  await assert.rejects(model.decide(second),{code:'UNCERTAIN_REQUEST'});
  assert.equal(model.ledger.find('turn:'+second.packetId).status,'uncertain');
  await assert.rejects(model.decide(second),{code:'TRANSPORT_REPLAY'});
  assert.equal(requests.length,2);
 }finally{model.close();}
});

test('网络预检失败：不保留、不发送',async t=>{
  const dir=tmp(t);let calls=0;
  const {decide,state,close}=createModelDecision({ledgerPath:join(dir,'budget.json'),getKey:()=>KEY,
    transport:async()=>{calls++;return response('x');},networkCheck:async()=>({ok:false,classification:'dns'})});
  try{
    await assert.rejects(()=>decide(packet(t)),{code:'NETWORK_PREFLIGHT_FAILED',transportInvoked:false,failurePhase:'before-transport'});
    assert.equal(calls,0);assert.equal(state().calls,0);
  }finally{close();}
});

test('日预算不足：在发送前拒绝',async t=>{
  const dir=tmp(t);let calls=0;
  const {decide,close}=createModelDecision({ledgerPath:join(dir,'budget.json'),getKey:()=>KEY,
    transport:async()=>{calls++;return response('x');},networkCheck:okNetwork,profile:{dailyMicros:1}});
  try{await assert.rejects(()=>decide(packet(t)),{code:'SPEND_LIMIT'});assert.equal(calls,0);}
  finally{close();}
});

test('费用未知：保留为不确定并停止，不自动重发',async t=>{
  const dir=tmp(t);let calls=0;
  const {decide,state,ledger,close}=createModelDecision({ledgerPath:join(dir,'budget.json'),getKey:()=>KEY,
    transport:async()=>{calls++;throw Object.assign(new Error('reset'),{code:'ECONNRESET'});},networkCheck:okNetwork});
  const p=packet(t);
  try{
    await assert.rejects(()=>decide(p),{code:'UNCERTAIN_REQUEST'});
    assert.equal(calls,1);assert.equal(state().halted!==null,true);
    await assert.rejects(()=>decide(p),{code:'TRANSPORT_REPLAY'});
    assert.equal(calls,1,'不重试');
    assert.equal(ledger.tryFind(`turn:${p.packetId}`).status,'uncertain');
  }finally{close();}
});

test('跨天重置额度并归档旧日账本',async t=>{
  const dir=tmp(t),ledgerPath=join(dir,'budget.json');
  const day1=createModelDecision({ledgerPath,getKey:()=>KEY,transport:async()=>response('ok'),networkCheck:okNetwork,dayKey:'2026-11-07'});
  try{await day1.decide(packet(t));assert.equal(day1.state().calls,1);}finally{day1.close();}
  const day2=createModelDecision({ledgerPath,getKey:()=>KEY,transport:async()=>response('ok'),networkCheck:okNetwork,dayKey:'2026-11-08'});
  try{assert.equal(day2.state().calls,0);assert.equal(day2.state().dayKey,'2026-11-08');
    assert.equal(existsSync(`${ledgerPath}.2026-11-07.json`),true,'旧日账本归档保留');}finally{day2.close();}
});

test('同日限制不可偷偷放宽；锁文件阻止并发写',async t=>{
  const dir=tmp(t),ledgerPath=join(dir,'budget.json');
  const first=new DailyBudgetLedger(ledgerPath,{dailyMicros:3000000,dailyCalls:96,dayKey:'2026-11-07'});
  try{assert.throws(()=>new DailyBudgetLedger(ledgerPath,{dailyMicros:3000000,dailyCalls:96,dayKey:'2026-11-07'}),{code:'LEDGER_LOCKED'});}finally{first.close();}
  assert.throws(()=>new DailyBudgetLedger(ledgerPath,{dailyMicros:4000000,dailyCalls:96,dayKey:'2026-11-07'}),{code:'BUDGET_POLICY'});
  const reopened=new DailyBudgetLedger(ledgerPath,{dailyMicros:3000000,dailyCalls:96,dayKey:'2026-11-07'});
  reopened.close();
});

test('host packet rejection happens before key, preflight, reservation or transport',async t=>{let keys=0,network=0,sent=0;const model=createModelDecision({ledgerPath:join(tmp(t),'budget.json'),getKey:()=>{keys++;return KEY;},networkCheck:async()=>{network++;return {ok:true};},transport:async()=>{sent++;throw Error('must not send');}});try{const p=packet(t);p.messages[0].content+='tampered';await assert.rejects(model.decide(p),e=>e.code==='PACKET_CHANGED'&&e.transportInvoked===false);assert.equal(keys,0);assert.equal(network,0);assert.equal(sent,0);assert.equal(model.ledger.data.requests.length,0);}finally{model.close();}});

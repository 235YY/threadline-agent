import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {prepareReflection} from '../src/cognition.mjs';
import {reflectionFrame} from '../src/reflection-frame.mjs';
import {createModelDecision,DailyBudgetLedger} from '../src/model-transport.mjs';
import {memory,frame,put,ref} from './helpers.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {writeFileSync,readFileSync} from 'node:fs';
const tmp=t=>{const dir=mkdtempSync(join(tmpdir(),'jingyang-transport-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

const KEY='sk-abcdefghijklmnop';
function packet(t){
  const {store}=memory(t);
  new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
  const w=store.read('qq')??put(store,'workspace',frame())[0];
  return prepareReflection({store,subjectId:'actor',workspace:ref(w),identity:'你是鲸漾。',
    internal:reflectionFrame({read:(id,rev)=>store.read(id,rev),subjectId:'actor',workspace:ref(w),now:1000}),budgetBytes:90000});
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

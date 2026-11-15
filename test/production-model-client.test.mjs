// Same offline transport contract, exercised against the production module.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StudyLedger,DeepSeekStudyClient,pricedUsage,probeStudyNetwork,requireStudyNetwork} from '../src/model-client.mjs';
import {buildCase,STUDY_CASES} from '../experiments/model-study/scenarios.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'jingyang-study-unit-')),path=join(dir,'budget.json');
  const ledger=new StudyLedger(path);t.after(()=>{ledger.close();for(const suffix of ['','.new','.lock'])if(existsSync(path+suffix))unlinkSync(path+suffix);rmdirSync(dir);});return {path,ledger};}
const validUsage={prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:50,prompt_cache_miss_tokens:50,completion_tokens_details:{reasoning_tokens:12}};
test('价格用互不重叠的桶；reasoning不重复收费；缺用量不猜费用',()=>{
  const u=pricedUsage(validUsage);assert.equal(u.upperMicros,262);assert.equal(u.reasoning,12);
  assert.throws(()=>pricedUsage({...validUsage,prompt_tokens:101}),{code:'UNKNOWN_USAGE'});
});
test('预算跨打开保留，超额预留和重复请求被拒绝',t=>{
  const {ledger,path}=setup(t);ledger.reserve('a','hash',900000);ledger.dispatch('a');ledger.settle('a',{upperMicros:800000});
  assert.throws(()=>ledger.reserve('b','hash',300000),{code:'SPEND_LIMIT'});
  assert.throws(()=>ledger.reserve('a','hash',100),{code:'ALREADY_REQUESTED'});ledger.close();
  const reopened=new StudyLedger(path);assert.equal(reopened.data.requests[0].actualMicros,800000);reopened.close();
});
test('未确认请求阻止重开，不把异常网络当成免费',t=>{
  const {ledger,path}=setup(t);ledger.reserve('a','hash',100);ledger.dispatch('a');ledger.uncertain('a','timeout');ledger.close();
  assert.throws(()=>new StudyLedger(path),{code:'UNCERTAIN_SPEND'});
});
test('并发锁与调用次数独立于金额',t=>{
  const {ledger,path}=setup(t);assert.throws(()=>new StudyLedger(path),{code:'LEDGER_LOCKED'});
  for(let i=0;i<24;i++){ledger.reserve(`r${i}`,'hash',1);ledger.dispatch(`r${i}`);ledger.settle(`r${i}`,{upperMicros:0});}
  assert.throws(()=>ledger.reserve('extra','hash',1),{code:'CALL_LIMIT'});
});
test('明确保留未知费用后只能继续不同请求，未知预留仍占总预算',t=>{
  const {ledger,path}=setup(t);ledger.reserve('old','hash',800000);ledger.dispatch('old');ledger.uncertain('old','ENOTFOUND');ledger.close();
  const continued=new StudyLedger(path,{continueHoldingUncertain:true});
  assert.equal(continued.data.requests[0].status,'held-uncertain');
  assert.throws(()=>continued.reserve('old','hash',1),{code:'ALREADY_REQUESTED'});
  assert.throws(()=>continued.reserve('new','hash',300000),{code:'SPEND_LIMIT'});
  continued.reserve('different','hash',100000);continued.release('different');continued.close();
});
test('真实适配器的模拟响应只返回最终内容，不保存推理文本或密钥',async t=>{
  const {ledger,path}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());
  let sent;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>`sk-${'x'.repeat(20)}`,transport:async(url,opts)=>{
    sent={url,body:JSON.parse(opts.body),redirect:opts.redirect};
    return new Response(JSON.stringify({model:'test-model',usage:validUsage,choices:[{finish_reason:'stop',message:{content:'{"ok":true}',reasoning_content:'PRIVATE-REASONING'}}]}));}});
  const r=await client.call({id:'test',packet:c.packet});assert.equal(r.complete,true);assert.equal(r.output,'{"ok":true}');
  assert.equal(JSON.stringify(r).includes('PRIVATE-REASONING'),false);assert.equal(readFileSync(path,'utf8').includes('sk-'),false);
  assert.equal(sent.body.reasoning_effort,'high');assert.equal(sent.body.tools,undefined);assert.equal(sent.redirect,'error');assert.equal(sent.url,'https://api.deepseek.com/chat/completions');
});
test('HTTP失败只有一次发送，保留费用上界并停止',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());let sends=0;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>`sk-${'x'.repeat(20)}`,transport:async()=>{sends++;return new Response('denied',{status:403});}});
  await assert.rejects(client.call({id:'denied',packet:c.packet}),{code:'UNCERTAIN_REQUEST'});
  assert.equal(sends,1);assert.equal(ledger.data.requests[0].status,'uncertain');assert.equal(ledger.data.requests[0].httpStatus,403);assert.ok(ledger.data.halted);
});
test('调用前取消或输入篡改不建立预留，不读取凭据或发送',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());let sends=0;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>`sk-${'x'.repeat(20)}`,transport:async()=>{sends++;throw Error('must not run');}});
  const controller=new AbortController();controller.abort();
  await assert.rejects(client.call({id:'cancelled',packet:c.packet,signal:controller.signal}),{code:'CANCELLED'});
  const damaged=structuredClone(c.packet);damaged.payload.identity='changed';
  await assert.rejects(client.call({id:'tampered',packet:damaged}),{code:'PACKET_CHANGED'});
  assert.equal(sends,0);assert.equal(ledger.data.requests.length,0);
});

test('联网预检期间取消也不读取凭据或建立预留',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());
  const controller=new AbortController();let keys=0,sends=0;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>{keys++;return `sk-${'x'.repeat(20)}`;},
    networkCheck:async()=>{controller.abort();return {ok:true};},transport:async()=>{sends++;throw Error('must not send');}});
  await assert.rejects(client.call({id:'cancel-during-probe',packet:c.packet,signal:controller.signal}),{code:'CANCELLED'});
  assert.equal(keys,0);assert.equal(sends,0);assert.equal(ledger.data.requests.length,0);
});

test('公开联网预检不带密钥，401只说明可达；本地DNS失败不否决已通的代理路线',async()=>{
  let seen;
  const check=await probeStudyNetwork({lookup:async()=>{const e=Error('private-diagnostic');e.code='ENOTFOUND';throw e;},
    transport:async(url,options)=>{seen={url,options};return new Response(null,{status:401});}});
  assert.equal(check.ok,true);assert.equal(check.classification,'reachable-authentication-required');
  assert.equal(check.dns.code,'ENOTFOUND');assert.equal(check.credentialsUsed,false);assert.equal(check.modelRequestsSent,0);
  assert.equal(seen.options.method,'HEAD');assert.equal(seen.options.headers,undefined);assert.equal(seen.options.body,undefined);
  assert.equal(JSON.stringify(check).includes('private-diagnostic'),false);
});
test('预检DNS/连接失败发生在读取密钥和预留前，不污染次数和未知账本',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());
  let keys=0,sends=0;
  const networkCheck=()=>requireStudyNetwork({lookup:async()=>({family:4}),transport:async()=>{const e=new Error('secret detail');e.code='ENOTFOUND';throw e;}});
  const client=new DeepSeekStudyClient({ledger,getKey:()=>{keys++;return `sk-${'x'.repeat(20)}`;},networkCheck,
    transport:async()=>{sends++;throw new Error('must not send');}});
  await assert.rejects(client.call({id:'offline',packet:c.packet}),{code:'NETWORK_PREFLIGHT_FAILED'});
  assert.equal(keys,0);assert.equal(sends,0);assert.equal(ledger.data.requests.length,0);assert.equal(ledger.data.halted,null);
});
test('预检的403、429和服务故障单独分类，不能被说成密钥错误或模型协议错误',async()=>{
  for(const [status,expected] of [[403,'public-endpoint-forbidden'],[429,'public-endpoint-rate-limited'],[503,'public-service-unavailable']]){
    const result=await probeStudyNetwork({lookup:async()=>({family:4}),transport:async()=>new Response(null,{status})});
    assert.equal(result.ok,false);assert.equal(result.classification,expected);assert.equal(result.modelRequestsSent,0);
  }
});
test('预检之后真正发送仍可能失败，原未知费用保护不被放宽',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());let calls=0;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>`sk-${'x'.repeat(20)}`,networkCheck:async()=>({ok:true}),transport:async()=>{
    calls++;const e=new Error('connection lost after dispatch');e.code='ECONNRESET';throw e;
  }});
  await assert.rejects(client.call({id:'after-preflight',packet:c.packet}),{code:'UNCERTAIN_REQUEST'});
  assert.equal(calls,1);assert.equal(ledger.data.requests[0].status,'uncertain');assert.ok(ledger.data.halted);
});
test('输出截断或JSON空白有用量也结算，但不伪装成功或自动重试',async t=>{
  const {ledger}=setup(t),c=buildCase({family:'idle',variant:'full'},'测试身份');t.after(()=>c.store.close());
  const client=new DeepSeekStudyClient({ledger,getKey:()=>`sk-${'x'.repeat(20)}`,transport:async()=>new Response(JSON.stringify({usage:validUsage,choices:[{finish_reason:'length',message:{content:'   '}}]}))});
  const r=await client.call({id:'short',packet:c.packet});assert.equal(r.complete,false);assert.equal(ledger.data.requests[0].status,'settled');
});
test('修订版模型输入不携带测试分组标签或预期输出；仅改变处境提示的对照保持其余数据',()=>{
  const cases=STUDY_CASES.map(s=>buildCase(s,'测试身份'));
  try{
    for(const c of cases){
      assert.equal(c.packet.payload.workspace.focus.id,'current-activity');
      assert.equal(c.packet.payload.workspace.focus.label,'当前活动');
      assert.equal(c.packet.payload.family,undefined);assert.equal(c.packet.payload.variant,undefined);assert.equal(c.packet.payload.expectedAnswer,undefined);
      assert.equal(JSON.stringify(c.packet.messages).includes('topic-switch'),false);
    }
    const a=buildCase({family:'topic-switch',variant:'minimal'},'测试身份'),b=buildCase({family:'topic-switch',variant:'minimal-neutral'},'测试身份');
    try{
      assert.deepEqual(a.packet.payload.current,b.packet.payload.current);assert.deepEqual(a.packet.payload.materials,b.packet.payload.materials);
      const aw=structuredClone(a.packet.payload.workspace),bw=structuredClone(b.packet.payload.workspace);delete aw.resume;delete bw.resume;
      assert.deepEqual(aw,bw);assert.notEqual(a.packet.payload.workspace.resume,b.packet.payload.workspace.resume);
    }finally{a.store.close();b.store.close();}
  }finally{cases.forEach(c=>c.store.close());}
});

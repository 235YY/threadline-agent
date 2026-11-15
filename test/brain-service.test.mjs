import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeInbound,outboundTarget} from '../tools/brain-service/adapters.mjs';
import {keepAttention} from '../src/attention.mjs';

const attention=()=>({...keepAttention()});
const respond=body=>({packetId:'',options:[{id:'r',kind:'respond',payload:{text:body}}],selected:'r',summary:'测试',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
function decide(packet){
  if(packet.stage==='reflection')return JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',
    summary:'反思',used:[],continuity:{changes:[],residency:{add:[],remove:[]},attention:attention()}});
  const out=respond('在的');out.packetId=packet.packetId;return JSON.stringify(out);
}

test('适配器：QQ 私聊/群聊与 MC 映射为场景；出站能回到原目标',t=>{
  assert.equal(normalizeInbound({source:'qq',key:'private:1',text:'在吗'}).scene,'qq/private/1');
  assert.equal(normalizeInbound({source:'qq',key:'group:9',text:'大家好'}).scene,'qq/group/9');
  assert.equal(normalizeInbound({source:'mc',key:'survival',text:'有人吗'}).scene,'mc/survival');
  assert.deepEqual(outboundTarget({scene:'qq/private/1',text:'x'}),{kind:'qq',key:'private:1'});
  assert.deepEqual(outboundTarget({scene:'mc/survival',text:'x'}),{kind:'mc',key:'survival'});
  assert.throws(()=>normalizeInbound({source:'qq',key:'bad',text:'x'}),{code:'ADAPTER'});
});

test('本机脑服务：健康检查、串行 turn、观察排队；不调模型',async t=>{
  let now=1000;
  const service=await startBrainService({token:'t',clock:()=>now,decide,rhythm:{minGapMs:1}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const call=async(path,body)=>{const r=await fetch(service.url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-brain-token':'t'},
    body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};};
  assert.equal((await call('/health')).json.ok,true);
  const a=await call('/v1/observe',{source:'qq',key:'private:1',text:'在吗'});
  assert.equal(a.json.queued,true);assert.equal(a.json.pending.length,1);
  const first=await call('/v1/turn',{});
  assert.equal(first.json.ok,true);assert.equal(first.json.scene,'qq/private/1');
  assert.equal(first.json.outbox[0].text,'在的');
  now+=10000;
  await call('/v1/observe',{source:'qq',key:'group:9',text:'大家好'});
  const second=await call('/v1/turn',{});
  assert.equal(second.json.scene,'qq/group/9');
  assert.equal((await call('/health')).json.active,null);
  const unauthorized=await fetch(service.url+'/health');assert.equal(unauthorized.status,401);
});

test('服务尊重沉默：没有出站文本，不补话',async t=>{
  let now=1000;
  const silentDecide=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'p',kind:'pause',payload:{}}],selected:'p',summary:'不想回',
    used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
  const service=await startBrainService({token:'t',clock:()=>now,decide:silentDecide,rhythm:{minGapMs:1}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const call=async(path,body)=>{const r=await fetch(service.url+path,{method:'POST',headers:{'content-type':'application/json','x-brain-token':'t'},
    body:JSON.stringify(body)});return r.json();};
  await call('/v1/observe',{source:'qq',key:'private:2',text:'不想回也没关系'});
  const result=await call('/v1/turn',{});
  assert.equal(result.silent,true);assert.deepEqual(result.outbox,[]);
});
test('/v1/reply 兼容旧桥：QQ/MC 文本进出，adapter 收到出站',async t=>{
  let now=1000;const sent=[];
  const service=await startBrainService({token:'t',clock:()=>now,decide,rhythm:{minGapMs:1},adapter:{send:async x=>{sent.push(x);return {delivered:true};}}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const call=async(body)=>{const r=await fetch(service.url+'/v1/reply',{method:'POST',headers:{'content-type':'application/json','x-brain-token':'t'},
    body:JSON.stringify({protocol:'jingyang-brain-bridge-v1',...body})});return r.json();};
  const qq=await call({key:'private:7',scene:'qq/private/7',message_id:1,messages:[{role:'user',content:'在吗'}]});
  assert.equal(qq.text,'在的');assert.equal(sent[0].scene,'qq/private/7');
  now+=10000;
  const qq2=await call({key:'private:7',scene:'qq/private/7',message_id:2,messages:[{role:'user',content:'再说一句'}]});
  assert.equal(qq2.text,'在的');assert.equal(sent[1].scene,'qq/private/7');
  now+=10000;
  const mc=await call({key:'survival',scene:'mc/survival',message_id:3,messages:[{role:'user',content:'有人吗'}]});
  assert.equal(mc.text,'在的');assert.equal(sent[2].scene,'mc/survival');
});
test('服务重启后保留待处理队列（同一 store/stateDirectory）',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'brain-service-state-'));
  t.after(()=>{try{rmSync(dir,{recursive:true,force:true});}catch{}});
  const storePath=join(dir,'subject.sqlite'),stateDirectory=join(dir,'state');
  const a=await startBrainService({storePath,stateDirectory,decide,rhythm:{minGapMs:1}});
  await a.observe({source:'qq',key:'private:3',text:'先存着'});
  await new Promise(r=>a.server.close(r));a.close();
  const b=await startBrainService({storePath,stateDirectory,decide,rhythm:{minGapMs:1}});
  t.after(async()=>{await new Promise(r=>b.server.close(r));b.close();});
  assert.equal(b.health().pending.length,1);
  const result=await b.turn({});
  assert.equal(result.scene,'qq/private/3');assert.equal(result.silent,false);
});
test('服务可以本地执行 relate：写绑定 + 回执',async t=>{
  const service=await startBrainService({token:'t',clock:()=>1000,decide,rhythm:{minGapMs:1}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  await service.observe({source:'qq',key:'private:8',text:'记一下关系'});
  const store=service.store,ws=store.read('ws:qq/private/8');
  const entity=(id,name)=>store.execute({requestId:`e:${id}`,commands:[{op:'write_entity',id,expectedRevision:0,kind:'person',name,aliases:[],description:''}]}).at(-1);
  const a=entity('e:a','劳大'),b=entity('e:b','直升机');
  const action=store.execute({requestId:'a:bind',commands:[{op:'propose_action',id:'a:bind',workspace:{id:ws.id,revision:ws.revision},
    tool:'remember-binding',args:{from:{id:a.id,revision:a.revision},to:{id:b.id,revision:b.revision},relation:'associated-with',label:'梗'},inputRefs:[]}]}).at(-1);
  service.executeAction({id:action.id,revision:action.revision});
  assert.equal(store.read('a:bind:binding').status,'active');
  assert.equal(store.read('a:bind').status,'succeeded');
});
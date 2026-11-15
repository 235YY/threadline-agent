import test from 'node:test';
import assert from 'node:assert/strict';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {affectTurnId,motivationId} from '../src/affect-contract.mjs';
import {canonical} from '../src/contracts.mjs';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {digest} from '../src/contracts.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,put,event,frame,ref} from './helpers.mjs';

// A synthetic deterministic worker tests the host boundary, not Limbic's psychology or equations.
const T=1794400000000,clone=x=>JSON.parse(JSON.stringify(x));
function initial(){return {format:'jingyang-affect-shadow-v1',upstream:'2132fa81b20134f469fd7adeb8e38fa20dd32071',revision:0,wallAt:T,mode:'online',
  config:{timezoneMinutes:480,parameters:{},offlinePolicy:'freeze-lived-time',aggregation:'weighted-counterfactual-v1'},requests:{},sources:{},
  engineState:{drives:{social:.2,novelty:.2,competence:.2,recognition:.2,fatigue:.2,sleepiness:.2,libido:0,intimacy:0},mood:{p:0,a:0,d:0},baseline:{p:0,a:0,d:0},intents:[],sexuality:{},emotions:{}}};}
async function worker(x){
  if(x.action==='initialize')return {state:initial()};
  const s=clone(x.state),op=x.operation;s.revision++;s.wallAt=op.nowMs;
  if(op.source)s.sources[canonical(op.source)]={fixture:true};
  return {state:s,receipt:{operationId:op.id}};
}
function setup(t){
  const {store}=memory(t);const [e,w]=put(store,'seed',event('e'),frame());
  const session=new AffectSession({store,subjectId:'p',worker,clock:()=>T});
  const args={currentEvent:ref(e),workspace:ref(w),now:T,budgetBytes:131072,mind:true,localLookupPolicy:{maxReads:2,maxHits:4}};
  return {store,session,args,e,w};
}
const output=p=>({packetId:p.packetId,options:[{id:'keep',kind:'wait',payload:{}}],selected:'keep',summary:'合成输出，仅检验提交边界',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
const commitArgs=(p,o)=>({packet:p,output:o,requestId:'commit',decisionId:'d'});

test('情感调用确认未发送时，保留原错误和未发送事实，不被状态机错误掩盖',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),err=Object.assign(Error('no send'),{code:'SPEND_LIMIT',transportInvoked:false});
  await assert.rejects(s.session.invoke(p,()=>{throw err;}),e=>e===err);
  const turn=s.store.read(affectTurnId(p));
  assert.equal(turn.status,'failed');assert.equal(turn.transportInvoked,false);assert.equal(turn.error,'SPEND_LIMIT');
  await assert.rejects(s.session.prepare({...s.args,now:T+1}),e=>e.code==='AFFECT_TURN_STOPPED');
});

test('错误名称不能代替发送证据：未确认的预算错误仍保留 uncertain',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),err=Object.assign(Error('unknown'),{code:'BUDGET_EXPIRED'});
  await assert.rejects(s.session.invoke(p,()=>{throw err;}),e=>e===err);
  assert.equal(s.store.read(affectTurnId(p)).status,'uncertain');
});

test('已捕获但不合法的输出不会在下一次 prepare 中被自动忽略',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),raw=await s.session.invoke(p,()=>'{');
  await assert.rejects(s.session.commit(commitArgs(p,raw)),e=>e.code==='OUTPUT_JSON');
  const [other]=put(s.store,'other',event('other'));
  await assert.rejects(s.session.prepare({...s.args,currentEvent:ref(other)}),e=>e.code==='AFFECT_TURN_STOPPED');
  assert.equal(s.store.read('d'),null);
});

test('相同已提交情感提案可以恢复返回，不重算也不产生第二次状态更新',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),raw=await s.session.invoke(p,()=>output(p));
  const args=commitArgs(p,raw),d=await s.session.commit(args),before=s.store.read(motivationId('p'));
  s.session.worker=()=>{throw Error('must not recompute');};
  assert.deepEqual(await s.session.commit(args),d);
  assert.deepEqual(s.store.read(motivationId('p')),before);
  await assert.rejects(s.session.commit({...args,requestId:'other-request'}),e=>e.code==='AFFECT_COMMIT_MISMATCH');
});

test('调用前校验输入与已保存 packet 一致，拒绝持原编号改正文',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),changed=clone(p);changed.payload.current.body='悄悄换了内容';let calls=0;
  await assert.rejects(s.session.invoke(changed,()=>{calls++;return output(changed);}),e=>e.code==='AFFECT_PACKET_CHANGED');
  assert.equal(calls,0);assert.equal(s.store.read(affectTurnId(p)).status,'prepared');
});

test('Worker 返回错误时间时，不能提交状态；保留 captured 以便离线重算',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),raw=await s.session.invoke(p,()=>output(p)),before=s.store.read(motivationId('p'));
  s.session.worker=async x=>{const r=await worker(x);r.state.wallAt++;return r;};
  await assert.rejects(s.session.commit(commitArgs(p,raw)),e=>e.code==='AFFECT_WORKER_BINDING'||e.code==='AFFECT_BINDING');
  assert.equal(s.store.read(affectTurnId(p)).status,'captured');assert.deepEqual(s.store.read(motivationId('p')),before);
  s.session.worker=worker;await s.session.commit(commitArgs(p,raw));
});

test('Worker 返回不同配置时，不允许随认知决定静默改变情感参数',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),raw=await s.session.invoke(p,()=>output(p));
  s.session.worker=async x=>{const r=await worker(x);r.state.config.parameters={changed:true};return r;};
  await assert.rejects(s.session.commit(commitArgs(p,raw)),e=>e.code==='AFFECT_WORKER_BINDING'||e.code==='AFFECT_BINDING');
  assert.equal(s.store.read('d'),null);assert.equal(s.store.read(affectTurnId(p)).status,'captured');
});

test('已准备的旧输入在发送前发现主体变化，不再白花一次调用',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args);
  put(s.store,'new-attention',{op:'initialize_attention',subjectId:'p'});
  // Advance the subject through another legitimate core decision.
  const q=s.session.core.prepare(s.args);s.session.core.commit({...commitArgs(q,output(q)),requestId:'other',decisionId:'other'});
  let calls=0;await assert.rejects(s.session.invoke(p,()=>{calls++;return output(p);}),e=>e.code==='STALE_SUBJECT');assert.equal(calls,0);
});

test('恢复的工具 started/uncertain 记录在任何新决定前阻断，不仅阻止相同操作键',async()=>{
  for(const status of ['started','uncertain']){
    let calls=0;const runtime=new AgentRuntime({tools:{side:()=>{calls++;}},now:()=>1000});
    const task=runtime.createTask({goal:'resume',metadata:{allowedTools:['side']}});task.toolOps={old:{status,at:100}};
    const restored=runtime.restore(task),r=await runtime.executeDecision(restored,{decisionRef:{id:'new',revision:1},kind:'tool',tool:'side',args:{}});
    assert.equal(r.error,'TOOL_OUTCOME_UNKNOWN');assert.equal(restored.status,'blocked');assert.equal(calls,0);
    restored.status='paused';assert.equal(runtime.resume(restored),false);
  }
});

async function service(t){const s=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide:()=>{throw Error('no model opportunity allowed');},agentTools:{side:()=>{throw Error('must not execute');}}});
  t.after(async()=>{await new Promise(r=>s.server.close(r));s.close();});return s;}
test('宿主在调用模型前识别未确认工具；恢复、改计划不能跳过未知结果',async t=>{
  const s=await service(t),created=await s.createAgentTask({goal:'recovered task',metadata:{allowedTools:['side']}}),task=s.store.read(created.id);
  task.toolOps={previous:{status:'started',at:1}};
  put(s.store,'inject-recovered',{op:'put_agent_task',task,expectedRevision:task.revision});
  const step=await s.stepAgentTask(task.id);assert.equal(step.error,'TOOL_OUTCOME_UNKNOWN');
  const blocked=s.store.read(task.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.callCount,0);
  assert.equal((await s.resumeAgentTask(task.id,{message:'继续'})).error,'TOOL_OUTCOME_UNKNOWN');
  assert.equal((await s.redirectAgentTask(task.id,{goal:'换计划'})).error,'TOOL_OUTCOME_UNKNOWN');
  assert.equal(s.store.read(task.id).goal,created.goal);
});

test('记录调用失败的写盘再次失败时，不掩盖原始异常，不重新调用',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),execute=s.store.execute.bind(s.store),original=Object.assign(Error('unknown remote outcome'),{code:'UNCERTAIN_REQUEST'});let writes=0;
  s.store.execute=args=>{if(args.requestId.startsWith('affect-uncertain:')){writes++;throw Object.assign(Error('disk'),{code:'EIO'});}return execute(args);};
  await assert.rejects(s.session.invoke(p,()=>{throw original;}),e=>e===original&&e.affectFailureRecording==='failed'&&e.affectFailureError==='EIO');
  assert.equal(writes,1);assert.equal(s.store.read(affectTurnId(p)).status,'dispatched');
  await assert.rejects(s.session.prepare(s.args),e=>e.code==='AFFECT_TURN_STOPPED');
});

test('未发送与输出被拒绝均需显式关闭；新材料可继续，原来源不重发',async t=>{
  for(const unsent of [true,false]){
    const s=setup(t),p=await s.session.prepare(s.args);
    if(unsent)await assert.rejects(s.session.invoke(p,()=>{throw Object.assign(Error('no send'),{code:'SPEND_LIMIT',transportInvoked:false});}));
    else{const raw=await s.session.invoke(p,()=>'{');await assert.rejects(s.session.commit(commitArgs(p,raw)));}
    const turn=s.store.read(affectTurnId(p)),base={op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'closed-incomplete'};
    assert.throws(()=>put(s.store,'no-evidence',base),e=>e.code==='AFFECT_RESOLUTION');
    const resolution=unsent?{reason:'SPEND_LIMIT',requestId:null,noProviderCall:true}:{reason:'OUTPUT_REJECTED',outputHash:digest(turn.rawOutput),requestId:'turn:'+p.packetId,ledgerStatus:'settled',actualMicros:0,evidenceHash:'a'.repeat(64)};
    // The synthetic host attests to a temporary synthetic ledger; no actual accounting is written here.
    put(s.store,'reviewed-close',{...base,resolution});
    await assert.rejects(s.session.prepare(s.args),e=>e.code==='AFFECT_SOURCE_STOPPED');
    const [next]=put(s.store,'new-event',event('new-event'));
    assert.ok(await s.session.prepare({...s.args,currentEvent:ref(next)}));
    assert.equal(s.store.read('d'),null);
  }
});

test('核心原子提交拒绝错绑的情感候选或缺失捕获记录，业务状态不变',async t=>{
  const s=setup(t),p=await s.session.prepare(s.args),raw=await s.session.invoke(p,()=>output(p));
  const commit=s.session.core.commit.bind(s.session.core);let candidate;
  s.session.core.commit=args=>{candidate=args;return null;};
  await s.session.commit(commitArgs(p,raw));s.session.core.commit=commit;
  const before=s.store.read(motivationId('p'));
  const variants=[a=>{a.affectTurn=null;},a=>{a.motivationTransition.packetId='other';},a=>{a.motivationTransition.baseHash='changed';},a=>{a.motivationTransition.previewHash='changed';},a=>{a.motivationTransition.subject='someone-else';},a=>{a.motivationTransition=null;}];
  for(let i=0;i<variants.length;i++){
    const a=clone(candidate);a.requestId=`rejected-${i}`;a.decisionId=`rejected-${i}`;variants[i](a);
    assert.throws(()=>commit(a),e=>['AFFECT_TURN','AFFECT_BINDING'].includes(e.code));
    assert.equal(s.store.read(a.decisionId),null);assert.deepEqual(s.store.read(motivationId('p')),before);
    assert.equal(s.store.read(affectTurnId(p)).status,'captured');
  }
});

test('Worker 预览版本错绑在调用模型之前被拒绝',async t=>{
  const s=setup(t);s.session.worker=async x=>{const r=await worker(x);if(x.operation?.kind==='advance')r.state.revision+=10;return r;};
  await assert.rejects(s.session.prepare(s.args),e=>e.code==='AFFECT_WORKER_BINDING');
  assert.equal([...s.store.all('affect_turn')].length,0);
});

test('接续回放没有再次进入模型回调时，不重复增加调用统计',async t=>{
  const {store}=memory(t),[w]=put(store,'w',frame());let callbacks=0;
  const driver=new TurnDriver({store,subjectId:'replay',workspace:ref(w),decide:()=>{callbacks++;throw Error('replay must not call');},sessionFactory:args=>{
    const session=new ContinuitySession({...args});session.invoke=p=>{
      const o=output(p);if(p.stage==='reflection'){delete o.continuity.expressionChoice;delete o.continuity.observationDisposition;}return JSON.stringify(o);
    };return session;
  }});
  driver.ingest({key:'new',body:'合成消息',at:T});await driver.tick({now:T,localHour:12,eventBypass:true});
  await driver.tick({now:T+2000000,localHour:12,idleReflection:true});
  assert.equal(callbacks,0);assert.equal(driver.state.callsToday,0);
});

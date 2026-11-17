import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {keepAttention} from '../src/attention.mjs';
import {digest} from '../src/contracts.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {processMatches} from '../tools/ops/owned-process.mjs';
import {archiveDeadInstance,stopOwned} from '../tools/ops/stop-owned.mjs';
import {deliverClaimedResponse,deliverClaimedAction} from '../tools/qq-connect/delivery.mjs';
import {AffectSession,affectFactory} from '../tools/affect-integrated/session.mjs';
import {callWorker} from '../tools/affect-shadow/bridge.mjs';
import {DailyBudgetLedger} from '../src/model-transport.mjs';
import {auditBudgets} from '../tools/ops/budget-audit.mjs';
import {createHash} from 'node:crypto';
import {activityWrite,readActivity} from '../src/turn-activity.mjs';

const T=1794400000000,pin=r=>({id:r.id,revision:r.revision});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function output(p,kind='wait',payload={},changes=[]){return {packetId:p.packetId,options:[{id:'x',kind,payload}],selected:'x',summary:'隔离工程回放',used:[],continuity:{changes,residency:{add:[],remove:[]},attention:keepAttention(),...(p.stage==='reflection'?{}:{expressionChoice:null,observationDisposition:'handled'})}};}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'jingyang-release-')),stores=[],services=[];
  t.after(async()=>{for(const s of services){try{if(s.server.listening)await new Promise(r=>s.server.close(r));s.close();}catch{}}for(const s of stores)try{s.close();}catch{}assert.equal(dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});});
  const open=()=>{const s=new ContinuityStore(join(dir,'subject.sqlite'),{clock:()=>T});stores.push(s);return s;};
  return {dir,open,services,stores};
}
async function service(t,extra={}){const f=fixture(t),s=await startBrainService({port:0,storePath:join(f.dir,'subject.sqlite'),heartbeatMs:0,global:true,subjectTask:true,clock:()=>T,...extra});f.services.push(s);return {s,...f};}
const input=id=>({protocol:'jingyang-brain-bridge-v1',source:'fixture',key:'p',scene:'qq/private/1',message_id:id,messages:[{role:'user',content:'合成任务 '+id}]});

test('宿主发消息前已有 claim，成功回执保存，同一 outbox 不重复发送',async t=>{
  let sent=0,s;
  ({s}=await service(t,{decide:p=>output(p,'respond',{text:'合成回复'}),adapter:{send:async()=>{sent++;assert.equal([...s.store.all('response')][0].status,'dispatching');return {delivered:true};}}}));
  const r=await s.reply(input('one'));assert.equal(sent,1);assert.equal([...s.store.all('response')][0].status,'sent');
  await s.dispatch(r.outbox,{scene:'qq/private/1',execute:true});assert.equal(sent,1);
});

test('连接器发送握手：先 claim 再外部调用，缺回执时不重发',async t=>{
  const {s}=await service(t,{decide:p=>output(p,'respond',{text:'合成回复'})});
  const r=await s.reply({...input('connector'),execute:false}),item=r.outbox[0];let sends=0;
  const request=async(path,body)=>{if(path.endsWith('/claim'))return s.responseClaim(body);throw Object.assign(Error('ack lost'),{code:'EIO'});};
  await assert.rejects(deliverClaimedResponse(item,{request,send:async()=>{sends++;assert.equal(s.store.read(item.response.id).status,'dispatching');}}));
  await assert.rejects(deliverClaimedResponse(item,{request,send:async()=>{sends++;}}));
  assert.equal(sends,1);assert.equal(s.pendingEffects().responses[0].status,'dispatching');
});

test('发送抛错保留 unknown，后续不因没有成功回执而重发',async t=>{
  let sends=0;const {s}=await service(t,{decide:p=>output(p,'respond',{text:'合成回复'}),adapter:{send:async()=>{sends++;throw Error('unknown remote result');}}});
  const r=await s.reply(input('unknown'));assert.equal(s.store.read(r.outbox[0].response.id).status,'unknown');
  await s.dispatch(r.outbox,{scene:'qq/private/1',execute:true});assert.equal(sends,1);
});

test('连接器外部工具使用同一套 claim，重复回传不重复执行',async t=>{
  const {s}=await service(t,{allowedActionTools:['probe'],decide:p=>output(p,'act',{tool:'probe',args:{}})}),r=await s.reply({...input('action'),execute:false}),item=r.outbox[0];let calls=0;
  const request=async(path,body)=>path.endsWith('/claim')?s.actionClaim(body):s.receipt(body);
  await deliverClaimedAction(item,{request,scene:r.scene,eventId:'receipt:'+item.action.id,execute:()=>{calls++;assert.equal(s.store.read(item.action.id).status,'dispatching');return {value:1};}});
  await assert.rejects(deliverClaimedAction(item,{request,scene:r.scene,eventId:'receipt2',execute:()=>{calls++;}}));
  assert.equal(calls,1);assert.equal(s.store.read(item.action.id).status,'succeeded');
});

function driverSetup(t,sessionFactory=null){
  const f=fixture(t),store=f.open();store.execute({requestId:'w',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'qq/private/1',focus:{id:'now',label:'合成'}}]});
  let calls=0;const make=()=>new TurnDriver({store,subjectId:'p',workspace:{id:'w',revision:1},sessionFactory,decide:p=>{calls++;return output(p);}});
  return {...f,store,make,calls:()=>calls};
}
test('反思 captured 在新时间与新 Driver 下恢复提交，不再次调用模型',async t=>{
  let fail=true;const f=driverSetup(t,args=>{const s=new ContinuitySession(args),commit=s.commit.bind(s);s.commit=a=>{if(fail){fail=false;throw Object.assign(Error('disk'),{code:'EIO'});}return commit(a);};return s;});
  const d=f.make();await d.tick({now:T,localHour:12});await assert.rejects(d.tick({now:T+2000000,localHour:12,idleReflection:true}));
  const next=f.make(),r=await next.tick({now:T+9000000,localHour:12});
  assert.equal(r.action,'reflected');assert.equal(f.calls(),1);assert.equal([...f.store.all('event')].length,0);
});

test('提交后回传前崩溃，接续返回同一决定，不重复状态提交',async t=>{
  const f=driverSetup(t),d=f.make(),execute=f.store.execute.bind(f.store);let fail=true;
  f.store.execute=a=>{if(fail&&a.commands[0]?.stateType==='turn-activity'&&a.commands[0].value.phase==='complete'){fail=false;throw Object.assign(Error('after commit'),{code:'EIO'});}return execute(a);};
  d.ingest({key:'one',body:'合成事件',at:T});await assert.rejects(d.tick({now:T,localHour:12,eventBypass:true}));
  const before=[...f.store.all('decision')].map(pin),r=await f.make().tick({now:T+1000,localHour:12,eventBypass:true});
  assert.deepEqual([...f.store.all('decision')].map(pin),before);assert.equal(r.decision.id,before[0].id);assert.equal(f.calls(),1);
});

test('plain 调用发送结果未知时，即使更换 Driver 也阻断重发',async t=>{
  const f=driverSetup(t);let calls=0;const make=()=>new TurnDriver({store:f.store,subjectId:'p',workspace:{id:'w',revision:1},decide:()=>{calls++;throw Error('timeout');}}),d=make();
  d.ingest({key:'e',body:'合成事件',at:T});await assert.rejects(d.tick({now:T,localHour:12,eventBypass:true}));
  await assert.rejects(make().tick({now:T+10000,localHour:12,eventBypass:true}),e=>e.code==='TURN_OUTCOME_UNKNOWN');assert.equal(calls,1);
});

test('recovery-002 UNKNOWN survives restart, isolates only its source and accepts explicit fixed verification',async t=>{
 const f=driverSetup(t);let store=f.store;const calls=[];
 const make=()=>new TurnDriver({store,subjectId:'p',workspace:{id:'w',revision:1},decide:p=>{
  calls.push(p.payload.current.id);if(p.payload.current.id==='obs:unknown')throw Error('synthetic uncertain execution');return output(p);
 }});
 let d=make();d.ingest({key:'unknown',body:'synthetic unknown operation',at:T});
 await assert.rejects(d.tick({now:T,localHour:12,eventBypass:true}));
 const unknown=readActivity(store,'p',{id:'w'});assert.equal(unknown.value.phase,'dispatched');assert.equal(unknown.value.failure.outcome,'uncertain');
 const fixed=pin(unknown),packetId=unknown.value.packet.packetId;store.close();store=f.open();d=make();
 await assert.rejects(d.tick({now:T+1,localHour:12,eventBypass:true}),{code:'TURN_OUTCOME_UNKNOWN'});assert.deepEqual(calls,['obs:unknown']);
 d.ingest({key:'unrelated',body:'synthetic independent work',at:T+2});
 assert.equal((await d.tick({now:T+2,localHour:12,eventBypass:true})).action,'decided');assert.deepEqual(calls,['obs:unknown','obs:unrelated']);
 assert.equal(store.read(fixed.id,fixed.revision).value.phase,'dispatched');
 assert.throws(()=>d.resolveUnknown({activity:fixed,evidence:{id:'missing',revision:1},outcome:'succeeded'}),{code:'TURN_RESOLUTION'});
 const event=store.execute({requestId:'explicit-verification',commands:[{op:'append_event',id:'verified',body:JSON.stringify({packetId,outcome:'succeeded',summary:'host checked the original operation'}),scene:'synthetic',actor:'host',origin:'reported',occurredAt:T+3,source:{system:'host-verification',key:packetId}}]})[0];
 const current=pin(readActivity(store,'p',{id:'w'})),resolved=d.resolveUnknown({activity:fixed,evidence:pin(event),outcome:'succeeded'});
 assert.deepEqual(resolved.value.resolution.evidence,pin(event));assert.deepEqual(pin(readActivity(store,'p',{id:'w'})),current);
 assert.deepEqual(d.resolveUnknown({activity:fixed,evidence:pin(event),outcome:'succeeded'}),resolved);
 assert.throws(()=>d.resolveUnknown({activity:fixed,evidence:pin(event),outcome:'failed'}),{code:'TURN_RESOLUTION'});
 await d.tick({now:T+4,localHour:12,eventBypass:true});assert.deepEqual(calls,['obs:unknown','obs:unrelated']);
});

test('recovery-002 known unsent FAILED is distinct from UNKNOWN and new sources still succeed',async t=>{
 const f=driverSetup(t),calls=[];
 const d=new TurnDriver({store:f.store,subjectId:'p',workspace:{id:'w',revision:1},decide:p=>{calls.push(p.payload.current.id);if(calls.length===1)throw Object.assign(Error('preflight rejected'),{code:'NETWORK_PREFLIGHT_FAILED',transportInvoked:false});return output(p);}});
 d.ingest({key:'unsent',body:'synthetic',at:T});await assert.rejects(d.tick({now:T,localHour:12,eventBypass:true}),{code:'NETWORK_PREFLIGHT_FAILED'});
 const journal=readActivity(f.store,'p',{id:'w'});assert.equal(journal.value.failure.outcome,'not-executed');assert.equal(journal.value.phase,'prepared');
 const feedback=[...f.store.all('extension_record')].find(r=>r.stateType==='operation-feedback'&&r.value.packetId===journal.value.packet.packetId);
 assert.equal(feedback.value.execution,'not-started');assert.equal(feedback.value.accounting,'not-dispatched');
 d.ingest({key:'fresh',body:'synthetic fresh',at:T+1});assert.equal((await d.tick({now:T+1,localHour:12,eventBypass:true})).action,'decided');
 assert.deepEqual(calls,['obs:unsent','obs:fresh']);assert.equal([...f.store.all('decision')].length,1);
});

test('recovery-002 legacy complete marker with UNKNOWN evidence cannot resurrect its source',async t=>{
 const f=driverSetup(t),d=f.make(),event=d.ingest({key:'legacy',body:'synthetic legacy unknown',at:T});
 const session=new ContinuitySession({store:f.store,subjectId:'p',attention:true,maxForeground:16}),packet=session.prepare({workspace:{id:'w',revision:1},currentEvent:event,budgetBytes:131072});
 f.store.execute({requestId:'legacy-evidence',commands:[activityWrite(null,{subject:'p',workspace:{id:'w',revision:1},value:{phase:'complete',context:{kind:'decision',now:T,reason:'event',observation:f.store.subjectObservation('p',event.id)},packet,failure:{code:'MODEL_ERROR',outcome:'uncertain',reason:'old interrupted invocation'}}})]});
 await assert.rejects(d.tick({now:T+1,localHour:12,eventBypass:true}),{code:'TURN_OUTCOME_UNKNOWN'});
 assert.equal(f.calls(),0);assert.equal(readActivity(f.store,'p',{id:'w'}).value.phase,'dispatched');
 d.ingest({key:'new-after-legacy',body:'synthetic independent',at:T+2});await d.tick({now:T+2,localHour:12,eventBypass:true});assert.equal(f.calls(),1);
});

test('重启恢复超过一页的积压，不丢第 101 条之后的事件',async t=>{
  const f=await service(t,{decide:p=>output(p)});for(let i=0;i<251;i++)f.s.observe({source:'fixture',key:'k',sourceKey:'bulk-'+i,scene:'qq/private/1',text:'合成 '+i});
  await new Promise(r=>f.s.server.close(r));f.s.close();
  const restored=await startBrainService({port:0,storePath:join(f.dir,'subject.sqlite'),heartbeatMs:0,global:true});f.services.push(restored);
  assert.equal(restored.health().pending.reduce((n,r)=>n+r.count,0),251);
});

test('工具超时后仍跟踪物理执行，迟到回执保留且不重跑工具',async()=>{
  const release=deferred(),late=deferred(),observations=[];let calls=0;
  const runtime=new AgentRuntime({tools:{probe:()=>{calls++;return release.promise;}},onObservation:(_,o)=>{observations.push(o);if(o.late)late.resolve();}}),task=runtime.createTask({goal:'late',metadata:{allowedTools:['probe']},budget:{toolTimeoutMs:5}});
  await runtime.executeDecision(task,{decisionRef:{id:'d',revision:1},kind:'tool',tool:'probe',args:{}});
  assert.equal(task.blockedReason,'TOOL_OUTCOME_UNKNOWN');assert.equal(runtime.pendingExecutions(),1);
  release.resolve({actual:'done'});await late.promise;await new Promise(r=>setImmediate(r));
  assert.equal(runtime.pendingExecutions(),0);assert.equal(calls,1);assert.equal(task.stepCount,1);assert.equal(observations.length,2);assert.equal(observations[1].result.actual,'done');
  assert.equal(Object.values(task.toolOps)[0].status,'succeeded');
});

test('已提交的最后一次任务决定可在预算耗尽后恢复执行，模型不再调用',async t=>{
  const {s}=await service(t,{decide:()=>{throw Error('must recover committed decision');}}),task=await s.createAgentTask({goal:'finish',budget:{maxCalls:1}});
  const core=new ContinuitySession({store:s.store,subjectId:'jingyang',attention:true,maxForeground:16});
  s.store.execute({requestId:'e',commands:[{op:'append_event',id:'e',body:'合成任务事件',scene:'agent/task',actor:'fixture',origin:'reported',source:{system:'fixture',key:'e'},occurredAt:T}]});
  s.store.execute({requestId:'workspace',commands:[{op:'set_workspace',id:'ws:global',expectedRevision:0,scene:'global',focus:{id:'now',label:'合成'}}]});
  const p=core.prepare({currentEvent:{id:'e',revision:1},workspace:{id:'ws:global',revision:1},task:{id:task.id,stepCount:0,controlRevision:0,interruptCursor:0,interrupts:[]},budgetBytes:131072,allowedActionTools:['task_finish']});
  core.commit({packet:p,output:output(p,'act',{tool:'task_finish',args:{result:'recovered'}}),decisionId:'saved-decision',requestId:'saved',allowedActionTools:['task_finish']});
  const current=s.store.read(task.id);current.callCount=1;s.store.execute({requestId:'counter',commands:[{op:'put_agent_task',task:current,expectedRevision:current.revision}]});
  const r=await s.stepAgentTask(task.id);assert.equal(r.status,'done');assert.equal(s.store.read(task.id).callCount,1);
});

test('旧模型结果在主机暂停后不得写入认识或触发工具',async t=>{
  const entered=deferred(),release=deferred();const {s}=await service(t,{decide:async p=>{entered.resolve();await release.promise;return output(p,'act',{tool:'task_finish',args:{result:'old'}},[{id:'stale-thought',expectedRevision:0,kind:'feeling',nature:'self-report',body:'不应提交'}]);}}),task=await s.createAgentTask({goal:'pause'});
  const running=s.stepAgentTask(task.id);await entered.promise;await s.pauseAgentTask(task.id,'new control');release.resolve();await running;
  assert.equal(s.store.read('stale-thought'),null);assert.equal(s.store.read(task.id).status,'paused');
});

test('工具核对需要精确版本与证据，核对后仍需明确恢复',async t=>{
  const {s}=await service(t),task=await s.createAgentTask({goal:'unknown'}),current=s.store.read(task.id);
  current.status='blocked';current.toolOps={old:{status:'uncertain',operationId:'op'}};
  s.store.execute({requestId:'pending',commands:[{op:'put_agent_task',task:current,expectedRevision:current.revision}]});
  const review={format:'jingyang-tool-outcome-review-v1',taskId:task.id,operationId:'op',outcome:'succeeded',result:{checked:true},evidence:{locator:'synthetic receipt',sha256:'a'.repeat(64)}};
  assert.throws(()=>s.reconcileAgentTool(task.id,{expectedRevision:0,review,reviewHash:digest(review)}),e=>e.code==='AGENT_TASK_CONFLICT');
  const input={expectedRevision:s.store.read(task.id).revision,review,reviewHash:digest(review)};
  assert.equal(s.reconcileAgentTool(task.id,input).resumeRequired,true);assert.equal(s.store.read(task.id).status,'blocked');assert.equal(s.reconcileAgentTool(task.id,input).replayed,true);
  assert.equal((await s.resumeAgentTask(task.id,{})).ok,true);
});

test('进程匹配同时检查 PID、出生时间、可执行文件和精确入口',()=>{
  const entry=resolve('tools/brain-service/run.mjs'),record={pid:42,createdAt:'birth',entry,executable:process.execPath},current={pid:42,createdAt:'birth',executable:process.execPath,commandLine:`"${process.execPath}" "${entry}"`};
  assert.equal(processMatches(record,current),true);assert.equal(processMatches(record,{...current,createdAt:'reused'}),false);assert.equal(processMatches(record,{...current,commandLine:current.commandLine+'-other'}),false);
});

test('陈旧实例只在 PID 确认不存在时显式归档，原证据保持原字节',t=>{
  const {dir}=fixture(t),text=JSON.stringify({pid:42,instanceId:'old'});writeFileSync(join(dir,'brain.launch.lock'),text);
  assert.throws(()=>archiveDeadInstance(dir,{inspect:()=>({pid:42})}),e=>e.code==='INSTANCE_RUNNING');assert.equal(readFileSync(join(dir,'brain.launch.lock'),'utf8'),text);
  const r=archiveDeadInstance(dir,{inspect:()=>null});assert.equal(r.archived,1);assert.equal(readFileSync(join(r.evidenceDirectory,'brain.launch.lock'),'utf8'),text);
});

test('停止进程时 PID 被复用，强制选项也不能杀错进程',async()=>{
  let kills=0;const record={pid:42,createdAt:'old',entry:resolve('brain.mjs'),executable:process.execPath};
  await assert.rejects(stopOwned(record,{force:true,inspect:()=>({pid:42,createdAt:'new',executable:process.execPath,commandLine:record.entry}),kill:()=>kills++}),e=>e.code==='PROCESS_IDENTITY_CHANGED');assert.equal(kills,0);
});

test('150 个连续工程回合：查询接续、真实本地重开、发送异常均不重复发送',async t=>{
  const f=fixture(t);let s,models=0,sends=0,unknown=0;
  const decide=p=>{models++;if(p.payload.current.body.includes('查阅')&&!p.payload.information)return output(p,'lookup',{terms:['工程种子']});return output(p,'respond',{text:'合成工程回合已处理'});};
  const open=async()=>{const instance=await startBrainService({port:0,storePath:join(f.dir,'subject.sqlite'),stateDirectory:join(f.dir,'state'),styleDirectory:join(f.dir,'style'),heartbeatMs:0,global:true,rhythm:{dailyCallCap:500},decide,adapter:{send:async()=>{sends++;if(sends%17===0){unknown++;throw Error('controlled unknown delivery');}return {delivered:true};}}});f.services.push(instance);return instance;};
  s=await open();s.store.execute({requestId:'seed',commands:[{op:'write_note',id:'seed',expectedRevision:0,kind:'interpretation',change:'self_report',evidence:[],body:'工程种子，仅为回放夹具'}]});
  for(let i=0;i<150;i++){
    if(i>0&&i%15===0){await new Promise(r=>s.server.close(r));s.close();s=await open();}
    const r=await s.reply({...input('soak-'+i),messages:[{role:'user',content:i%5===0?'查阅工程种子':'普通工程回合 '+i}]});
    assert.equal(r.ok,true);assert.equal(r.outbox.filter(o=>o.kind==='respond').length,1);
    await s.dispatch(r.outbox,{scene:r.scene,execute:true});
  }
  assert.equal(models,180);assert.equal(sends,150);
  assert.equal([...s.store.all('decision')].length,180);
  assert.equal([...s.store.all('response')].length,150);
  assert.equal([...s.store.all('response')].filter(r=>r.status==='unknown').length,unknown);
  assert.equal(s.pendingEffects().responses.filter(r=>r.status==='pending').length,0);
  assert.deepEqual(s.store.integrity(),{database:'ok',foreignKeyViolations:0,missingHeads:0});
});

test('真实本地情感 Worker 故障后，最后一次已捕获任务输出可在零剩余调用下接续',async t=>{
  let broken=true,calls=0;const worker=async x=>{if(broken&&x.operation?.kind==='experience'){broken=false;throw Object.assign(Error('worker down'),{code:'WORKER_EXIT'});}return callWorker(x);};
  const {s}=await service(t,{sessionFactory:affectFactory({fusion:true,worker}),decide:p=>{calls++;return output(p,'act',{tool:'task_finish',args:{result:'recovered offline'}});}}),task=await s.createAgentTask({goal:'native capture',budget:{maxCalls:1}});
  await s.stepAgentTask(task.id);assert.equal(s.store.read(task.id).status,'blocked');assert.equal([...s.store.all('affect_turn')][0].status,'captured');
  await s.resumeAgentTask(task.id,{});const done=await s.stepAgentTask(task.id);
  assert.equal(done.status,'done');assert.equal(calls,1);assert.equal(s.store.read(task.id).callCount,1);
});

test('情感 Worker 计算期间的暂停与 superseded 记录原子保存，旧认识不能落库',async t=>{
  const entered=deferred(),release=deferred();let first=true;
  const worker=async x=>{if(first&&x.operation?.kind==='experience'){first=false;entered.resolve();await release.promise;}return callWorker(x);};
  const {s}=await service(t,{sessionFactory:affectFactory({fusion:true,worker}),decide:p=>output(p,'act',{tool:'task_finish',args:{result:'old'}},[{id:'native-stale',expectedRevision:0,kind:'feeling',body:'不应保存',nature:'self-report'}])}),task=await s.createAgentTask({goal:'native pause'});
  const step=s.stepAgentTask(task.id);await entered.promise;await s.pauseAgentTask(task.id,'explicit pause');release.resolve();await step;
  assert.equal(s.store.read('native-stale'),null);assert.equal(s.store.read(task.id).status,'paused');
  assert.equal([...s.store.all('affect_turn')][0].status,'superseded');assert.equal(s.store.read('jingyang').motivationState.revision,1);
});

test('情感反思提交遇到本地 IO 故障后，保存捕获输出并用原 packet 接续',async t=>{
  let fail=true;const f=driverSetup(t,args=>{
    const session=new AffectSession({...args,fusion:true}),commit=session.core.commit.bind(session.core);
    session.core.commit=a=>{if(fail){fail=false;throw Object.assign(Error('IO failure'),{code:'EIO'});}return commit(a);};return session;
  });
  const d=f.make();await d.tick({now:T,localHour:12});await assert.rejects(d.tick({now:T+2000000,localHour:12,idleReflection:true}));
  assert.equal([...f.store.all('affect_turn')][0].status,'captured');
  const result=await f.make().tick({now:T+5000000,localHour:12});assert.equal(result.action,'reflected');assert.equal(f.calls(),1);
});

test('停止轮询容忍进程退出时元数据暂缺，强制停止仍要求完整身份',async t=>{
  const {dir}=fixture(t),record={pid:42,createdAt:'birth',entry:resolve('entry.mjs'),executable:process.execPath,component:'ui',controlFile:join(dir,'stop.json'),controlToken:'test'};
  const states=[{pid:42,createdAt:'birth',executable:process.execPath,commandLine:`"${process.execPath}" "${record.entry}"`},{pid:42,createdAt:'birth',executable:null,commandLine:null},null];let killed=0;
  assert.equal((await stopOwned(record,{inspect:()=>states.shift()??null,kill:()=>killed++,waitMs:1000})).status,'stopped');assert.equal(killed,0);
});

test('管理入口失联时，只有显式强停且身份再次匹配才能停止进程',async t=>{
  const {dir}=fixture(t),record={pid:42,createdAt:'birth',entry:resolve('entry.mjs'),executable:process.execPath,component:'brain',stateDirectory:dir};
  writeFileSync(join(dir,'brain.instance.json'),JSON.stringify({pid:42,shutdownToken:'fixture',url:'http://127.0.0.1:1'}));
  const current={pid:42,createdAt:'birth',executable:process.execPath,commandLine:`"${process.execPath}" "${record.entry}"`};let killed=0;
  const options={inspect:()=>current,kill:()=>killed++,request:async()=>{throw Object.assign(Error('offline'),{code:'ECONNREFUSED'});},waitMs:0};
  await assert.rejects(stopOwned(record,options),e=>e.code==='ECONNREFUSED');assert.equal(killed,0);
  const r=await stopOwned(record,{...options,force:true});assert.equal(r.status,'force-requested');assert.equal(r.gracefulError,'ECONNREFUSED');assert.equal(killed,1);
  let n=0;await assert.rejects(stopOwned(record,{...options,force:true,inspect:()=>++n===1?current:{...current,createdAt:'replacement'}}),e=>e.code==='PROCESS_IDENTITY_CHANGED');assert.equal(killed,1);
});

test('预算读回拒绝负金额、重复请求及非法预留，原文件不被修写',t=>{
  const {dir}=fixture(t),path=join(dir,'budget.json');
  const base={format:'jingyang-daily-brain-budget-v1',dayKey:'2026-11-12',dailyMicros:3000000,dailyCalls:96,requests:[],halted:null};
  const row={id:'one',fingerprint:'fixed',reserveMicros:100,status:'settled',actualMicros:10};
  for(const rows of [[{...row,actualMicros:-1}],[row,{...row}],[{...row,reserveMicros:-2}]]){
    const bytes=JSON.stringify({...base,requests:rows});writeFileSync(path,bytes);
    assert.throws(()=>new DailyBudgetLedger(path,{dayKey:base.dayKey}),e=>e.code==='BUDGET_CORRUPT');assert.equal(readFileSync(path,'utf8'),bytes);
  }
});

test('旧日未知费用不会因日期变化自动归档并开启新额度',t=>{
  const {dir}=fixture(t),path=join(dir,'budget.json'),bytes=JSON.stringify({format:'jingyang-daily-brain-budget-v1',dayKey:'2026-11-11',dailyMicros:3000000,dailyCalls:96,requests:[{id:'old',fingerprint:'fixed',reserveMicros:100,status:'uncertain'}],halted:'unknown'});
  writeFileSync(path,bytes);assert.throws(()=>new DailyBudgetLedger(path,{dayKey:'2026-11-12'}),e=>e.code==='BUDGET_RECOVERY_REQUIRED');assert.equal(readFileSync(path,'utf8'),bytes);
});

test('累计审计区分完全重复与相互冲突的账目，冲突不会被去重抹掉',t=>{
  const {dir}=fixture(t),row={id:'same',fingerprint:'fixed',reserveMicros:100,status:'settled',actualMicros:10};
  writeFileSync(join(dir,'a.json'),JSON.stringify({requests:[row]}));writeFileSync(join(dir,'b.json'),JSON.stringify({requests:[row]}));
  assert.equal(auditBudgets(dir).within,true);assert.equal(auditBudgets(dir).calls,1);
  writeFileSync(join(dir,'b.json'),JSON.stringify({requests:[{...row,actualMicros:20}]}));assert.equal(auditBudgets(dir).within,false);assert.equal(auditBudgets(dir).conflictCount,1);
  writeFileSync(join(dir,'b.json'),JSON.stringify({requests:[{...row,fingerprint:'changed'}]}));assert.equal(auditBudgets(dir).within,false);assert.equal(auditBudgets(dir).idCollisions,1);
});

test('关闭拒绝输出必须核对真实配置的账本；认知关闭不修改任何费用记录',async t=>{
  const runtimeInfo={},f=await service(t,{runtimeInfo});runtimeInfo.ledgerPath=join(f.dir,'budget.json');
  const a=new AffectSession({store:f.s.store,subjectId:'jingyang',fusion:true});
  f.s.store.execute({requestId:'source',commands:[{op:'append_event',id:'source',body:'合成',scene:'synthetic',actor:'fixture',occurredAt:T,origin:'reported',source:{system:'fixture',key:'source'}},{op:'set_workspace',id:'review',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成'}}]});
  const p=await a.prepare({currentEvent:{id:'source',revision:1},workspace:{id:'review',revision:1},budgetBytes:131072,now:T});
  const raw=await a.invoke(p,()=>'{');await assert.rejects(a.commit({packet:p,output:raw,requestId:'bad',decisionId:'bad'}));
  f.s.store.execute({requestId:'capture-journal',commands:[activityWrite(null,{subject:'jingyang',workspace:{id:'review'},value:{phase:'captured',context:{kind:'decision'},packet:p,output:raw}})]});
  const turn=[...f.s.store.all('affect_turn')][0],bytes=JSON.stringify({format:'jingyang-daily-brain-budget-v1',requests:[{id:'turn:'+p.packetId,status:'settled',reserveMicros:20,actualMicros:12,output:raw}]});writeFileSync(runtimeInfo.ledgerPath,bytes);
  assert.throws(()=>f.s.closeRecoveryTurn({turnId:turn.id,expectedRevision:turn.revision,ledgerHash:'wrong'}),e=>e.code==='AFFECT_RESOLUTION');
  const r=f.s.closeRecoveryTurn({turnId:turn.id,expectedRevision:turn.revision,ledgerHash:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(r.status,'closed-incomplete');assert.equal(r.journalsClosed,1);assert.equal(r.ledgerUnchanged,true);assert.equal(readFileSync(runtimeInfo.ledgerPath,'utf8'),bytes);
  assert.equal(readActivity(f.s.store,'jingyang',{id:'review'}).value.phase,'complete');assert.equal(f.s.health().recovery.activities.length,0);
  let calls=0;const d=new TurnDriver({store:f.s.store,subjectId:'jingyang',workspace:{id:'review',revision:1},eventBypass:true,sessionFactory:affectFactory({fusion:true}),decide:p=>{calls++;return output(p,'wait',{});}});
  d.ingest({key:'next-after-closure',body:'后续合成事件',at:T+1000});await d.tick({now:T+1000,localHour:12});assert.equal(calls,1);assert.equal(readFileSync(runtimeInfo.ledgerPath,'utf8'),bytes);
});

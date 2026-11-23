import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {DailyBudgetLedger,createModelDecision} from '../src/model-transport.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {prepareReflection} from '../src/cognition.mjs';
import {memory,frame,put,ref} from './helpers.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const option=(tool,args={})=>({id:'x',kind:'act',payload:{tool,args}});
function response(p,o=option('task_finish',{result:'done'})){
 return {packetId:p.packetId,options:[o],selected:'x',summary:'离线合成接线验证',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};
}
function service(t,options={}){const s=createBrainService({subjectTask:true,global:true,heartbeatMs:0,...options});t.after(()=>s.close());return s;}

test('different versioned decisions with identical arguments execute separately; replay does not',async()=>{
 let count=0;const r=new AgentRuntime({tools:{probe:async()=>++count}}),task=r.createTask({goal:'identity',metadata:{allowedTools:['probe']}});
 for(const id of ['a','b','a'])await r.step(task,{decisionRef:{id,revision:1},kind:'tool',tool:'probe',args:{same:true}});
 assert.equal(count,2);assert.equal(task.observations.at(-1).deduplicated,true);
});

test('legacy ambiguous tool keys block execution instead of guessing migration',async()=>{
 let count=0;const r=new AgentRuntime({tools:{probe:async()=>count++}}),task=r.createTask({goal:'legacy',metadata:{allowedTools:['probe']}});
 task.toolOps={'[object Object]:probe:{}':{status:'succeeded'}};
 assert.equal((await r.step(task,{decisionRef:{id:'a',revision:1},kind:'tool',tool:'probe',args:{}})).error,'LEGACY_TOOL_IDENTITY_AMBIGUOUS');assert.equal(count,0);
});

test('consumed interrupts cannot wake a waiting task before its due time',()=>{
 const r=new AgentRuntime({now:()=>1000}),task=r.createTask({goal:'wait'});
 task.status='waiting';task.wakeAt=5000;task.interrupts=[{at:1,message:'read'}];task.interruptCursor=1;
 assert.equal(r.resume(task,{at:1000}),false);task.interrupts.push({at:2,message:'new'});assert.equal(r.resume(task,{at:1000}),true);
});

test('a response is not evidence that an agent task finished',async()=>{
 const r=new AgentRuntime(),task=r.createTask({goal:'work'});
 await r.step(task,{id:'decision',output:{options:[{id:'x',kind:'respond',payload:{text:'还在处理'}}],selected:'x'}});
 assert.equal(task.status,'running');assert.equal(task.result,null);
});

test('timed out tools are outcome-unknown and block automatic progression',async()=>{
 let calls=0;const r=new AgentRuntime({tools:{slow:()=>{calls++;return new Promise(()=>{});}}}),task=r.createTask({goal:'timeout',budget:{toolTimeoutMs:5},metadata:{allowedTools:['slow']}});
 const out=await r.step(task,{decisionRef:{id:'a',revision:1},kind:'tool',tool:'slow',args:{}});
 assert.equal(out.status,'blocked');assert.equal(task.blockedReason,'TOOL_OUTCOME_UNKNOWN');assert.equal(Object.values(task.toolOps)[0].status,'uncertain');
 await r.step(task,{decisionRef:{id:'b',revision:1},kind:'tool',tool:'slow',args:{}});assert.equal(calls,1);
});

for(const control of ['stop','pause','redirect'])test(`in-flight ${control} supersedes old model output before any effect`,async t=>{
 const entered=deferred(),release=deferred();let effects=0;
 const s=service(t,{decide:async p=>{entered.resolve();await release.promise;return response(p,option('probe'));},agentTools:{probe:async()=>effects++}});
 const task=await s.createAgentTask({goal:'old',metadata:{allowedTools:['probe']}}),pending=s.stepAgentTask(task.id);
 await entered.promise;
 if(control==='stop')await s.stopAgentTask(task.id,'stop');
 if(control==='pause')await s.pauseAgentTask(task.id,'pause');
 if(control==='redirect')await s.redirectAgentTask(task.id,{goal:'new'});
 release.resolve();await pending;const saved=s.store.read(task.id);
 assert.equal(saved.status,control==='stop'?'cancelled':control==='pause'?'paused':'running');
 assert.equal(effects,0);assert.equal(saved.callCount,1);if(control==='redirect')assert.equal(saved.goal,'new');
});

test('interrupt received during model work survives the checkpoint and is delivered exactly as unread',async t=>{
 const entered=deferred(),release=deferred();let calls=0,last=[];const now=1000;
 const s=service(t,{clock:()=>now,decide:async p=>{calls++;last=p.payload.task.interrupts;if(calls===1){entered.resolve();await release.promise;}return response(p,option('task_wait',{wakeAt:5000}));}});
 const task=await s.createAgentTask({goal:'interrupted',metadata:{allowedTools:[]}}),pending=s.stepAgentTask(task.id);await entered.promise;
 await s.interruptAgentTask(task.id,'new message');release.resolve();await pending;
 assert.equal(s.store.read(task.id).interruptCursor,0);assert.equal(s.store.read(task.id).interrupts.length,1);
 await s.agentTick();assert.equal(last[0].message,'new message');assert.equal(s.store.read(task.id).interruptCursor,1);
 await s.agentTick();assert.equal(calls,2);
});

test('new lease cannot be overwritten or released by the previous worker',async t=>{
 const entered=deferred(),release=deferred();let effects=0;
 const s=service(t,{decide:async p=>{entered.resolve();await release.promise;return response(p,option('probe'));},agentTools:{probe:async()=>effects++}});
 const task=await s.createAgentTask({goal:'lease',metadata:{allowedTools:['probe']}}),pending=s.stepAgentTask(task.id);await entered.promise;
 const current=s.store.read(task.id);s.store.execute({requestId:'new-lease',commands:[{op:'put_agent_task',expectedRevision:current.revision,task:{...current,lease:{owner:'api-step',token:'new-token',expiresAt:Date.now()+30000}}}]});
 release.resolve();await pending;assert.equal(effects,0);assert.equal(s.store.read(task.id).lease.token,'new-token');
});

test('pause while a tool is executing preserves both host control and the eventual real receipt',async t=>{
 const entered=deferred(),release=deferred();
 const s=service(t,{decide:p=>response(p,option('probe')),agentTools:{probe:async()=>{entered.resolve();await release.promise;return {actual:'finished'};}}});
 const task=await s.createAgentTask({goal:'pause during effect',metadata:{allowedTools:['probe']}}),pending=s.stepAgentTask(task.id);await entered.promise;
 await s.pauseAgentTask(task.id,'pause');release.resolve();await pending;
 const saved=s.store.read(task.id);assert.equal(saved.status,'paused');assert.equal(saved.observationRefs.length,1);assert.equal(saved.observations.at(-1).result.actual,'finished');
 assert.ok(s.store.subjectObservation('jingyang',saved.observationRefs[0].id));
});

test('one subject cannot start a second task or chat decision while a task decision is in flight',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const s=service(t,{decide:async p=>{calls++;entered.resolve();await release.promise;return response(p);}});
 const a=await s.createAgentTask({goal:'a'}),b=await s.createAgentTask({goal:'b'}),pending=s.stepAgentTask(a.id);await entered.promise;
 assert.equal((await s.stepAgentTask(b.id)).error,'AGENT_BUSY');assert.equal((await s.turn()).busy,true);assert.equal((await s.idleTurn()).busy,true);
 release.resolve();await pending;assert.equal(calls,1);
});

test('failed model attempts remain counted; exhaustion does not send a replacement request',async t=>{
 let calls=0;const s=service(t,{decide:()=>{calls++;throw Object.assign(Error('bad output'),{code:'MODEL_INCOMPLETE'});}});
 const task=await s.createAgentTask({goal:'budget',budget:{maxCalls:1}});await s.stepAgentTask(task.id);
 assert.equal(s.store.read(task.id).callCount,1);await s.resumeAgentTask(task.id,{});const out=await s.stepAgentTask(task.id);
 assert.equal(out.error,'MAX_CALLS');assert.equal(calls,1);
});

test('last authorized model attempt can still execute its already-budgeted decision',async t=>{
 let calls=0;const s=service(t,{decide:p=>{calls++;return response(p);}});
 const task=await s.createAgentTask({goal:'one call',budget:{maxCalls:1}});assert.equal((await s.stepAgentTask(task.id)).status,'done');assert.equal(calls,1);
});

test('result publish failure is explicit and recoverable without another model call',async t=>{
 let calls=0;const s=service(t,{decide:p=>{calls++;return response(p);}}),task=await s.createAgentTask({goal:'feedback'});
 const execute=s.store.execute.bind(s.store);s.store.execute=args=>{if(args.requestId.startsWith('agent-result-publish:'))throw Object.assign(Error('disk'),{code:'EIO'});return execute(args);};
 await s.stepAgentTask(task.id);assert.equal(s.store.read(task.id).status,'done');assert.equal(s.store.read(task.id).feedback.status,'pending');
 s.store.execute=execute;await s.agentTick();assert.equal(s.store.read(task.id).feedback.status,'recorded');assert.equal(calls,1);
 assert.equal([...s.store.all('event')].filter(e=>e.id.startsWith('agent-result:')).length,1);await s.agentTick();assert.equal(calls,1);
});

test('repeated blocked transitions produce distinct feedback instead of colliding on one status key',async t=>{
 let n=0;const s=service(t,{decide:p=>response(p,option('task_blocked',{reason:'missing '+(++n)}))});
 const task=await s.createAgentTask({goal:'retry explanation'});await s.stepAgentTask(task.id);await s.resumeAgentTask(task.id,{});await s.stepAgentTask(task.id);
 const results=[...s.store.all('event')].filter(e=>e.id.startsWith('agent-result:'));assert.equal(results.length,2);assert.notEqual(results[0].body,results[1].body);
});

test('reopening a ledger with an unfinished dispatch retains reserve and blocks new sends',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'jingyang-ledger-recovery-')),'budget.json');
 let ledger=new DailyBudgetLedger(path);ledger.reserve('old','fingerprint',1000);ledger.dispatch('old');ledger.close();
 ledger=new DailyBudgetLedger(path);try{assert.equal(ledger.tryFind('old').status,'dispatched');assert.equal(ledger.tryFind('old').reserveMicros,1000);assert.ok(ledger.state().halted);assert.throws(()=>ledger.reserve('new','new',1000),{code:'BUDGET_HALTED'});}finally{ledger.close();}
});

test('empty provider output is recorded once and never silently resent',async t=>{
 const {store}=memory(t);new ContinuitySession({store,subjectId:'s',attention:true,maxForeground:16});
 const workspace=put(store,'w',frame())[0],p=prepareReflection({store,subjectId:'s',workspace:ref(workspace),internal:{format:'reflection-frame-v1'},budgetBytes:90000});
 const path=join(mkdtempSync(join(tmpdir(),'jingyang-no-retry-')),'budget.json');let calls=0;
 const model=createModelDecision({ledgerPath:path,getKey:()=> 'sk-synthetic-test-only',networkCheck:async()=>({ok:true}),transport:async()=>{calls++;return new Response(JSON.stringify({model:'fixture',choices:[{finish_reason:'stop',message:{content:''}}],usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60}}),{status:200});}});
 try{await assert.rejects(model.decide(p),{code:'MODEL_INCOMPLETE'});assert.equal(calls,1);assert.equal(model.state().calls,1);assert.equal(JSON.parse(readFileSync(path,'utf8')).requests[0].status,'settled');}finally{model.close();}
});

test('six uses of the same tool with genuine new inputs are not classified as no progress',async()=>{
 const r=new AgentRuntime({tools:{page:async({index})=>({index})}}),task=r.createTask({goal:'seven pages',metadata:{allowedTools:['page']}});
 for(let i=0;i<7;i++)await r.step(task,{decisionRef:{id:'d'+i,revision:1},kind:'tool',tool:'page',args:{index:i}});
 assert.equal(task.status,'running');assert.equal(task.stepCount,7);
});

test('an interrupt arriving during input preparation cannot be marked as already read',async t=>{
 const prepared=deferred(),release=deferred();let seen;
 const s=service(t,{sessionFactory:args=>{
  const core=new ContinuitySession(args);return {
   prepare:async a=>{const p=core.prepare(a);prepared.resolve();await release.promise;return p;},
   invoke:(...a)=>core.invoke(...a),commit:(...a)=>core.commit(...a),sourceBlocked:()=>false
  };
 },decide:p=>{seen=p.payload.task.interrupts;return response(p,option('task_wait',{wakeAt:Date.now()+60000}));}});
 const task=await s.createAgentTask({goal:'new input during prepare'}),pending=s.stepAgentTask(task.id);await prepared.promise;
 await s.interruptAgentTask(task.id,'not delivered yet');release.resolve();await pending;
 assert.equal(seen.length,0);const current=s.store.read(task.id);assert.equal(current.interrupts.length,1);assert.equal(current.interruptCursor,0);
});

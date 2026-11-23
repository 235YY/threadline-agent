import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime,TASK_TERMINAL,INTENT_TASK_RUNNABLE,INTENT_TASK_SETTLEMENT,taskStartIdentity,sameTaskStart,intentTaskConstraint} from '../src/agent-runtime.mjs';

// U2 / C: the Task layer owns declaration normalization and terminal guards. It may narrow
// authority (declared names ∩ this Runtime's registry) but never widen it.
test('task allowedTools are normalized and never widen the Runtime registry',()=>{
  const runtime=new AgentRuntime({tools:{alpha:async()=>({}),beta:async()=>({})}});
  const missing=runtime.createTask({goal:'missing declaration'});
  assert.equal(missing.metadata,null);
  assert.deepEqual(runtime.declaredAllowedToolNames(missing),[]);
  assert.deepEqual(runtime.allowedToolNames(missing),[]);
  const explicitEmpty=runtime.createTask({goal:'explicit empty',metadata:{allowedTools:[]}});
  assert.deepEqual(explicitEmpty.metadata.allowedTools,[],'explicit empty stays an explicit statement');
  assert.deepEqual(runtime.allowedToolNames(explicitEmpty),[]);
  const duplicated=runtime.createTask({goal:'duplicated',metadata:{allowedTools:[' alpha ','alpha','unknown']}});
  assert.deepEqual(duplicated.metadata.allowedTools,['alpha','unknown']);
  assert.deepEqual(runtime.allowedToolNames(duplicated),['alpha'],'unregistered names stay declared but never executable');
  assert.throws(()=>runtime.createTask({goal:'bad',metadata:{allowedTools:'alpha'}}),{code:'TASK_ALLOWED_TOOLS'});
  assert.throws(()=>runtime.createTask({goal:'bad',metadata:{allowedTools:[1]}}),{code:'TASK_ALLOWED_TOOLS'});
  assert.throws(()=>runtime.createTask({goal:'bad',metadata:{allowedTools:[' ']}}),{code:'TASK_ALLOWED_TOOLS'});
  assert.throws(()=>runtime.createTask({goal:'bad',metadata:{allowedTools:Array.from({length:65},(_,index)=>'t'+index)}}),{code:'TASK_ALLOWED_TOOLS_LIMIT'});
  const restored=runtime.restore({...duplicated,metadata:{allowedTools:[' beta ','beta']}});
  assert.deepEqual(restored.metadata.allowedTools,['beta']);
  assert.deepEqual(runtime.allowedToolNames(restored),['beta']);
});

test('a tool decision is executed once and terminal Tasks reject further work',async()=>{
  const calls=[];
  const runtime=new AgentRuntime({tools:{step:async()=>{calls.push(1);return {ok:true};}},now:()=>1000});
  const task=runtime.createTask({goal:'terminal',metadata:{allowedTools:['step']}});
  await runtime.executeDecision(task,{decisionRef:{id:'d1',revision:1},kind:'tool',tool:'step',args:{}});
  await runtime.executeDecision(task,{decisionRef:{id:'d2',revision:1},kind:'finish',result:'done'});
  assert.equal(task.status,'done');
  assert.equal(task.result,'done');
  assert.deepEqual(runtime.interrupt(task,'late interrupt'),{queued:false,count:0,reason:'TASK_TERMINAL'});
  assert.equal(runtime.resume(task),false);
  assert.equal(runtime.redirect(task,{goal:'nope'}),false);
  assert.equal(runtime.pause(task),false);
  assert.equal(runtime.stop(task),false);
  const replay=await runtime.executeDecision(task,{decisionRef:{id:'d3',revision:1},kind:'tool',tool:'step',args:{}});
  assert.equal(replay.skipped,true);
  assert.equal(calls.length,1,'the same Task never re-executes after its terminal outcome');
  assert.equal(task.result,'done');
  assert.equal(runtime.isTerminal(task),true);
  assert.deepEqual(TASK_TERMINAL,['done','failed','cancelled']);
});

test('duplicate task-start identity only exists for explicit Intent bindings',()=>{
  const a={intentRef:{id:'intent:s:1',revision:1},goal:' read book ',processId:null};
  const b={intentRef:{id:'intent:s:1',revision:1},goal:'read book',processId:null};
  assert.equal(sameTaskStart(a,b),true);
  assert.equal(sameTaskStart(a,{...b,intentRef:{id:'intent:s:1',revision:2}}),false,'a later Intent revision is different work');
  assert.equal(sameTaskStart(a,{...b,processId:'P1'}),false,'a different Process binding is a different Task start');
  assert.equal(sameTaskStart({goal:'same text'},{goal:'same text'}),false,'goal text alone is not an Intent identity');
  assert.equal(taskStartIdentity({intentRef:null,goal:'x'}),null);
  assert.equal(sameTaskStart({intentRef:{id:'intent:s:1',revision:1},goal:'x'},{intentRef:{id:'intent:s:2',revision:1},goal:'x'}),false);
});

test('Intent→Task constraints mirror the snapshot contract without guessing',()=>{
  assert.deepEqual(INTENT_TASK_RUNNABLE,['open','pursuing','deferred']);
  for(const status of INTENT_TASK_RUNNABLE)assert.deepEqual(intentTaskConstraint(status),{advance:true,settle:null});
  assert.deepEqual(intentTaskConstraint('completed'),{advance:false,settle:'cancelled'});
  assert.deepEqual(intentTaskConstraint('abandoned'),{advance:false,settle:'cancelled'});
  assert.deepEqual(intentTaskConstraint('expired'),{advance:false,settle:'cancelled'});
  assert.deepEqual(intentTaskConstraint('unknown-status'),{advance:false,settle:null});
  assert.deepEqual(INTENT_TASK_SETTLEMENT.deferred,'paused');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../src/agent-runtime.mjs';

const decisions=actions=>actions.map((a,i)=>({decisionRef:{id:`d${i}`,revision:1},...a}));
test('Decision-driven action-observation loop; Runtime executes without model',async()=>{
  const seen=[];
  const runtime=new AgentRuntime({tools:{add:async({n})=>({value:n})},now:()=>1000});
  const task=runtime.createTask({goal:'two adds',metadata:{allowedTools:['add']}});
  const actions=decisions([{kind:'tool',tool:'add',args:{n:1}},{kind:'tool',tool:'add',args:{n:2}},{kind:'finish',result:'3'}]);
  for(const a of actions){const r=await runtime.executeDecision(task,a);seen.push(r);}
  assert.equal(task.status,'done');assert.equal(task.result,'3');assert.equal(task.observations.length,2);
  assert.equal(task.decisionRefs.length,3);assert.equal(seen[0].observation.tool,'add');
});
test('tool failure returns observation; a later Decision can finish',async()=>{
  const runtime=new AgentRuntime({tools:{bad:async()=>{throw Object.assign(new Error('down'),{code:'TOOL_DOWN'});}},now:()=>1000});
  const task=runtime.createTask({goal:'failure recovery',metadata:{allowedTools:['bad']}});
  await runtime.executeDecision(task,decisions([{kind:'tool',tool:'bad',args:{}}])[0]);
  assert.equal(task.observations[0].ok,false);assert.equal(task.observations[0].error,'TOOL_DOWN');
  await runtime.executeDecision(task,{kind:'finish',result:'recovered'});
  assert.equal(task.status,'done');assert.equal(task.result,'recovered');
});
test('wait/interrupt/checkpoint restore works without a model',async()=>{
  let saved=null;const runtime=new AgentRuntime({now:()=>1000,checkpoint:s=>{saved=s;}});
  const task=runtime.createTask({goal:'wait then resume',metadata:{allowedTools:[]}});
  await runtime.executeDecision(task,{kind:'wait',wakeAt:1500});
  assert.equal(task.status,'waiting');assert.ok(saved);
  const loaded=runtime.restore(saved);runtime.interrupt(loaded,'user interrupt');
  assert.equal(loaded.interrupts.length,1);assert.equal(runtime.resume(loaded,{at:2000}),true);
  await runtime.executeDecision(loaded,{kind:'finish',result:'heard'});
  assert.equal(loaded.status,'done');assert.equal(loaded.result,'heard');
});
test('unknown tool is rejected; Runtime never invents a tool call',async()=>{
  const runtime=new AgentRuntime({tools:{},now:()=>1000});
  const task=runtime.createTask({goal:'bad tool',metadata:{allowedTools:['missing']}});
  const r=await runtime.executeDecision(task,{kind:'tool',tool:'missing',args:{}});
  assert.equal(r.ok,false);assert.equal(task.observations[0].error,'UNKNOWN_TOOL');
});
test('step without a committed Decision is rejected',async()=>{
  const runtime=new AgentRuntime({now:()=>1000});
  const task=runtime.createTask({goal:'no decision',metadata:{allowedTools:[]}});
  const r=await runtime.step(task);
  assert.equal(r.error,'DECISION_REQUIRED');assert.equal(task.status,'running');
});

test('nested args and different Decisions produce distinct idempotency keys',async()=>{
  const calls=[];const runtime=new AgentRuntime({tools:{probe:async args=>{calls.push(args);return {ok:true};}},now:()=>1000});
  const task=runtime.createTask({goal:'nested args',metadata:{allowedTools:['probe']}});
  await runtime.executeDecision(task,{decisionRef:{id:'d1',revision:1},kind:'tool',tool:'probe',args:{nested:{x:1}}});
  await runtime.executeDecision(task,{decisionRef:{id:'d2',revision:1},kind:'tool',tool:'probe',args:{nested:{x:2}}});
  assert.equal(calls.length,2);
  await runtime.executeDecision(task,{decisionRef:{id:'d1',revision:1},kind:'tool',tool:'probe',args:{nested:{x:1}}});
  assert.equal(calls.length,2);assert.equal(task.observations.at(-1).deduplicated,true);
});

test('observation persistence failure blocks without retrying the tool',async()=>{
  let calls=0;const runtime=new AgentRuntime({tools:{side:async()=>{calls++;return {ok:true};}},onObservation:()=>{throw Object.assign(new Error('db down'),{code:'OBS_DOWN'});},now:()=>1000});
  const task=runtime.createTask({goal:'persist fail',metadata:{allowedTools:['side']}});
  const r=await runtime.executeDecision(task,{decisionRef:{id:'d1',revision:1},kind:'tool',tool:'side',args:{}});
  assert.equal(r.status,'blocked');assert.equal(task.status,'blocked');assert.equal(task.blockedReason,'OBSERVATION_PERSIST_FAILED');assert.equal(calls,1);
  assert.equal(task.observations.some(o=>o.kind==='persistence_error'),true);
});

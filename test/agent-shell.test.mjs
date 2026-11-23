import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';

const attention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const taskDecide=packet=>{
  const step=packet.payload.task?.stepCount??0;
  const tool=step===0?'tick':'task_finish';
  return JSON.stringify({packetId:packet.packetId,options:[{id:'x',kind:'act',payload:tool==='tick'?{tool:'tick',args:{}}:{tool:'task_finish',args:{result:'resumed'}}}],selected:'x',summary:'step',used:[],
    continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
};

test('stop is host control and no Decision executes after stop',async()=>{
  const r=new AgentRuntime({tools:{},now:()=>1000});
  const t=r.createTask({goal:'stop me',metadata:{allowedTools:[]}});
  r.stop(t,'user stop');
  const out=await r.step(t,{kind:'finish',result:'x'});
  assert.equal(out.skipped,true);assert.equal(t.status,'cancelled');
});
test('redirect only changes a running task; next Decision sees new goal',async()=>{
  const r=new AgentRuntime({tools:{},now:()=>1000});
  const t=r.createTask({goal:'old',metadata:{allowedTools:[]}});
  assert.equal(r.redirect(t,{goal:'new',plan:'new plan'}),true);
  await r.executeDecision(t,{kind:'finish',result:t.goal});
  assert.equal(t.goal,'new');assert.equal(t.result,'new');
  assert.equal(r.redirect(t,{goal:'after'}),false);
});
test('ten-step Decision task with three tools and one failure',async()=>{
  const r=new AgentRuntime({tools:{a:async()=>({ok:true}),b:async({fail})=>{if(fail)throw Object.assign(new Error('bad'),{code:'TOOL_BAD'});return {ok:true};},c:async()=>({ok:true})},now:()=>1000});
  const t=r.createTask({goal:'three tools',metadata:{allowedTools:['a','b','c']}});
  for(let i=0;i<9;i++){const tool=['a','b','c'][i%3],args=tool==='b'&&i===1?{fail:true}:{n:i};await r.executeDecision(t,{kind:'tool',tool,args});}
  await r.executeDecision(t,{kind:'finish',result:'verified'});
  assert.equal(t.status,'done');assert.equal(t.stepCount,9);assert.equal(t.result,'verified');
  assert.equal(t.observations.some(o=>o.ok===false&&o.error==='TOOL_BAD'),true);
});
test('restart from same SQLite resumes subject task',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jingyang-agent-'));const store=join(dir,'subject.sqlite');
  const a=await startBrainService({port:0,storePath:store,heartbeatMs:0,subjectTask:true,decide:taskDecide,agentTools:{tick:async()=>({ok:true})}});
  const task=await a.createAgentTask({goal:'restart task',metadata:{allowedTools:['tick']}});
  await a.agentTick();
  await new Promise(r=>a.server.close(r));a.close();
  const b=await startBrainService({port:0,storePath:store,heartbeatMs:0,subjectTask:true,decide:taskDecide,agentTools:{tick:async()=>({ok:true})}});
  try{const result=await b.agentTick();assert.equal(result.status,'done');assert.equal(b.store.read(task.id).result,'resumed');}
  finally{await new Promise(r=>b.server.close(r));b.close();rmSync(dir,{recursive:true,force:true});}
});
test('no Decision is an explicit failure, not cancellation',async()=>{
  const r=new AgentRuntime({tools:{},now:()=>1000});
  const t=r.createTask({goal:'no decision',metadata:{allowedTools:[]}});
  const out=await r.step(t);
  assert.equal(out.error,'DECISION_REQUIRED');assert.equal(t.status,'running');
});
test('six repeated identical tool Decisions become blocked',async()=>{
  const r=new AgentRuntime({tools:{loop:async()=>({ok:true})},now:()=>1000});
  const t=r.createTask({goal:'loop guard',metadata:{allowedTools:['loop']}});
  for(let i=0;i<6;i++)await r.executeDecision(t,{kind:'tool',tool:'loop',args:{}});
  assert.equal(t.status,'blocked');assert.match(t.blockedReason,/NO_PROGRESS/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';

const attention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const continuity={changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()};
function decideWith(fn){return packet=>JSON.stringify({packetId:packet.packetId,options:[fn(packet)],selected:'x',summary:'task step',used:[],continuity});}
function option(tool,args={}){return {id:'x',kind:'act',payload:{tool,args}};}

test('brain-service 持久任务：工具观察后继续，任务落 store 并可再读',async t=>{
  const decide=decideWith(packet=>(packet.payload.task?.stepCount??0)===0?option('add',{n:1}):option('task_finish',{result:'ok'}));
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,global:true,subjectTask:true,decide,agentTools:{add:async({n})=>({n})}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'持久任务',plan:'先加一',metadata:{allowedTools:['add']}});
  assert.equal(task.status,'running');
  let result=await service.stepAgentTask(task.id);assert.equal(result.ok,true);
  result=await service.stepAgentTask(task.id);assert.equal(result.status,'done');
  const saved=service.store.read(task.id);assert.equal(saved.type,'agent_task');assert.equal(saved.status,'done');
  assert.equal(saved.observations.length,1);assert.equal(saved.decisionRefs.length,2);
});

test('task step leaves no host Action and its observation is already handled',async t=>{
  const decide=decideWith(packet=>(packet.payload.task?.stepCount??0)===0?option('tick'):option('task_finish',{result:'done'}));
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{tick:async()=>({ok:true})}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'no ghost action',metadata:{allowedTools:['tick']}});
  assert.equal((await service.stepAgentTask(task.id)).ok,true);
  assert.equal([...service.store.all('action')].length,0,'task step must not create a host Action');
  const observation=[...service.store.all('event')].find(e=>e.source?.system==='agent-runtime');
  assert.ok(observation,'tool observation event exists');
  assert.equal(service.store.subjectObservation('jingyang',observation.id).status,'handled');
  assert.equal(service.store.subjectInbox({subjectId:'jingyang',pendingOnly:true}).items.some(x=>x.eventId===observation.id),false);
  assert.equal((await service.stepAgentTask(task.id)).status,'done');
  const result=[...service.store.all('event')].find(e=>String(e.id).startsWith('agent-result:'));
  assert.ok(result);assert.equal(service.store.subjectObservation('jingyang',result.id).status,'received');
});

test('Agent task 的观测事件使用显式 subject process threadId，可被 threadUnits 恢复',async t=>{
  const decide=decideWith(packet=>(packet.payload.task?.stepCount??0)===0?option('tick'):option('task_finish',{result:'thread done'}));
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{tick:async()=>({ok:true})}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'thread task',threadId:'subject-process:test',metadata:{allowedTools:['tick']}});
  await service.stepAgentTask(task.id);await service.stepAgentTask(task.id);
  const events=[...service.store.all('event')].filter(e=>e.threadId==='subject-process:test');
  assert.ok(events.length>=1);
  const {threadUnits}=await import('../src/task-threads.mjs');
  const view=threadUnits({store:service.store,threadId:'subject-process:test',limit:30});
  assert.ok(view.units.length>=1);
});

test('1+3 active task scheduler drains five tasks without loss', async t=>{
  const decide=decideWith(()=>option('task_finish',{result:'done'}));
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const tasks=[];for(let i=0;i<5;i++)tasks.push(await service.createAgentTask({goal:`scheduler-${i}`,metadata:{allowedTools:[]}}));
  for(let i=0;i<10;i++)await service.agentTick();
  assert.equal(service.listAgent().filter(t=>t.status==='done').length,5);
});

test('task completion does not auto-report to user; result stays in her event stream', async t=>{
  const sent=[];const decide=decideWith(()=>option('task_finish',{result:'internal result'}));
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{},adapter:{send:async x=>{sent.push(x);return {delivered:true};}}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'private result',target:'qq/private/1',metadata:{allowedTools:[]}});
  await service.agentTick();
  assert.equal(sent.length,0);
  assert.equal(service.store.read(task.id).status,'done');
  assert.ok([...service.store.all('event')].some(e=>e.origin==='tool_receipt'&&!e.threadId));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {disk} from './helpers.mjs';

const attention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const continuity={changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()};
const decide=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'x',kind:'act',payload:{tool:'task_finish',args:{result:'ok'}}}],selected:'x',summary:'task',used:[],continuity});
const action=(id,goal,intentId)=>({op:'propose_action',id,workspace:{id:'w',revision:1},tool:'start_agent_task',args:{goal,intentId},inputRefs:[]});

test('a subject can start one task from an Intent and the result returns to the inbox', async t => {
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const store=service.store;
  store.execute({requestId:'w',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'现在'}}]});
  const intent={format:'jingyang-intent-v1',id:'intent:jingyang:p13',subject:'jingyang',goal:'研究小屋结构',rationale:'还有未知',nextAction:'先查记录',dueAt:null,status:'open',source:'reflection',createdAt:2000};
  store.execute({requestId:'intent',commands:[{op:'put_intent',id:intent.id,expectedRevision:0,value:intent}]});
  store.execute({requestId:'a1',commands:[action('a1','研究小屋结构','intent:jingyang:p13')]});
  const first=await service.executeAction({id:'a1',revision:1});
  const task=service.listAgent()[0];
  assert.equal(task.intentRef.id,'intent:jingyang:p13');
  assert.equal(task.goal,'研究小屋结构');
  const d1=await service.stepAgentTask(task.id);
  assert.equal(d1.status,'done');
  const resultEvent=[...store.all('event')].find(e=>e.id.startsWith('agent-result:'));
  assert.ok(resultEvent);
  assert.ok(store.subjectObservation('jingyang',resultEvent.id));
  store.execute({requestId:'a2',commands:[action('a2','研究小屋结构','intent:jingyang:p13')]});
  await service.executeAction({id:'a2',revision:1});
  const beforeResults=[...store.all('event')].filter(e=>e.id.startsWith('agent-result:')).length;
  await service.stepAgentTask(task.id);
  assert.equal([...store.all('event')].filter(e=>e.id.startsWith('agent-result:')).length,beforeResults,'terminal result must not duplicate');
  assert.equal(service.listAgent().length,1,'same intent/goal must not create a duplicate logical task');
  assert.equal(service.listAgent()[0].id,task.id);
});

test('a failed task result also returns to the subject inbox', async t => {
  const blocked = packet => JSON.stringify({packetId: packet.packetId,
    options: [{id: 'x', kind: 'act', payload: {tool: 'task_blocked', args: {reason: 'tool failed'}}}],
    selected: 'x', summary: 'blocked', used: [], continuity});
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide:blocked,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'失败任务',intentRef:{id:'intent:jingyang:failed',revision:1},metadata:{allowedTools:[]}});
  const result=await service.stepAgentTask(task.id);
  assert.equal(result.status,'blocked');
  const event=[...service.store.all('event')].find(e=>e.id.startsWith('agent-result:'));
  assert.ok(event);
  assert.ok(service.store.subjectObservation('jingyang',event.id));
});

test('Intent, task and result survive a service restart without duplicate work', async t => {
  const path=disk(t);
  const make=()=>startBrainService({port:0,storePath:path,heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  const a=await make();
  const intent={format:'jingyang-intent-v1',id:'intent:jingyang:restart',subject:'jingyang',goal:'重启研究',rationale:'',nextAction:null,dueAt:null,status:'open',source:'reflection',createdAt:2000};
  a.store.execute({requestId:'i',commands:[{op:'put_intent',id:intent.id,expectedRevision:0,value:intent}]});
  a.store.execute({requestId:'w',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'现在'}}]});
  a.store.execute({requestId:'a1',commands:[action('a1','重启研究','intent:jingyang:restart')]});
  await a.executeAction({id:'a1',revision:1});
  const taskId=a.listAgent()[0].id;
  await new Promise(r=>a.server.close(r));a.close();
  const b=await make();
  try {
    assert.equal(b.listAgent().length,1);assert.equal(b.store.read(taskId).status,'running');
    assert.equal(b.store.read('intent:jingyang:restart').status,'open');
    const result=await b.stepAgentTask(taskId);assert.equal(result.status,'done');
    const event=[...b.store.all('event')].find(e=>e.id.startsWith('agent-result:'));
    assert.ok(event);assert.ok(b.store.subjectObservation('jingyang',event.id));
  } finally { await new Promise(r=>b.server.close(r));b.close(); }
});

test('health reports only generic theory availability when Limbic is disabled', async t => {
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,theoryStatus:()=>({enabled:false,available:false,version:null})});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const h=service.health();
  assert.deepEqual(h.theory,{enabled:false,available:false,version:null});
  assert.equal(Object.hasOwn(h,'motivationState'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';

const attention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const taskContinuity={changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()};
test('blocked task can resume with added information without resetting progress',async t=>{
  let n=0;
  const decide=packet=>{n++;
    if(n===1)return JSON.stringify({packetId:packet.packetId,options:[{id:'b',kind:'act',payload:{tool:'task_blocked',args:{reason:'missing input'}}}],selected:'b',summary:'blocked',used:[],continuity:taskContinuity});
    return JSON.stringify({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'resumed'}}}],selected:'f',summary:'done',used:[],continuity:taskContinuity});};
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'blocked task',metadata:{allowedTools:[]}});
  await service.stepAgentTask(task.id);assert.equal(service.store.read(task.id).status,'blocked');
  const resumed=await service.resumeAgentTask(task.id,{message:'这里是缺少的信息'});assert.equal(resumed.ok,true);
  const result=await service.stepAgentTask(task.id);assert.equal(result.status,'done');
  assert.equal(service.store.read(task.id).result,'resumed');
});
test('chat interrupt enters task context without cancelling it',async t=>{
  let n=0,seen=[];
  const decide=packet=>{n++;const step=packet.payload.task?.stepCount??0;seen.push(packet.payload.task?.interrupts?.map(x=>x.message)??[]);
    if((packet.payload.task?.interrupts?.length??0)===0)return JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'act',payload:{tool:'task_wait',args:{wakeAt:Date.now()+60000}}}],selected:'w',summary:'wait',used:[],continuity:taskContinuity});
    return JSON.stringify({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'heard'}}}],selected:'f',summary:'done',used:[],continuity:taskContinuity});};
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'waiting task',metadata:{allowedTools:[]}});
  await service.stepAgentTask(task.id);assert.equal(service.store.read(task.id).status,'waiting');
  await service.interruptAgentTask(task.id,'用户在任务中插话');
  await service.resumeAgentTask(task.id,{});
  await service.stepAgentTask(task.id);
  assert.equal(seen.some(x=>x.includes('用户在任务中插话')),true);
  assert.equal(service.store.read(task.id).status,'done');
});

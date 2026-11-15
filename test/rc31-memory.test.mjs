import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';

const baseAttention={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]};
test('RC3.1 one subject decision commits taskDecision and Impression together',async t=>{
  const makeImpression=packet=>({id:'imp-rc31-1',expectedRevision:0,kind:'impression',stage:'recent',body:'这次任务让我确认自己能继续做下去',status:'open',nature:'self-report',scope:['task:rc31'],about:[],domains:['self'],basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}]}});
  const decide=packet=>JSON.stringify({packetId:packet.packetId,
    options:[{id:'finish',kind:'act',payload:{tool:'task_finish',args:{result:'done with impression'}}}],selected:'finish',summary:'finish and remember',used:[],
    continuity:{changes:[makeImpression(packet)],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:baseAttention}});
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'memory closure',metadata:{allowedTools:[]}});
  await service.agentTick();
  assert.equal(service.store.read(task.id).status,'done');
  const states=[...service.store.all('personal_state')].filter(x=>x.kind==='impression');
  assert.equal(states.length,1);assert.equal(states[0].body,'这次任务让我确认自己能继续做下去');
  const decision=[...service.store.all('decision')].find(d=>d.input?.payload?.task?.id===task.id);
  assert.ok(decision);assert.equal(decision.output.selected,'finish');
  assert.equal(decision.input.payload.task.id,task.id);
});

test('RC3.1 tool failure enters observation, then subject can revise memory',async t=>{
  let n=0,sawFailure=false;
  const decide=packet=>{
    n++;
    if(n===1)return JSON.stringify({packetId:packet.packetId,options:[{id:'x',kind:'act',payload:{tool:'bad',args:{}}}],selected:'x',summary:'try',used:[],
      continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
    sawFailure=(packet.payload.task?.observations??[]).some(o=>o.error==='TOOL_DOWN');
    const impression={id:'imp-after-failure',expectedRevision:0,kind:'impression',stage:'recent',body:'工具失败后我确认需要换一种做法',status:'open',nature:'reappraisal',scope:['task:rc31'],about:[],domains:['self'],basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}]}};
    return JSON.stringify({packetId:packet.packetId,options:[{id:'f',kind:'act',payload:{tool:'task_finish',args:{result:'revised'}}}],selected:'f',summary:'finish',used:[],
      continuity:{changes:[impression],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
  };
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,subjectTask:true,decide,agentTools:{bad:async()=>{throw Object.assign(new Error('down'),{code:'TOOL_DOWN'});}}});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const task=await service.createAgentTask({goal:'failure memory',metadata:{allowedTools:['bad']}});
  await service.agentTick();assert.equal(service.store.read(task.id).status,'running');
  assert.equal([...service.store.all('personal_state')].filter(x=>x.kind==='impression').length,0);
  await service.agentTick();assert.equal(sawFailure,true);assert.equal(service.store.read(task.id).status,'done');
  assert.equal([...service.store.all('personal_state')].filter(x=>x.kind==='impression').length,1);
});

test('RC3.1 ten-round task evolves two impressions and one BCRZ, survives restart',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'rc31-memory-evolution-'));const store=join(dir,'subject.sqlite');
  const decide=packet=>{
    const step=packet.payload.task?.stepCount??0;const changes=[];
    if(step===0)changes.push({id:'imp-evo-1',expectedRevision:0,kind:'impression',stage:'recent',body:'第一轮我确认可以继续',status:'open',nature:'self-report',scope:['task:evo'],about:[],domains:['self'],basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}]}});
    if(step===1)changes.push({id:'imp-evo-2',expectedRevision:0,kind:'impression',stage:'recent',body:'第二轮我更清楚要怎么做',status:'open',nature:'reappraisal',scope:['task:evo'],about:[],domains:['self'],basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}]}});
    if(step===2)changes.push({id:'bcrz-evo',expectedRevision:0,kind:'appraisal',body:'这个任务需要逐步核对而不是一次做完',nature:'reappraisal',basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}]}});
    const tool=step>=10?'task_finish':['a','b','c'][step%3];const args=tool==='task_finish'?{result:'evolved'}:{n:step};
    return JSON.stringify({packetId:packet.packetId,options:[{id:'x',kind:'act',payload:{tool,args}}],selected:'x',summary:'step',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
  };
  const a=await startBrainService({port:0,storePath:store,heartbeatMs:0,subjectTask:true,decide,agentTools:{a:async()=>({ok:true}),b:async()=>({ok:true}),c:async()=>({ok:true})}});
  const task=await a.createAgentTask({goal:'memory evolution',metadata:{allowedTools:['a','b','c']}});
  for(let i=0;i<11;i++)await a.agentTick();
  assert.equal(a.store.read(task.id).status,'done');
  assert.equal([...a.store.all('personal_state')].filter(x=>x.kind==='impression').length,2);
  assert.equal([...a.store.all('personal_state')].filter(x=>x.kind==='appraisal').length,1);
  await new Promise(r=>a.server.close(r));a.close();
  const b=await startBrainService({port:0,storePath:store,heartbeatMs:0,subjectTask:true,decide,agentTools:{a:async()=>({ok:true}),b:async()=>({ok:true}),c:async()=>({ok:true})}});
  try{assert.equal([...b.store.all('personal_state')].filter(x=>x.kind==='impression').length,2);assert.equal([...b.store.all('personal_state')].filter(x=>x.kind==='appraisal').length,1);}
  finally{await new Promise(r=>b.server.close(r));b.close();rmSync(dir,{recursive:true,force:true});}
});

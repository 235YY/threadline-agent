import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBrainService,createSchedulerFailureReporter} from '../tools/brain-service/server.mjs';
import {keepAttention,attentionId} from '../src/attention.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';

const response=packet=>({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'在的'}}],selected:'r',summary:'回归回复',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:{mode:'direct',reason:null},observationDisposition:'handled',attention:{...keepAttention(),focus:{select:[]}}}});
const wait=packet=>({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{mode:'next-event'}}],selected:'w',summary:'等待',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:{mode:'direct',reason:null},observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=2000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return true;await sleep(10);}return false;}

function fixture({stale=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'no-reply-scheduler-'));
  const state=join(dir,'state');mkdirSync(state,{recursive:true});
  const storePath=join(dir,'subject.sqlite');
  writeFileSync(join(state,'context-cursor.json'),JSON.stringify({lastEventId:null,lastAt:null,eventsSince:0,lastMemoryAt:0,lastIdleAt:Date.now()}),'utf8');
  if(stale)writeFileSync(join(state,'scheduler.json'),JSON.stringify({scheduler:{active:null,scenes:[{key:'global',firstAt:1,queue:[{key:'stale:old',body:'handled old event',scene:'qq/private/1',actor:'fixture',at:1,threadId:null}]}]}}),'utf8');
  return {dir,state,storePath};
}
const close=async service=>{try{service.stopScheduling();}catch{}try{await new Promise(r=>service.server.close(r));}catch{}try{service.close();}catch{}};

test('P0-A/B: memoryDue + 两条入账消息，无需第二次 /reply 也持续推进',async t=>{
  const f=fixture({stale:true});t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
  const calls=[];let service;
  try{
    service=await startBrainService({storePath:f.storePath,stateDirectory:f.state,global:true,heartbeatMs:0,rhythm:{minGapMs:1},
      decide:packet=>{calls.push(packet.stage);return JSON.stringify(response(packet));}});
    await service.observe({source:'qq',key:'private:1',text:'第一条',scene:'qq/private/1',actor:'fixture'});
    await service.observe({source:'qq',key:'private:1:2',text:'第二条',scene:'qq/private/1',actor:'fixture'});
    service.startScheduling(20);
    assert.ok(await until(()=>service.store.subjectInbox({subjectId:'jingyang',pendingOnly:true}).total===0),'pending inbox drained');
    const decisions=[...service.store.all('decision')].filter(d=>d.currentEvent?.id);
    assert.equal(decisions.length,2,'one decision per message, no extra stale call');
    const responses=[...service.store.all('response')];
    assert.ok(responses.length>=1);
    assert.equal(responses.at(-1).scene,'qq/private/1','response must target the current QQ scene, not global');
    assert.ok(calls.length>=2);
    const state=JSON.parse(readFileSync(join(f.state,'scheduler.json'),'utf8'));
    assert.equal(state.scheduler.scenes.length,0,'stale queue item removed');
    assert.equal(service.health().active,null);
  }finally{if(service)await close(service);}
});

test('P0-C: 只有陈旧队列项时清理引用，不调用模型，不永久禁反思',async t=>{
  const f=fixture({stale:true});t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
  let calls=0;let service;
  try{
    service=await startBrainService({storePath:f.storePath,stateDirectory:f.state,global:true,heartbeatMs:0,idleIntervalMs:1,rhythm:{minGapMs:1},
      decide:packet=>{calls++;return JSON.stringify(wait(packet));}});
    assert.equal(service.health().pending.length,0);
    service.startScheduling(20);
    await sleep(80);
    assert.equal(calls,0,'stale item does not create repeated model turns');
    assert.equal(service.store.subjectInbox({subjectId:'jingyang',pendingOnly:true}).total,0);
  }finally{if(service)await close(service);}
});

test('scheduler failures are recorded once per unchanged error and again after cooldown',()=>{
  const seen=[];let now=1_000_000;
  const report=createSchedulerFailureReporter({subjectId:'s',clock:()=>now,recordDiagnostic:value=>{seen.push(value);return {logged:true};}});
  assert.deepEqual(report({code:'SYNTHETIC_FAULT',message:'boom'}),{recorded:true,errorCode:'SYNTHETIC_FAULT'});
  assert.deepEqual(report({code:'SYNTHETIC_FAULT',message:'boom'}),{recorded:false,duplicate:true,errorCode:'SYNTHETIC_FAULT'});
  assert.equal(report({code:'OTHER_FAULT',message:'other'}).recorded,true);
  assert.equal(report({code:'SYNTHETIC_FAULT',message:'boom'}).recorded,false);
  assert.equal(report({code:'OTHER_FAULT',message:'other'}).recorded,false);
  assert.equal(seen.length,2);
  now+=3_600_000;
  assert.equal(report({code:'SYNTHETIC_FAULT',message:'boom'}).recorded,true);
  assert.equal(report({code:'THIRD_FAULT',message:'boom'}).recorded,true);
  assert.equal(seen.length,4);
  assert.equal(seen[0].stage,'scheduler.failed');
  assert.equal(seen[0].data.errorCode,'SYNTHETIC_FAULT');
  assert.equal(seen[0].data.reason,'boom');
  assert.equal(seen[0].context.subjectId,'s');
});

test('a repeated scheduled-tick exception produces one diagnostic, not one per heartbeat',async t=>{
  const f=fixture();t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
  let service,realRead,realDiagnostic;const seen=[];let faults=0;
  try{
    service=await startBrainService({storePath:f.storePath,stateDirectory:f.state,heartbeatMs:0,rhythm:{minGapMs:1},decide:packet=>JSON.stringify(wait(packet))});
    realRead=service.store.read.bind(service.store);realDiagnostic=service.store.recordDiagnostic.bind(service.store);
    service.store.read=(id,rev)=>{if(id===attentionId('jingyang')){faults++;throw Object.assign(new Error('synthetic scheduler fault'),{code:'SYNTHETIC_SCHEDULER_FAULT'});}return realRead(id,rev);};
    service.store.recordDiagnostic=value=>{seen.push(value);return realDiagnostic(value);};
    service.startScheduling(20);
    assert.ok(await until(()=>faults>=3),'the scheduled tick really faulted repeatedly');
    await sleep(40);
    const scheduler=seen.filter(x=>x.stage==='scheduler.failed');
    assert.equal(scheduler.length,1);
    assert.equal(scheduler[0].data.errorCode,'SYNTHETIC_SCHEDULER_FAULT');
    assert.match(scheduler[0].data.reason,/synthetic scheduler fault/);
    assert.equal(service.store.debugHealth().failedWrites,0,'the diagnostic must satisfy the existing metadata contract');
    const archive=new DebugArchive(f.storePath);
    try{const items=archive.journal({limit:200}).items;assert.ok(items.some(x=>x.stage==='scheduler.failed'&&x.data.errorCode==='SYNTHETIC_SCHEDULER_FAULT'));}finally{archive.close();}
  }finally{
    if(service){if(realRead)service.store.read=realRead;if(realDiagnostic)service.store.recordDiagnostic=realDiagnostic;await close(service);}
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {keepAttention} from '../src/attention.mjs';

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

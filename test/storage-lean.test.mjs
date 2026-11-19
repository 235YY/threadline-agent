import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';
import {DatabaseSync} from 'node:sqlite';

process.env.JY_AFFECT_PYTHON ??= 'C:\\Users\\杨耀钧\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const T=1794400000000;
function setup(store,id='w'){
  store.execute({requestId:'seed:'+id,commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成'}}]});
}
function event(store,id='e',body='合成输入'){
  store.execute({requestId:'event:'+id,commands:[{op:'append_event',id,body,origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:T,source:{system:'fixture',key:id}}]});
}
function prepare(session,id='e',now=T){return session.prepare({currentEvent:{id,revision:1},workspace:{id:'w',revision:1},now,budgetBytes:131072,mind:true,unified:true,attention:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});}
function temp(t,name='s.sqlite'){
  const dir=mkdtempSync(join(tmpdir(),'jy-storage-lean-'));t.after(()=>{try{rmSync(dir,{recursive:true,force:true});}catch{}});
  return join(dir,name);
}

test('decision and attempt references reuse one model packet and read hydrates it',t=>{
  const store=new ContinuityStore(temp(t),{hotDecisionPackets:64});t.after(()=>store.close());
  setup(store);event(store);
  const session=new ContinuitySession({store,subjectId:'s',attention:true});
  const packet=prepare(session);
  const clean=value=>JSON.parse(JSON.stringify(value));
  const output=clean(proposal(packet));
  const input=clean(packet);
  const command=id=>({op:'record_decision',id,workspace:{id:'w',revision:1},currentEvent:{id:'e',revision:1},materials:[],input,output,requestKey:'r1',invocationKey:'i1'});
  store.execute({requestId:'d',commands:[command('d1'),command('d2')]});
  store.execute({requestId:'a',commands:[{op:'capture_decision_attempt',id:'d1:attempt',decisionId:'d1',requestKey:'r1',invocationKey:'i1',input,output:{status:'ok'}}]});
  assert.equal(store.debugHealth().modelPackets,1);
  assert.deepEqual(store.read('d1').input,store.read('d2').input);
  assert.equal(store.read('d1').input.packetId,packet.packetId);
  assert.equal(store.read('d1:attempt').input.packetId,packet.packetId);
  assert.equal(store.read('d2').type,'decision');
});

test('only the hot decision window keeps full packet bodies',t=>{
  const store=new ContinuityStore(temp(t),{hotDecisionPackets:8});t.after(()=>store.close());
  setup(store);
  const session=new ContinuitySession({store,subjectId:'s',attention:true});
  for(let i=0;i<40;i++){
    const id='e'+i;event(store,id,'合成输入'+i);
    const packet=prepare(session,id,T+i);
    session.commit({packet,output:proposal(packet),requestId:'d'+i,decisionId:'d'+i});
  }
  const old=store.read('d0'),recent=store.read('d39');
  assert.equal(old.input.packetUnavailable,true);
  assert.equal(old.input.messages,undefined);
  assert.ok(recent.input.messages);
  assert.ok(store.debugHealth().modelPackets<40);
  assert.equal(store.read('d0:attempt',1),null);
  assert.equal(store.read('d0:attempt').status,'adopted');
});

test('terminal affect turns do not retain a duplicate preview snapshot',async t=>{
  const store=new ContinuityStore(':memory:',{hotDecisionPackets:64});t.after(()=>store.close());
  setup(store);
  const session=new AffectSession({store,subjectId:'s',fusion:true,clock:()=>T});
  event(store);
  const packet=await session.prepare({currentEvent:{id:'e',revision:1},workspace:{id:'w',revision:1},now:T,budgetBytes:131072,mind:true,unified:true,attention:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
  const raw=await session.invoke(packet,()=>proposal(packet));
  await session.commit({packet,output:raw,requestId:'a1',decisionId:'a1'});
  const turn=[...store.all('affect_turn')].at(-1);
  assert.equal(turn.preview?.snapshot,undefined);
  assert.ok(turn.preview?.baseHash);
  assert.equal(turn.packet.packetId,packet.packetId);
});

test('debug defaults are bounded and configurable',t=>{
  const store=new ContinuityStore(':memory:');t.after(()=>store.close());
  assert.equal(store.debugHealth().maxPacketBytes,8*1024*1024);
  assert.equal(store.debugHealth().maxEvents,512);
  const custom=new ContinuityStore(':memory:',{maxDebugPacketBytes:1024,maxDebugEvents:3});t.after(()=>custom.close());
  assert.equal(custom.debugHealth().maxPacketBytes,1024);
  assert.equal(custom.debugHealth().maxEvents,3);
});

test('schema 11 is not opened by the new reader without an explicit reviewed upgrade',t=>{
  const path=temp(t,'schema11.sqlite');
  let store=new ContinuityStore(path);setup(store);event(store);store.close();
  const db=new DatabaseSync(path);db.exec('PRAGMA user_version=11');db.close();
  assert.throws(()=>new ContinuityStore(path),e=>e.code==='MIGRATION_REQUIRED');
  const upgraded=new ContinuityStore(path,{migrateV11:true});t.after(()=>upgraded.close());
  assert.equal(upgraded.snapshot().schemaVersion,12);
  assert.equal(upgraded.read('e').type,'event');
  const check=new DatabaseSync(path,{readOnly:true});t.after(()=>check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version,12);
});

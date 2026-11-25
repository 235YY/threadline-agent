import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';
import {prepareDecision,commitDecision,prepareReview,stageReview,adoptReview} from '../src/cognition.mjs';
import {readReaction} from '../src/continuity.mjs';
import {readMindTrace} from '../src/mind-trace.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';
import {event as seedEvent,frame as seedFrame,note as seedNote,put as seedPut,ref as seedRef} from './helpers.mjs';
import {DatabaseSync} from 'node:sqlite';

// Affect-backed cases require a Python 3.10+ worker. Set JY_AFFECT_PYTHON in
// the test environment before importing this file; do not hard-code a local
// Windows path into the repository.
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
function reviewFixture(t,{hot=64}={}){
  const path=temp(t,'review.sqlite'),store=new ContinuityStore(path,{hotDecisionPackets:hot});t.after(()=>store.close());
  const [past,current,feelingSeed,beliefSeed,goalSeed,w]=seedPut(store,'setup',
    seedEvent('past',{scene:'qq:brother',body:'之前一起记住的事'}),
    seedEvent('current',{scene:'qq:brother',body:'现在说的事'}),
    seedNote('feeling',[{id:'past',revision:1}],{kind:'feeling',body:'有点不安'}),
    seedNote('belief',[{id:'past',revision:1}],{kind:'skill',body:'先核对再回答'}),
    seedNote('goal',[],{kind:'dream',body:'把这件事做好'}),seedFrame({id:'w'}));
  const feeling=feelingSeed.record,belief=beliefSeed.record,goal=goalSeed.record;
  const materials=[{ref:seedRef(past),aspect:'experience'},{ref:seedRef(belief),aspect:'belief'},{ref:seedRef(goal),aspect:'goal'}];
  const packet=prepareDecision({store,currentEvent:seedRef(current),workspace:seedRef(w),materials,allowedActionTools:[],budgetBytes:24000});
  const output=proposal(packet);delete output.continuity;
  const decision=commitDecision({store,packet,output,requestId:'d0',decisionId:'d0',allowedActionTools:[]});
  const reviewPacket=prepareReview({store,decision:seedRef(decision),feedbackRefs:[seedRef(current)],materials:[{ref:seedRef(past),aspect:'experience'},{ref:seedRef(belief),aspect:'belief'}],budgetBytes:24000});
  const update={id:'belief',expectedRevision:1,body:'先核对再回答，这次补充了新证据',kind:'skill',change:'new_evidence',confidence:'tentative',status:'current',
    scope:{scenes:[],people:[],validFrom:null,validUntil:null},evidence:[seedRef(past),seedRef(current)]};
  const review=stageReview({store,packet:reviewPacket,output:{packetId:reviewPacket.packetId,disposition:'update',summary:'合成整理',updates:[update],questions:[]},requestId:'stage',reviewId:'review'});
  return {store,path,past,current,belief,w,decision,reviewPacket,review};
}
function waitPacket(session,id,now=T,decisionId='d-'+id){
  const packet=prepare(session,id,now);
  session.commit({packet,output:proposal(packet),requestId:'c:'+decisionId,decisionId});
  return packet;
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

test('task references retain their decision packets beyond the hot window',t=>{
  const store=new ContinuityStore(temp(t),{hotDecisionPackets:2});t.after(()=>store.close());
  setup(store);event(store,'e0');
  const session=new ContinuitySession({store,subjectId:'s',attention:true});
  const packet=prepare(session,'e0');
  session.commit({packet,output:proposal(packet),requestId:'d0',decisionId:'d0'});
  store.execute({requestId:'task',commands:[{op:'put_agent_task',expectedRevision:0,task:{
    format:'agent-task-v1',id:'task:long',goal:'long task',status:'running',stepCount:0,callCount:0,
    observations:[],interrupts:[],originDecisionRef:{id:'d0',revision:1}}}]});
  for(let i=1;i<=10;i++){
    event(store,'task-e'+i,'later'+i);
    const p=prepare(session,'task-e'+i,T+i);
    session.commit({packet:p,output:proposal(p),requestId:'d'+i,decisionId:'d'+i});
  }
  const origin=store.read('d0');
  assert.equal(origin.input.packetUnavailable,undefined);
  assert.ok(origin.input.messages);
  assert.equal(store.read('task:long').originDecisionRef.id,'d0');
  store.execute({requestId:'task-done',commands:[{op:'put_agent_task',expectedRevision:1,task:{
    format:'agent-task-v1',id:'task:long',goal:'long task',status:'done',stepCount:0,callCount:0,
    observations:[],interrupts:[],originDecisionRef:{id:'d0',revision:1}}}]});
  for(let i=11;i<=20;i++){
    event(store,'task-e'+i,'later'+i);
    const p=prepare(session,'task-e'+i,T+i);
    session.commit({packet:p,output:proposal(p),requestId:'d'+i,decisionId:'d'+i});
  }
  assert.equal(store.read('d0').input.packetUnavailable,true);
});

test('blocked tasks keep their origin packet for a possible resume',t=>{
  const store=new ContinuityStore(temp(t),{hotDecisionPackets:2});t.after(()=>store.close());
  setup(store);event(store,'e0');
  const session=new ContinuitySession({store,subjectId:'s',attention:true});
  const packet=prepare(session,'e0');
  session.commit({packet,output:proposal(packet),requestId:'d0',decisionId:'d0'});
  store.execute({requestId:'blocked-task',commands:[{op:'put_agent_task',expectedRevision:0,task:{
    format:'agent-task-v1',id:'task:blocked',goal:'blocked task',status:'blocked',stepCount:0,callCount:0,
    observations:[],interrupts:[],originDecisionRef:{id:'d0',revision:1}}}]});
  for(let i=1;i<=10;i++){
    event(store,'blocked-e'+i,'later'+i);
    const p=prepare(session,'blocked-e'+i,T+i);
    session.commit({packet:p,output:proposal(p),requestId:'d'+i,decisionId:'d'+i});
  }
  const origin=store.read('d0');
  assert.equal(origin.input.packetUnavailable,undefined);
  assert.ok(origin.input.messages);
  assert.equal(store.read('task:blocked').status,'blocked');
  assert.equal(store.read('task:blocked').originDecisionRef.id,'d0');
});

test('terminal affect turns do not retain a duplicate preview snapshot',async t=>{
  const store=new ContinuityStore(':memory:',{hotDecisionPackets:1});t.after(()=>store.close());
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
  for(let i=0;i<32;i++)event(store,'affect-e'+i,'后续输入'+i);
  const kept=store.read(turn.id);
  assert.notEqual(kept.packet.packetUnavailable,true);
  assert.ok(kept.packet.messages);
});

test('terminal affect packets are retained only inside the bounded window',async t=>{
  const store=new ContinuityStore(':memory:',{hotDecisionPackets:0,terminalAffectPackets:0});t.after(()=>store.close());
  setup(store);
  const session=new AffectSession({store,subjectId:'s',fusion:true,clock:()=>T});
  event(store);
  const packet=await session.prepare({currentEvent:{id:'e',revision:1},workspace:{id:'w',revision:1},now:T,budgetBytes:131072,mind:true,unified:true,attention:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
  const raw=await session.invoke(packet,()=>proposal(packet));
  await session.commit({packet,output:raw,requestId:'a-bound',decisionId:'a-bound'});
  const turn=[...store.all('affect_turn')].at(-1);
  assert.equal(store.debugHealth().terminalAffectPackets,0);
  for(let i=0;i<32;i++)event(store,'bound-e'+i,'后续输入'+i);
  const retired=store.read(turn.id);
  assert.equal(retired.packet.packetUnavailable,true);
});

test('debug defaults are bounded and configurable',t=>{
  const store=new ContinuityStore(':memory:');t.after(()=>store.close());
  assert.equal(store.debugHealth().maxPacketBytes,8*1024*1024);
  assert.equal(store.debugHealth().maxEvents,512);
  const custom=new ContinuityStore(':memory:',{maxDebugPacketBytes:1024,maxDebugEvents:3});t.after(()=>custom.close());
  assert.equal(custom.debugHealth().maxPacketBytes,1024);
  assert.equal(custom.debugHealth().maxEvents,3);
});

test('debug packet quota evicts the oldest snapshots instead of stopping',t=>{
  const path=temp(t,'debug-quota.sqlite'),store=new ContinuityStore(path,{maxDebugPacketBytes:900});t.after(()=>store.close());
  const packet=(id,text)=>({packetId:id,stage:'decision',payload:{current:{id:'e',revision:1},workspace:{id:'w',revision:1},continuity:{subject:{id:'s'}}},messages:[{role:'user',content:text}]});
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
  assert.equal(store.captureDebugPacket(packet(a,'a'.repeat(200))),'captured');
  assert.equal(store.captureDebugPacket(packet(b,'b'.repeat(200))),'captured');
  assert.equal(store.captureDebugPacket(packet(c,'c'.repeat(200))),'captured');
  const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());
  const rows=db.prepare('SELECT packet_id,body_bytes FROM debug_packets').all();
  assert.ok(rows.length>=1&&rows.length<=3);
  assert.ok(rows.some(r=>r.packet_id===c));
  assert.ok(!rows.some(r=>r.packet_id===a));
  assert.ok(rows.reduce((sum,r)=>sum+r.body_bytes,0)<=900);
});

test('proposed review packets survive pruning and can still be adopted',t=>{
  const f=reviewFixture(t,{hot:2});
  const session=new ContinuitySession({store:f.store,subjectId:'s',attention:true});
  for(let i=0;i<40;i++){
    event(f.store,'review-e'+i,'后续输入'+i);
    waitPacket(session,'review-e'+i,T+i+1);
  }
  const stored=f.store.read('review');
  assert.equal(stored.input.packetUnavailable,undefined);
  assert.ok(stored.input.messages);
  const adopted=adoptReview({store:f.store,review:seedRef(stored),requestId:'adopt'});
  assert.equal(adopted.status,'adopted');
  assert.equal(f.store.read('belief').revision,2);
});

test('a retired review stub cannot be adopted or written back as content',t=>{
  const f=reviewFixture(t);
  const db=new DatabaseSync(f.path);db.prepare('DELETE FROM model_packets WHERE packet_id=?').run(f.reviewPacket.packetId);db.close();
  const stub=f.store.read('review');
  assert.equal(stub.input.packetUnavailable,true);
  assert.throws(()=>adoptReview({store:f.store,review:seedRef(stub),requestId:'adopt'}),e=>e.code==='MODEL_PACKET_UNAVAILABLE');
  const check=new DatabaseSync(f.path,{readOnly:true});t.after(()=>check.close());
  assert.equal(check.prepare('SELECT count(*) AS n FROM model_packets WHERE packet_id=?').get(f.reviewPacket.packetId).n,0);
});

test('retired decision input degrades reaction and mind-trace without TypeError',t=>{
  const store=new ContinuityStore(temp(t),{hotDecisionPackets:0});t.after(()=>store.close());
  setup(store);event(store,'seed');
  const session=new ContinuitySession({store,subjectId:'s',attention:true});
  waitPacket(session,'seed');
  for(let i=0;i<40;i++)event(store,'old-e'+i,'后续输入'+i);
  const retired=store.read('d-seed');
  assert.equal(retired.input.packetUnavailable,true);
  const reaction=readReaction({store,subjectId:'s',decision:{id:'d-seed',revision:1}});
  assert.equal(reaction.packetUnavailable,true);
  assert.deepEqual(reaction.stateBefore,[]);
  assert.equal(reaction.choice.kind,'unavailable');
  const trace=readMindTrace({store,subjectId:'s',decision:{id:'d-seed',revision:1}});
  assert.equal(trace.packetUnavailable,true);
  assert.deepEqual(trace.accepted,[]);
  assert.ok(trace.limitations.includes('input-snapshot-unavailable'));
});

test('DebugArchive reports snapshot unavailability instead of input corruption',t=>{
  const f=reviewFixture(t);
  const db=new DatabaseSync(f.path);db.prepare('DELETE FROM model_packets WHERE packet_id=?').run(f.decision.input.packetId);db.close();
  const inspection=new DebugArchive(f.path).inspect({decisionId:'d0',includeContent:true});
  const codes=inspection.warnings.map(w=>w.code);
  assert.ok(codes.includes('INPUT_SNAPSHOT_UNAVAILABLE'));
  assert.ok(!codes.includes('INPUT_INTEGRITY_MISMATCH'));
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


test('runtime retention keeps pending fixed packet and expires a closed packet beyond the hot window',t=>{
  const path=temp(t),store=new ContinuityStore(path,{hotDecisionPackets:1});
  const packet=n=>({packetId:n.repeat(64),stage:'test',payload:{current:{id:'fixture-'+n},workspace:{id:'w'}}});
  const aid=id=>'extension:s:runtime:'+id;
  const write=(id,rev,value)=>store.execute({requestId:id+':'+rev,commands:[
    {op:'put_extension_record',id:aid(id),owner:'s',theory:'runtime',stateType:'turn-activity',schemaVersion:'1',expectedRevision:rev,value}]}).at(-1);
  new ContinuitySession({store,subjectId:'s'});
  write('pending',0,{phase:'prepared',packet:packet('a')});
  write('pending',1,{phase:'dispatched',packet:packet('a'),failure:{outcome:'uncertain'}});
  write('closed',0,{phase:'prepared',packet:packet('b')});
  write('closed',1,{phase:'complete'});
  write('more-recent',0,{phase:'prepared',packet:packet('c')});
  write('more-recent',1,{phase:'complete'});
  store.maintainRuntimeStorage();
  assert.deepEqual(store.read(aid('pending'),2).value.packet,packet('a'));
  assert.equal(store.read(aid('closed'),1).value.packet.packetUnavailable,true);
  assert.deepEqual(store.read(aid('more-recent'),1).value.packet,packet('c'));
  store.close();
  const restarted=new ContinuityStore(path);
  t.after(()=>restarted.close());
  assert.deepEqual(restarted.read(aid('pending'),2).value.packet,packet('a'));
});


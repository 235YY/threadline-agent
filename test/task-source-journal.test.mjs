// Phase 3.2 task-source journal primitives (R1/R2/R4 only; R3 second-paid retry blocked).
// These tests cover the journal-owned contract that the operator/driver integration
// (server/turn-driver/continuity, Lead) relies on. No model, no network, no production DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RequestJournal} from '../src/request-journal.mjs';
import {digest, canonical} from '../src/contracts.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const TASK={subject:'s',taskId:'task:1',step:0};
const PID='a'.repeat(64);
const ROW_SOURCE={subject:'s',kind:'task',taskId:'task:1',step:0};

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'jy-task-source-journal-'));
  const path=join(dir,'requests.json');
  const journal=new RequestJournal(path);
  t.after(()=>{try{journal.close();}catch{}try{rmSync(dir,{recursive:true,force:true});}catch{}});
  return {dir,path,journal};
}
function settleTaskPacket(journal,{source=TASK,packetId=PID,id='turn:task-1',fingerprint='f'.repeat(64),output='{"packetId":"'+PID+'","options":[]}'}={}){
  const taskSource=journal.taskSource(source);
  journal.reserve(id,fingerprint,10,{source:taskSource,packetId});
  journal.dispatch(id);
  journal.settle(id,{upperMicros:10});
  if(output!==null)journal.attachOutput(id,output);
  return {source:taskSource,packetId,id,fingerprint};
}
const code=expected=>error=>error?.code===expected;

test('task source identity is canonical and validated',t=>{
  const {journal}=fixture(t);
  assert.deepEqual(journal.taskSource({subject:'s',taskId:'task:1',step:0}),ROW_SOURCE);
  assert.deepEqual(journal.taskSource({subject:'s',taskId:'task:1',step:0}),journal.taskSource({step:0,taskId:'task:1',subject:'s'}));
  for(const bad of [{subject:'',taskId:'task:1',step:0},{subject:'s',taskId:'',step:0},{subject:'s',taskId:'task:1',step:-1},{subject:'s',taskId:'task:1',step:1.5},null])
    assert.throws(()=>journal.taskSource(bad),code('REQUEST_SOURCE'));
  const view=journal.inspectTaskSource(ROW_SOURCE);
  assert.equal(view.format,'jingyang-task-source-view-v1');
  assert.equal(view.journal,null);
  assert.equal(view.blocked,false);
  assert.equal(view.captureEvidencePresent,false);
  assert.throws(()=>journal.taskSourceRow({subject:'s',kind:'event',event:{id:'e',revision:1}}),code('REQUEST_SOURCE'));
});

test('R1/R2 capture adoption requires the exact settled, unrejected, output-bearing packet',t=>{
  const {journal}=fixture(t);
  const {packetId}=settleTaskPacket(journal);
  const adopted=journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:true});
  assert.equal(adopted.format,'jingyang-task-capture-v1');
  assert.equal(adopted.alreadyAccepted,false);
  assert.equal(adopted.row.status,'settled');
  assert.equal(adopted.row.outputHash,digest('{"packetId":"'+PID+'","options":[]}'));
  assert.equal(journal.inspectTaskSource(ROW_SOURCE,{packetId}).captureEvidencePresent,true);
  assert.equal(journal.blocks(ROW_SOURCE),true,'unvalidated settled row still blocks the source');
  // The integration commits the captured proposal, then records adoption (R1/R2).
  journal.recordValidation(packetId,{status:'accepted',decision:{id:'task-decision:1',revision:1}});
  const replay=journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:true});
  assert.equal(replay.alreadyAccepted,true);
  assert.equal(journal.blocks(ROW_SOURCE),false);
  // Same-value replay is idempotent; a different adoption fact is refused.
  journal.recordValidation(packetId,{status:'accepted',decision:{id:'task-decision:1',revision:1}});
  assert.throws(()=>journal.recordValidation(packetId,{status:'rejected',error:'X'}),code('REQUEST_VALIDATION_CONFLICT'));
});

test('CAPTURE_STALE_REFS: changed subject/frame refs must never adopt and must not mutate the row',t=>{
  const {journal}=fixture(t);
  const {packetId}=settleTaskPacket(journal);
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:false}),code('CAPTURE_STALE_REFS'));
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE}),code('CAPTURE_STALE_REFS'));
  const row=journal.packetRequest(packetId);
  assert.equal(row.validation??null,null,'stale refusal must not record adoption');
  assert.equal(row.status,'settled');
  assert.equal(journal.blocks(ROW_SOURCE),true);
  // A later operator path can still read the evidence without adopting.
  const evidence=journal.taskSourceEvidence(ROW_SOURCE,{packetId,reason:'stale refs'});
  assert.equal(evidence.journal.status,'settled');
  assert.equal(evidence.journal.outputHash,row.output?digest(row.output):null);
});

test('negative capture states are typed and leave the journal unchanged',t=>{
  const {journal}=fixture(t);
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId:PID,source:ROW_SOURCE,refsUnchanged:true}),code('TASK_CAPTURE_NOT_REGISTERED'));
  // Dispatched but not settled.
  journal.reserve('turn:task-pending','f'.repeat(64),10,{source:journal.taskSource(TASK),packetId:PID});
  journal.dispatch('turn:task-pending');
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId:PID,source:ROW_SOURCE,refsUnchanged:true}),code('TASK_CAPTURE_NOT_SETTLED'));
  journal.settle('turn:task-pending',{upperMicros:10});
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId:PID,source:ROW_SOURCE,refsUnchanged:true}),code('TASK_CAPTURE_OUTPUT_MISSING'));
  journal.attachOutput('turn:task-pending','{"packetId":"'+PID+'"}');
  journal.recordValidation(PID,{status:'rejected',error:'INVALID_CHOICE'});
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId:PID,source:ROW_SOURCE,refsUnchanged:true}),code('TASK_CAPTURE_REJECTED'));
  // Other task source cannot see this packet.
  const other={subject:'s',kind:'task',taskId:'task:2',step:0};
  assert.throws(()=>journal.assertTaskCaptureAdoptable({packetId:PID,source:other,refsUnchanged:true}),code('TASK_CAPTURE_NOT_REGISTERED'));
  // Event-source rows are not addressable as task captures.
  journal.reserve('turn:ev','e'.repeat(64),10,{source:{subject:'s',kind:'event',event:{id:'ev1',revision:1}},packetId:'b'.repeat(64)});
  assert.throws(()=>journal.taskSourceRow({subject:'s',kind:'event',event:{id:'ev1',revision:1}}),code('REQUEST_SOURCE'));
});

test('capture adoption survives journal restart; accepted state persists',t=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-task-source-restart-'));
  const path=join(dir,'requests.json');
  let journal=new RequestJournal(path);
  try{
    const {packetId}=settleTaskPacket(journal);
    journal.close();
    journal=new RequestJournal(path);
    const adopted=journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:true});
    assert.equal(adopted.alreadyAccepted,false);
    journal.recordValidation(packetId,{status:'accepted',decision:{id:'d',revision:1}});
    journal.close();
    journal=new RequestJournal(path);
    assert.equal(journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:true}).alreadyAccepted,true);
    assert.equal(journal.blocks(ROW_SOURCE),false);
  }finally{try{journal.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('R4 operator close evidence is deterministic, read-only and never adopts',t=>{
  const {journal,path}=fixture(t);
  const empty=journal.taskSourceEvidence(ROW_SOURCE,{reason:'no-row close'});
  assert.equal(empty.format,'jingyang-task-source-evidence-v1');
  assert.equal(empty.journal,null);
  assert.match(empty.evidenceHash,/^[a-f0-9]{64}$/);
  assert.equal(journal.taskSourceEvidence(ROW_SOURCE,{reason:'no-row close'}).evidenceHash,empty.evidenceHash);
  const {packetId}=settleTaskPacket(journal);
  const before=readFileSync(path,'utf8'),beforeData=canonical(journal.data);
  const evidence=journal.taskSourceEvidence(ROW_SOURCE,{packetId,reason:'operator close'});
  assert.equal(evidence.journal.status,'settled');
  assert.equal(evidence.journal.fingerprint,'f'.repeat(64));
  assert.match(evidence.evidenceHash,/^[a-f0-9]{64}$/);
  assert.equal(evidence.blocked,true);
  // Close is a task-side decision; the journal fact (and file) stays untouched.
  assert.equal(canonical(journal.data),beforeData,'taskSourceEvidence is read-only');
  assert.equal(readFileSync(path,'utf8'),before,'task-source helpers never rewrite the journal');
  assert.equal(journal.packetRequest(packetId).validation??null,null);
});

test('R3 second-paid task retry stays blocked in the journal',t=>{
  const {journal}=fixture(t);
  const {source,packetId,id}=settleTaskPacket(journal);
  // No task authorizeRetry: even full capacity-style evidence is refused.
  assert.throws(()=>journal.authorizeRetry(id,{evidence:{requestId:id,capacityReleased:true,operator:'op'}}),code('REQUEST_SOURCE'));
  assert.equal(journal.find(id).retryAuthorization,undefined);
  assert.equal(journal.blocks(source),true);
  assert.throws(()=>journal.authorizeRetry(id,{evidence:{requestId:id,capacityReleased:true,operator:'op',kind:'task-source-retry'}}),code('REQUEST_SOURCE'));
  // Task readmission is blocked even if a task row is released by crash-reopen.
  const task2={subject:'s',taskId:'task:released',step:0};
  journal.reserve('turn:task-released','d'.repeat(64),10,{source:journal.taskSource(task2),packetId:'c'.repeat(64)});
  journal.close();
  const reopened=new RequestJournal(journal.path);
  try{
    assert.equal(reopened.find('turn:task-released').status,'released');
    assert.throws(()=>reopened.readmit('turn:task-released',{evidence:{requestId:'turn:task-released'},verify:()=>true}),code('REQUEST_SOURCE'));
    assert.equal(reopened.find('turn:task-released').status,'released');
  }finally{reopened.close();}
  void packetId;
});

function settleEventPacket(journal,{packetId='e'.repeat(64),id='turn:ev1',eventId='ev1'}={}){
  const source={subject:'s',kind:'event',event:{id:eventId,revision:1}};
  journal.reserve(id,'a'.repeat(64),10,{source,packetId});
  journal.dispatch(id);
  journal.settle(id,{upperMicros:10});
  journal.attachOutput(id,'{"packetId":"'+packetId+'"}');
  return {source,packetId,id};
}
const retryEvidence=id=>({requestId:id,capacityReleased:true,operator:'op',reason:'capacity released synthetic'});

test('retry authorization records evidenceHash; inspectRetry is read-only',t=>{
  const {journal,path}=fixture(t);
  const {id}=settleEventPacket(journal);
  const before=readFileSync(path,'utf8');
  const view0=journal.inspectRetry(id);
  assert.equal(view0.format,'jingyang-request-retry-view-v1');
  assert.equal(view0.authorized,false);
  assert.equal(readFileSync(path,'utf8'),before,'inspectRetry never writes');
  const evidence=retryEvidence(id);
  const first=journal.authorizeRetry(id,{evidence});
  assert.equal(first.alreadyAuthorized,false);
  assert.equal(first.evidenceHash,digest(evidence));
  assert.equal(journal.find(id).retryAuthorization.evidenceHash,first.evidenceHash);
  const view1=journal.inspectRetry(id);
  assert.equal(view1.authorized,true);
  assert.equal(view1.evidenceHash,first.evidenceHash);
  // Same evidence replay is idempotent (no new save, same recordedAt).
  const recordedAt=journal.find(id).retryAuthorization.recordedAt;
  const second=journal.authorizeRetry(id,{evidence});
  assert.equal(second.alreadyAuthorized,true);
  assert.equal(journal.find(id).retryAuthorization.recordedAt,recordedAt);
});

test('compensation: failed requeue leaves no usable authorization and re-blocks the source',t=>{
  const {journal}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  assert.equal(journal.blocks(source),true);
  // Buggy order reproduced: authorization is written before the store requeue.
  const authorization=journal.authorizeRetry(id,{evidence:retryEvidence(id)});
  assert.equal(journal.blocks(source),false,'authorization alone unblocks the source');
  // The requeue then throws REQUEUE_STATE (inbox handled) in the server layer;
  // compensation revokes exactly the authorization it recorded.
  const revoked=journal.revokeRetry(id,{expectedEvidenceHash:authorization.evidenceHash,reason:'REQUEUE_STATE'});
  assert.equal(revoked.revoked,true);
  assert.equal(journal.find(id).retryAuthorization,undefined,'no stale usable authorization');
  assert.equal(journal.inspectRetry(id).authorized,false);
  assert.equal(journal.blocks(source),true,'source is blocked again (no false unblock)');
  // Idempotent compensation: a second revoke is a no-op and does not rewrite.
  const again=journal.revokeRetry(id,{expectedEvidenceHash:authorization.evidenceHash,reason:'REQUEUE_STATE'});
  assert.equal(again.revoked,false);
  assert.equal(again.reason,'not-authorized');
  assert.equal(journal.find(id).retryAuthorization,undefined);
  // The revocation is an audit fact on the same JSON row, not a new table/format.
  assert.equal(journal.find(id).retryRevocation.evidenceHash,authorization.evidenceHash);
});

test('revoke is evidence-hash scoped and cannot clear a newer authorization',t=>{
  const {journal}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  const first=journal.authorizeRetry(id,{evidence:{...retryEvidence(id),capacity:{used:{residences:1},max:{residences:2}}}});
  const second=journal.authorizeRetry(id,{evidence:{...retryEvidence(id),capacity:{used:{residences:0},max:{residences:2}}}});
  assert.equal(second.alreadyAuthorized,false);
  assert.notEqual(second.evidenceHash,first.evidenceHash);
  const stale=journal.revokeRetry(id,{expectedEvidenceHash:first.evidenceHash,reason:'stale compensation'});
  assert.equal(stale.revoked,false);
  assert.equal(stale.reason,'evidence-mismatch');
  assert.equal(journal.find(id).retryAuthorization.evidenceHash,second.evidenceHash,'newer authorization retained');
  assert.equal(journal.blocks(source),false);
  const current=journal.revokeRetry(id,{expectedEvidenceHash:second.evidenceHash,reason:'current compensation'});
  assert.equal(current.revoked,true);
  assert.equal(journal.blocks(source),true);
  // A fresh operator decision can authorize again after compensation.
  const renewed=journal.authorizeRetry(id,{evidence:retryEvidence(id)});
  assert.equal(renewed.alreadyAuthorized,false);
  assert.equal(journal.blocks(source),false);
  void id;
});

test('event-source capacity requeue and event readmit are unchanged',t=>{
  const {journal}=fixture(t);
  const eventSource={subject:'s',kind:'event',event:{id:'ev1',revision:1}};
  journal.reserve('turn:ev1','a'.repeat(64),10,{source:eventSource,packetId:'e'.repeat(64)});
  journal.dispatch('turn:ev1');journal.settle('turn:ev1',{upperMicros:10});journal.attachOutput('turn:ev1','{}');
  journal.authorizeRetry('turn:ev1',{evidence:{requestId:'turn:ev1',capacityReleased:true,operator:'op'}});
  assert.equal(journal.blocks(eventSource),false);
  journal.close();
  const reopened=new RequestJournal(journal.path);
  try{
    reopened.reserve('turn:ev2','b'.repeat(64),10,{source:{subject:'s',kind:'event',event:{id:'ev2',revision:1}},packetId:'f'.repeat(64)});
    reopened.close();
    const third=new RequestJournal(reopened.path);
    try{
      assert.equal(third.find('turn:ev2').status,'released');
      const read=third.readmit('turn:ev2',{evidence:{requestId:'turn:ev2',approval:'reviewed'},verify:()=>true});
      assert.equal(read.status,'reserved');
      assert.equal(read.attempts.length,1);
    }finally{third.close();}
  }finally{try{reopened.close();}catch{}}
});

test('no new table/schema or row fields: journal remains format v1 and helpers are read-only',t=>{
  const {journal,path}=fixture(t);
  const keys=Object.keys(journal.data).sort();
  assert.deepEqual(keys,['format','requests']);
  assert.equal(journal.data.format,'jingyang-request-journal-v1');
  const {packetId,id}=settleTaskPacket(journal);
  const rowKeys=Object.keys(journal.find(id)).sort();
  journal.inspectTaskSource(ROW_SOURCE,{packetId});
  journal.assertTaskCaptureAdoptable({packetId,source:ROW_SOURCE,refsUnchanged:true});
  journal.taskSourceEvidence(ROW_SOURCE,{packetId,reason:'close'});
  assert.deepEqual(Object.keys(journal.find(id)).sort(),rowKeys,'task-source helpers add no row fields');
  assert.deepEqual(Object.keys(journal.data).sort(),['format','requests']);
  // The journal never touches the SQLite schema; it is a single atomic JSON file.
  const source=readFileSync(join(HERE,'..','src','request-journal.mjs'),'utf8');
  assert.doesNotMatch(source,/node:sqlite|Database|CREATE TABLE/);
  assert.ok(readFileSync(path,'utf8').startsWith('{'));
});

// Save-fault rollback (F-IR01-3): an in-memory authorization must never outlive a
// failed durable write, and a failed compensation must not silently drop the auth.
function failNextSave(journal){
  const original=journal.save.bind(journal);let failed=false;
  journal.save=()=>{if(!failed){failed=true;journal.poisoned=true;throw Object.assign(Error('synthetic journal save fault'),{code:'EIO'});}return original();};
  return ()=>{journal.save=original;journal.poisoned=false;};
}
test('authorizeRetry save fault rolls back the in-memory authorization and keeps the source blocked',t=>{
  const {journal,path}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  const restore=failNextSave(journal);
  try{assert.throws(()=>journal.authorizeRetry(id,{evidence:retryEvidence(id)}),e=>e.code==='EIO');}
  finally{restore();}
  assert.equal(journal.find(id).retryAuthorization,undefined,'failed save must not leave an in-memory authorization');
  assert.equal(journal.inspectRetry(id).authorized,false);
  assert.equal(journal.blocks(source),true,'source still blocked after the failed write');
  // The same instance can authorize again once persistence is available.
  const authorized=journal.authorizeRetry(id,{evidence:retryEvidence(id)});
  assert.equal(journal.find(id).retryAuthorization.evidenceHash,authorized.evidenceHash);
  assert.equal(journal.blocks(source),false);
  assert.ok(readFileSync(path,'utf8').includes(authorized.evidenceHash));
});

test('authorizeRetry replacement save fault keeps the previous authorization',t=>{
  const {journal}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  const first=journal.authorizeRetry(id,{evidence:{...retryEvidence(id),capacity:{used:{residences:1},max:{residences:2}}}});
  const restore=failNextSave(journal);
  try{
    assert.throws(()=>journal.authorizeRetry(id,{evidence:{...retryEvidence(id),capacity:{used:{residences:0},max:{residences:2}}}}),e=>e.code==='EIO');
  }finally{restore();}
  assert.equal(journal.find(id).retryAuthorization.evidenceHash,first.evidenceHash,'previous durable authorization restored');
  assert.equal(journal.inspectRetry(id).authorized,true);
  assert.equal(journal.blocks(source),false);
});

test('revokeRetry save fault keeps the authorization and adds no revocation audit',t=>{
  const {journal}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  const authorized=journal.authorizeRetry(id,{evidence:retryEvidence(id)});
  const restore=failNextSave(journal);
  try{assert.throws(()=>journal.revokeRetry(id,{expectedEvidenceHash:authorized.evidenceHash,reason:'save fault'}),e=>e.code==='EIO');}
  finally{restore();}
  assert.equal(journal.find(id).retryAuthorization.evidenceHash,authorized.evidenceHash);
  assert.equal(Object.hasOwn(journal.find(id),'retryRevocation'),false,'no audit fact without a durable revocation');
  assert.equal(journal.blocks(source),false);
  assert.equal(journal.revokeRetry(id,{expectedEvidenceHash:authorized.evidenceHash,reason:'retry'}).revoked,true);
  assert.equal(journal.blocks(source),true);
});

test('save fault leaves memory and a fresh journal read in agreement (no authorized-vs-unauthorized split)',t=>{
  const {journal,path}=fixture(t);
  const {source,id}=settleEventPacket(journal);
  const restore=failNextSave(journal);
  try{assert.throws(()=>journal.authorizeRetry(id,{evidence:retryEvidence(id)}),e=>e.code==='EIO');}
  finally{restore();}
  assert.equal(journal.inspectRetry(id).authorized,false,'in-memory view after failed save');
  journal.close();
  const reopened=new RequestJournal(path);
  try{
    assert.equal(reopened.find(id).retryAuthorization,undefined,'durable view has no authorization');
    assert.equal(reopened.blocks(source),true,'durable view still blocks the source');
    assert.equal(reopened.inspectRetry(id).authorized,false);
  }finally{reopened.close();}
});

// ---------------------------------------------------------------------------
// IR-01 requeue-event route seam (Lead-integrated server order): read-only inbox
// preflight -> store requeue -> journal authorizeRetry, with fail_subject_event
// compensation. These tests pin the journal invariants the route must preserve;
// test-engineer's operator matrix covers the broader surface.
async function routeFixture(t,{eventId='ev-ir01'}={}){
  const dir=mkdtempSync(join(tmpdir(),'jy-ir01-route-'));
  const journal=new RequestJournal(join(dir,'requests.json'));
  const state={calls:0,plan:()=>{throw Object.assign(Error('model must not be called by the requeue route'),{code:'PROBE_MODEL_CALL'});}};
  const decide=p=>{state.calls++;return state.plan(p);};
  decide.requestJournal=journal;
  const service=await startBrainService({port:0,token:'brain-token',storePath:':memory:',heartbeatMs:0,global:true,
    shutdownControl:{token:'op-token',stop:async()=>{}},decide,allowedActionTools:[]});
  t.after(async()=>{try{await new Promise(r=>service.server.close(r));}catch{}try{service.close();}catch{}try{journal.close();}catch{}try{rmSync(dir,{recursive:true,force:true});}catch{}});
  const store=service.store;
  store.execute({requestId:'seed:'+eventId,commands:[
    {op:'append_event',id:eventId,body:'synthetic capacity source',origin:'reported',actor:'u',scene:'synthetic',source:{system:'probe',key:eventId},occurredAt:1},
    {op:'admit_subject_event',subjectId:'jingyang',event:{id:eventId,revision:1}}]});
  const source={subject:'jingyang',kind:'event',event:{id:eventId,revision:1}};
  const row=()=>{const id='turn:'+eventId;if(!journal.tryFind(id)){journal.reserve(id,'f'.repeat(64),10,{source,packetId:'p'.repeat(64)});journal.dispatch(id);journal.settle(id,{upperMicros:10});journal.attachOutput(id,'{"packetId":"p"}');}return journal.find(id);};
  const post=async body=>{const res=await fetch(service.url+'/v1/recovery/requeue-event',{method:'POST',
    headers:{'content-type':'application/json','x-brain-token':'brain-token','x-jingyang-control':'op-token'},body:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};};
  return {service,store,journal,source,row,post,eventId,state};
}

const requeuedReply=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'补偿后重入'}}],
  selected:'r',summary:'IR-01d dispatch',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',
    attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});

test('IR-01 handled inbox -> 400 REQUEUE_STATE, no retryAuthorization, source still blocks',async t=>{
  const f=await routeFixture(t);
  f.store.execute({requestId:'handled',commands:[{op:'retire_subject_events',subjectId:'jingyang',eventIds:[f.eventId]}]});
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'handled');
  const row=f.row(),rowsBefore=Object.keys(f.journal.data.requests).length;
  const refused=await f.post({eventId:f.eventId,reason:'handled source requeue'});
  assert.equal(refused.status,400);
  assert.equal(refused.body.error,'REQUEUE_STATE');
  assert.equal(row.retryAuthorization,undefined,'no retry authorization on a refused requeue');
  assert.equal(f.journal.blocks(f.source),true,'source must remain blocked');
  assert.equal(Object.keys(f.journal.data.requests).length,rowsBefore,'no journal row added');
  assert.equal(row.status,'settled');
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'handled','inbox keeps handled state');
});

test('IR-01 requeue succeeds then authorization fails -> compensation restores deferred inbox, no usable auth',async t=>{
  const f=await routeFixture(t,{eventId:'ev-ir01-compensate'});
  f.store.execute({requestId:'defer',commands:[{op:'fail_subject_event',subject:{id:'jingyang',revision:f.store.read('jingyang').revision},
    event:{id:f.eventId,revision:1},reason:'FOREGROUND_CAPACITY'}]});
  const row=f.row(),rowsBefore=Object.keys(f.journal.data.requests).length;
  const original=f.journal.authorizeRetry.bind(f.journal);
  f.journal.authorizeRetry=()=>{throw Object.assign(Error('synthetic authorize failure'),{code:'SYNTHETIC_AUTH_FAIL'});};
  let refused;
  try{refused=await f.post({eventId:f.eventId,reason:'compensation probe'});}
  finally{f.journal.authorizeRetry=original;}
  assert.equal(refused.status,400);
  const observation=f.store.subjectObservation('jingyang',f.eventId);
  assert.equal(observation.status,'deferred','compensation restores the deferred inbox');
  assert.ok(String(observation.decisionId??'').startsWith('input-failure:'),'deferred keeps the input-failure marker');
  assert.equal(row.retryAuthorization,undefined,'no usable authorization after compensation');
  assert.equal(f.journal.blocks(f.source),true,'source blocked again');
  assert.equal(Object.keys(f.journal.data.requests).length,rowsBefore,'no journal row added');
  // A later retry of the route is safe because the preflight accepts deferred.
  const retried=await f.post({eventId:f.eventId,reason:'retry after compensation'});
  assert.equal(retried.status,200);
  assert.equal(f.journal.blocks(f.source),false);
});

test('IR-01 success returns the journal evidenceHash and replay is idempotent',async t=>{
  const f=await routeFixture(t,{eventId:'ev-ir01-success'});
  f.store.execute({requestId:'defer',commands:[{op:'fail_subject_event',subject:{id:'jingyang',revision:f.store.read('jingyang').revision},
    event:{id:f.eventId,revision:1},reason:'FOREGROUND_CAPACITY'}]});
  const row=f.row(),rowsBefore=Object.keys(f.journal.data.requests).length;
  const ok=await f.post({eventId:f.eventId,reason:'capacity released'});
  assert.equal(ok.status,200);
  assert.match(ok.body.evidenceHash,/^[a-f0-9]{64}$/);
  assert.equal(row.retryAuthorization.evidenceHash,ok.body.evidenceHash,'response hash binds the journal authorization');
  assert.equal(f.journal.blocks(f.source),false);
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'received');
  const replay=await f.post({eventId:f.eventId,reason:'capacity released'});
  assert.equal(replay.status,200);
  assert.equal(replay.body.evidenceHash,ok.body.evidenceHash,'same evidence replay is idempotent');
  assert.equal(Object.keys(f.journal.data.requests).length,rowsBefore,'no journal row added by replay');
  assert.equal((row.attempts??[]).length,0,'no readmit attempt created');
  assert.equal(row.validation??null,null,'requeue never adopts the output');
});

test('IR-01d compensation then IDENTICAL retry requeues and dispatches exactly once',async t=>{
  const f=await routeFixture(t,{eventId:'ev-ir01d'});
  f.store.execute({requestId:'defer',commands:[{op:'fail_subject_event',subject:{id:'jingyang',revision:f.store.read('jingyang').revision},
    event:{id:f.eventId,revision:1},reason:'FOREGROUND_CAPACITY'}]});
  const row=f.row(),body={eventId:f.eventId,reason:'identical retry after compensation'};
  // First attempt: store requeue succeeds, journal authorization fails, route compensates deferred.
  const original=f.journal.authorizeRetry.bind(f.journal);
  f.journal.authorizeRetry=()=>{throw Object.assign(Error('synthetic authorize failure'),{code:'SYNTHETIC_AUTH_FAIL'});};
  let refused;
  try{refused=await f.post(body);}
  finally{f.journal.authorizeRetry=original;}
  assert.equal(refused.status,400);
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'deferred');
  assert.equal(row.retryAuthorization,undefined);
  assert.equal(f.journal.blocks(f.source),true);
  // Identical body: the store requeue must actually re-apply (unique requestId),
  // not replay the first requeue+compensation sequence.
  const callsBefore=f.state.calls;
  const retried=await f.post(body);
  assert.equal(retried.status,200);
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'received','identical retry must really requeue the inbox');
  assert.equal(retried.body.observation.status,'received','response observation is the live requeue, not a stale replay');
  assert.equal(row.retryAuthorization.evidenceHash,retried.body.evidenceHash);
  assert.equal(f.journal.blocks(f.source),false);
  // The authorized source is dispatched exactly once, with no automatic re-send.
  f.state.plan=requeuedReply;
  const turn=await f.service.turn();
  assert.equal(turn.ok,true);
  assert.equal(f.state.calls,callsBefore+1,'exactly one model call for the authorized dispatch');
  assert.equal(f.store.subjectObservation('jingyang',f.eventId).status,'handled');
  const callsAfter=f.state.calls;
  await f.service.turn();
  assert.equal(f.state.calls,callsAfter,'no automatic re-send after the authorized dispatch');
  const after=await f.post(body);
  assert.equal(after.status,400);
  assert.equal(after.body.error,'REQUEUE_STATE','handled source cannot be requeued again');
});


import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {admitSubjectEvent} from '../src/continuity.mjs';
import {ContinuityStore} from '../src/store.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {findDecayCandidates,findTraitClusters,findTraitsNeedingReview,gatherConsolidationContext,
  readWatermark,runSlowBrainConsolidation,shouldAutoDream} from '../src/slow-brain.mjs';
import {disk,event,fixtureJournal,memory,modelJSON,note,put,ref} from './helpers.mjs';

const now=Date.parse('2026-11-23T15:55:00Z'), subjectId='slow-fixture',local='local/chat';
const scope=(validFrom=null,validUntil=null)=>({scenes:[local],people:[],validFrom,validUntil});
const content=init=>JSON.parse(JSON.parse(init.body).messages[1].content);
function world(t,path=null){
  const {store,setTime}=path?{store:new ContinuityStore(path,{clock:()=>now}),setTime:()=>{}}:memory(t);
  new ContinuitySession({store,subjectId,attention:true});
  setTime(now);
  const add=(id,body='一段已有来源的经历。',occurredAt=now,origin='observed',admitted=true)=>{
    const [saved]=put(store,'fixture:'+id,event(id,{body,occurredAt,origin,scene:local}));
    if(admitted)admitSubjectEvent({store,subjectId,event:ref(saved),requestId:'admit:'+id});
    return saved;
  };
  const run=options=>runSlowBrainConsolidation({store,subjectId,now,...options});
  return {store,setTime,add,run};
}
const journalAndProvider=(t,callback)=>({journal:fixtureJournal(t),live:true,apiKey:'synthetic',
  fetchImpl:async(_url,init)=>callback(content(init))});

test('incremental batches keep equal-time and late arrivals and do not consume from an offline diary',async t=>{
  const {store,add,run}=world(t);
  for(let i=0;i<26;i++)add('evt-'+i);
  add('not-admitted','禁止交付',now,'observed',false);
  add('tool-receipt','不该进入慢脑',now,'tool_receipt');
  await run({fetchImpl:()=>assert.fail('offline work cannot call the provider')});
  assert.equal(readWatermark(store).eventSeq,0);
  const stages=[];
  const transport=journalAndProvider(t,input=>{
    if(input.atoms)return modelJSON({decisions:[]});
    stages.push(input.recentEvents);
    return modelJSON({atoms:[]});
  });
  await run(transport);
  assert.equal(stages[0].length,24);
  add('late','一条迟到的经历。',now-86_400_000);
  await run(transport);
  assert.equal(stages[1].length,3);
  assert.match(stages[1][2].body,/迟到/);
  assert.equal(readWatermark(store).runs,2);
  assert.equal(gatherConsolidationContext({store,subjectId,now}).recentEvents.length,0);
  assert.equal(store.search({terms:['eventSeq']}).total,0);
  assert.ok(!store.memoryEmbeddingChanges({subjectId,limit:100}).some(row=>row.id==='note:slow-watermark'));
});

test('Auto-Dream counts one local night across midnight, persists a failed attempt and never replays UNKNOWN',async t=>{
  const path=disk(t),{store,add,run}=world(t,path);
  t.after(()=>store.close());
  for(let i=0;i<3;i++)add('pre-'+i);
  assert.equal(shouldAutoDream({store,subjectId,now}).reason,'too-few-new-events');
  add('fourth');
  assert.equal(shouldAutoDream({store,subjectId,now:now-6*3_600_000}).due,false);
  const gate=shouldAutoDream({store,subjectId,now});
  assert.equal(gate.due,true);
  assert.equal(gate.day,'2026-11-23');
  let calls=0;
  const transport=journalAndProvider(t,()=>{calls++;return modelJSON({atoms:[]},{includeUsage:false});});
  await assert.rejects(run({...transport,automatic:true}),{code:'SLOW_USAGE_UNKNOWN'});
  assert.equal(readWatermark(store).eventSeq,0);
  assert.equal(readWatermark(store).lastDreamDay,'2026-11-23');
  const afterMidnight=now+10*60_000;
  assert.equal(shouldAutoDream({store,subjectId,now:afterMidnight}).reason,'already-dreamed-today');
  assert.equal((await run({...transport,now:afterMidnight,automatic:true})).skipped,true);
  const journalPath=transport.journal.path;
  transport.journal.close();
  store.close();
  const reopened=new ContinuityStore(path,{clock:()=>now}),journal=new RequestJournal(journalPath);
  try{
    assert.equal(shouldAutoDream({store:reopened,subjectId,now:afterMidnight}).reason,'already-dreamed-today');
    await assert.rejects(runSlowBrainConsolidation({...transport,store:reopened,journal,subjectId,now}),{code:'SLOW_REQUEST_BLOCKED'});
  }finally{journal.close();reopened.close();}
  assert.equal(calls,1);
});

test('SUPERSEDE keeps old source and scope, and commits replacement, link and watermark together',async t=>{
  const {store,add,run}=world(t);
  const first=add('old-source','港口核验会议安排在周三。',now-100);
  add('new-source','港口核验会议改到周五。');
  put(store,'old-note',note('old-note',[ref(first)],{body:first.body,scope:scope(now)}));
  let calls=0;
  const transport=journalAndProvider(t,input=>{
    calls++;
    if(!input.atoms)return modelJSON({atoms:[{id:'A1',body:'港口核验会议改到周五。',evidence:['E2']}]});
    const old=input.candidateNotes.find(n=>n.body===first.body);
    assert.ok(old);
    return modelJSON({decisions:[{atomId:'A1',op:'SUPERSEDE',target:old.handle}]});
  });
  const execute=store.execute.bind(store);
  store.execute=command=>command.commands.some(c=>c.op==='write_link')
    ?execute({...command,commands:[...command.commands,{op:'write_link',id:'failure-fixture',expectedRevision:0,
      from:{id:'missing-source',revision:1},to:{id:'old-note',revision:2},relation:'related'}]})
    :execute(command);
  await assert.rejects(run(transport));
  assert.equal(store.read('old-note').revision,1);
  assert.equal(readWatermark(store).eventSeq,0);
  assert.equal([...store.all('link')].length,0);
  store.execute=execute;
  const result=await run(transport);
  assert.equal(calls,2,'reuse the two paid-equivalent outputs, with no second dispatch');
  assert.equal(result.notesArchived,1);
  assert.equal(result.linksCreated,1);
  const old=store.read('old-note'),link=[...store.all('link')][0],replacement=store.read(link.from.id,link.from.revision);
  assert.equal(old.body,first.body);
  assert.equal(old.status,'historical');
  assert.deepEqual(old.evidence,[ref(first)]);
  assert.equal(old.scope.validUntil,now+1);
  assert.equal(replacement.scope.validFrom,now+1);
  assert.equal(link.relation,'contradicts');
  assert.deepEqual(link.to,ref(old));
  assert.ok(readWatermark(store).eventSeq>0);
});

test('AUGMENT keeps the original text and rejects evidence or targets outside the atom',async t=>{
  const {store,add,run}=world(t);
  const first=add('first','湖边木屋的楼梯已经铺好，木料和手工工具都收在东面柜子里。');
  add('second','冷泉观测安排在早上。');
  add('third','湖边木屋的楼梯要安装扶手。');
  put(store,'known',note('lake-note',[ref(first)],{body:first.body}),
    note('cold-note',[],{body:'冷泉观测安排在下午。'}));
  const transport=journalAndProvider(t,input=>{
    if(!input.atoms)return modelJSON({atoms:[
      {id:'A1',body:'湖边木屋的楼梯要安装扶手。',evidence:['E3']},
      {id:'A2',body:'冷泉观测安排在早上。',evidence:['E2']},
      {id:'A3',body:'湖边木屋的楼梯补充记录。',evidence:['E1']},
    ]});
    const lake=input.candidateNotes.find(n=>n.body===first.body);
    assert.ok(lake);
    assert.ok(input.atoms[0].matchedCandidates.includes(lake.handle));
    assert.ok(!input.atoms[1].matchedCandidates.includes(lake.handle));
    return modelJSON({decisions:[
      {atomId:'A1',op:'AUGMENT',target:lake.handle,body:'湖边木屋的楼梯要安装扶手。'},
      {atomId:'A2',op:'SUPERSEDE',target:lake.handle},
      {atomId:'A3',op:'ADD',evidence:['E2']},
    ]});
  });
  const result=await run(transport);
  assert.equal(result.notesCreated,1);
  assert.equal(result.linksCreated,1);
  assert.equal(store.read('lake-note').revision,1);
  assert.equal([...store.all('link')][0].relation,'related');
  assert.deepEqual(result.audit.rejected.map(x=>x.reason),[
    'DOWNGRADED_DESTRUCTIVE_AUGMENT_TO_ADD','INVALID_TARGET','EVIDENCE_OUTSIDE_ATOM']);
});

test('traits require a shared topic, three real roots and dates from the selected original events',t=>{
  const {store,add}=world(t);
  const sources=[0,1,2].map(i=>add('real-'+i,'观察白塔雨量计。',now-i*86_400_000));
  put(store,'imported',...['绿茶','木工','跑步'].map(text=>note('fake-'+text,[],{kind:'preference',body:text})));
  put(store,'other-topics',...['木工','跑步','绿茶'].map((text,i)=>note('different-'+i,[ref(sources[i])],{kind:'skill',body:text})));
  assert.deepEqual(findTraitClusters({store,subjectId,now}),[]);
  put(store,'shared',...sources.map((source,i)=>note('shared-'+i,[ref(source)],{kind:'skill',body:'白塔雨量计每天固定时段读数，先检查刻度 '+i})));
  const [cluster]=findTraitClusters({store,subjectId,now});
  assert.deepEqual([cluster.independentRoots,cluster.daySpan],[3,3]);
  assert.ok(cluster.notes.every(n=>n.id.startsWith('shared-')));
  put(store,'trait',note('note:trait:fixture',cluster.notes.map(ref),{kind:'skill',body:'长期经验。'}));
  put(store,'stale',note('shared-0',[ref(sources[0])],{expectedRevision:1,change:'reinterpretation',
    status:'historical',kind:'skill',body:cluster.notes[0].body}));
  assert.deepEqual(findTraitsNeedingReview({store}).map(n=>n.id),['note:trait:fixture']);
});

test('decay keeps notes cited by active memories or linked to current work',t=>{
  const {store,setTime}=world(t);
  setTime(now-40*86_400_000);
  put(store,'old',...['isolated','cited','linked'].map(id=>note(id,[],{body:id})));
  setTime(now);
  put(store,'recent',note('active',[ref(store.read('cited'))],{body:'近期仍然使用这条材料。',change:'self_report'}));
  put(store,'link',{op:'write_link',id:'active-link',expectedRevision:0,
    from:ref(store.read('active')),to:ref(store.read('linked')),relation:'related',strength:1,direction:'both',basis:[],status:'active'});
  assert.deepEqual(findDecayCandidates({store,now}).map(n=>n.id),['isolated']);
});

test('dates use the delivered source day at the configured offset',async t=>{
  const {store,add,run}=world(t);
  add('local-yesterday','明天检查灯塔。',Date.parse('2026-11-23T02:30:00Z'));
  const transport=journalAndProvider(t,input=>{
    if(!input.atoms){
      assert.equal(input.recentEvents[0].at,'2026-11-22');
      return modelJSON({atoms:[{id:'A1',body:'明天检查灯塔。',evidence:['E1']}]});
    }
    assert.equal(input.atoms[0].body,'2026-11-23检查灯塔。');
    return modelJSON({decisions:[{atomId:'A1',op:'ADD'}]});
  });
  await run({...transport,timezoneMinutes:-300});
  assert.ok([...store.all('note')].some(n=>n.id.startsWith('note:slow:')&&n.body==='2026-11-23检查灯塔。'));
});

test('slow-brain work shares the service guard with chat and other background work',async t=>{
  const service=createBrainService({subjectId,clock:()=>now,storage:{clock:()=>now},global:true});
  t.after(()=>service.close());
  const [start]=put(service.store,'initial',event('initial',{body:'一条已经处理的经历。',scene:local,occurredAt:now}));
  put(service.store,'slow-first',{op:'admit_subject_event',subjectId,event:ref(start),disposition:'handled'});
  let unblock,entered;
  const waiting=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{unblock=resolve;});
  const transport=journalAndProvider(t,async input=>{
    if(input.atoms)return modelJSON({decisions:[]});
    entered();await hold;
    return modelJSON({atoms:[]});
  });
  const work=service.runCognitionExclusive(()=>runSlowBrainConsolidation({...transport,store:service.store,subjectId,now}));
  try{
    await Promise.race([waiting,work]);
    assert.equal(service.health().cognitionBusy,true);
    assert.equal((await service.runCognitionExclusive(()=>assert.fail('concurrent work ran'))).status,'busy');
    assert.equal((await service.reply({scene:local,key:'test',source:'synthetic',text:'整理期间进来的新消息。'})).busy,true);
  }finally{unblock();await work;}
  assert.equal(service.health().cognitionBusy,false);
  assert.equal(gatherConsolidationContext({store:service.store,subjectId,now}).recentEvents.length,1);
});

test('incomplete extraction preserves its settled output, leaves the cursor, and is never dispatched twice',async t=>{
  const {store,add,run}=world(t);
  add('unfinished');
  let count=0;
  const transport=journalAndProvider(t,()=>{count++;return modelJSON({atoms:[]},{finishReason:'length'});});
  await assert.rejects(run(transport),{code:'SLOW_OUTPUT_INCOMPLETE'});
  await assert.rejects(run(transport),{code:'SLOW_REQUEST_BLOCKED'});
  assert.equal(count,1);
  assert.equal(readWatermark(store).eventSeq,0);
  assert.equal(transport.journal.data.requests[0].providerResult.finishReason,'length');
});

test('a corrupt watermark pauses automatic and manual processing without resetting it',async t=>{
  const {store,add,run}=world(t);
  add('held-source');
  put(store,'bad-cursor',note('note:slow-watermark',[],{body:'{}'}));
  assert.equal(shouldAutoDream({store,subjectId,now}).reason,'invalid-watermark');
  await assert.rejects(run({fetchImpl:()=>assert.fail('corrupt watermark must not dispatch')}),{code:'SLOW_WATERMARK'});
  assert.equal(store.read('note:slow-watermark').revision,1);
});

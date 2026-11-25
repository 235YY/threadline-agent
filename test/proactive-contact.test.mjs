import test from 'node:test';
import assert from 'node:assert/strict';
import {PROACTIVE_DAILY_SOFT_LIMIT,PROACTIVE_RETRY_POLICY,authorizeProactiveContact,countsTowardProactiveBudget,proactiveAttemptKey,proactiveDayKey} from '../src/proactive-contact.mjs';

const DAY='2026-11-21';
const inputs=(id,revision)=>({id,revision});
const attempt=(index,{dayKey=DAY,kind='initiation'}={})=>({attemptKey:'attempt-key-'+String(index).padStart(6,'0'),dayKey,kind});
const base=(overrides={})=>({subjectId:'jingyang',dayKey:DAY,targetScene:'qq/private/7',kind:'initiation',
  actionInputRefs:[inputs('event:e1',1),inputs('event:e2',1),inputs('note:n1',3)],
  contextRefs:[inputs('event:e1',1)],attempts:[],...overrides});
const code=expected=>error=>error.code===expected;

test('daily soft budget: 5 initiations allowed, the 6th needs reason + host confirmation',()=>{
  const fifth=authorizeProactiveContact(base({attempts:Array.from({length:4},(_,index)=>attempt(index))}));
  assert.equal(fifth.allowed,true);
  assert.equal(fifth.counted,true);
  assert.equal(fifth.attempt.ordinal,5);
  assert.equal(fifth.budget.used,4);
  assert.equal(fifth.budget.withinSoftBudget,true);
  assert.equal(fifth.retry.automatic,false);
  assert.equal(Object.isFrozen(fifth),true);
  assert.equal(Object.isFrozen(fifth.attempt),true);
  const used=Array.from({length:PROACTIVE_DAILY_SOFT_LIMIT},(_,index)=>attempt(index));
  assert.throws(()=>authorizeProactiveContact(base({attempts:used})),code('PROACTIVE_REASON_REQUIRED'));
  assert.throws(()=>authorizeProactiveContact(base({attempts:used,reason:'答应过明天问她面试结果'})),code('PROACTIVE_CONFIRMATION_REQUIRED'));
  assert.throws(()=>authorizeProactiveContact(base({attempts:used,reason:'答应过明天问她面试结果',confirmation:{approved:false,evidence:'operator'}})),code('PROACTIVE_CONFIRMATION_REQUIRED'));
  assert.throws(()=>authorizeProactiveContact(base({attempts:used,reason:'x',confirmation:{approved:true,evidence:''}})),code('PROACTIVE_CONFIRMATION_EVIDENCE_REQUIRED'));
  const sixth=authorizeProactiveContact(base({attempts:used,reason:'答应过明天问她面试结果',confirmation:{approved:true,evidence:'host-policy:proactive-soft-budget'}}));
  assert.equal(sixth.allowed,true);
  assert.equal(sixth.attempt.ordinal,6);
  assert.equal(sixth.budget.requiresConfirmation,true);
  assert.equal(sixth.attempt.confirmation.approved,true);
  assert.match(sixth.attempt.confirmation.evidenceHash,/^[a-f0-9]{64}$/);
  assert.equal(PROACTIVE_DAILY_SOFT_LIMIT,5);
});

test('replies, thoughts and group-peek are not counted as proactive initiations',()=>{
  assert.equal(countsTowardProactiveBudget('initiation'),true);
  for(const kind of ['reply','thought','group-peek'])assert.equal(countsTowardProactiveBudget(kind),false);
  const used=Array.from({length:PROACTIVE_DAILY_SOFT_LIMIT},(_,index)=>attempt(index));
  for(const kind of ['reply','thought','group-peek']){
    const result=authorizeProactiveContact(base({kind,attempts:used}));
    assert.equal(result.allowed,true);
    assert.equal(result.counted,false);
    assert.equal(result.retry.automatic,false);
  }
  assert.throws(()=>authorizeProactiveContact(base({kind:'shout'})),code('PROACTIVE_KIND'));
  assert.throws(()=>authorizeProactiveContact(base({attempts:used})),code('PROACTIVE_REASON_REQUIRED'),'initiations still need confirmation over the soft budget');
});

test('context refs must be delivered input refs of this attempt',()=>{
  assert.throws(()=>authorizeProactiveContact(base({contextRefs:[]})),code('PROACTIVE_CONTEXT_SHAPE'));
  assert.throws(()=>authorizeProactiveContact(base({contextRefs:[inputs('event:other',1)]})),code('PROACTIVE_CONTEXT_UNDELIVERED'));
  assert.throws(()=>authorizeProactiveContact(base({contextRefs:[inputs('event:e1',2)]})),code('PROACTIVE_CONTEXT_UNDELIVERED'),'a newer revision is not the delivered context');
  assert.throws(()=>authorizeProactiveContact(base({contextRefs:[inputs('event:e1',1),inputs('event:e1',1)]})),code('PROACTIVE_CONTEXT_DUPLICATE'));
  assert.throws(()=>authorizeProactiveContact(base({actionInputRefs:[]})),code('PROACTIVE_INPUT_REFS_SHAPE'));
  const ok=authorizeProactiveContact(base({contextRefs:[inputs('event:e1',1),inputs('note:n1',3)]}));
  assert.equal(ok.attempt.contextRefs.length,2);
});

test('under the soft budget no reason or confirmation is needed',()=>{
  const result=authorizeProactiveContact(base({attempts:[attempt(0),attempt(1),attempt(2)]}));
  assert.equal(result.budget.requiresConfirmation,false);
  assert.equal(result.attempt.reason,null);
  assert.equal(result.attempt.confirmation,null);
});

test('duplicate proactive attempt identity is rejected; changed facts form a new attempt',()=>{
  const priorKey=proactiveAttemptKey({subjectId:'jingyang',dayKey:DAY,kind:'initiation',targetScene:'qq/private/7',reason:null,sourceRef:null});
  const history=[{attemptKey:priorKey,dayKey:DAY,kind:'initiation'}];
  assert.throws(()=>authorizeProactiveContact(base({attempts:history})),code('PROACTIVE_DUPLICATE'));
  const targetChanged=authorizeProactiveContact(base({attempts:[],targetScene:'qq/private/8'}));
  assert.notEqual(targetChanged.attempt.key,priorKey);
  const reasonChanged=authorizeProactiveContact(base({attempts:history,reason:'这次有新的由头'}));
  assert.notEqual(reasonChanged.attempt.key,priorKey);
  const sameKey=proactiveAttemptKey({subjectId:'jingyang',dayKey:DAY,kind:'initiation',targetScene:'qq/private/7',reason:null});
  assert.equal(sameKey,priorKey,'host must rebuild the same key from persisted decision/response facts');
  const otherContexts=authorizeProactiveContact(base({contextRefs:[inputs('note:n1',3)]}));
  assert.equal(otherContexts.attempt.key,priorKey,'context refs are authorization evidence, not durable attempt identity');
});

test('target scene must be an explicit qq scene and automatic retry is refused',()=>{
  for(const targetScene of ['global','agent/autonomy','synthetic','qq/private/','qq/unknown/1','',null,42])assert.throws(()=>authorizeProactiveContact(base({targetScene})),code('PROACTIVE_TARGET'));
  assert.throws(()=>authorizeProactiveContact(base({automaticRetry:true})),code('PROACTIVE_NO_AUTO_RETRY'));
  assert.deepEqual(PROACTIVE_RETRY_POLICY,{automatic:false,resendOnUnknown:false,newDecisionRequired:true});
});

test('daily key uses the host clock day and does not count other days',()=>{
  assert.equal(proactiveDayKey({now:Date.parse('2026-11-20T16:30:00Z'),timezoneMinutes:480}),'2026-11-21');
  assert.throws(()=>authorizeProactiveContact(base({now:Date.parse('2026-11-21T16:30:00Z')})),code('PROACTIVE_DAY'));
  assert.throws(()=>authorizeProactiveContact(base({attempts:[attempt(0),attempt(0)]})),code('PROACTIVE_HISTORY_DUPLICATE'));
  const otherDay=Array.from({length:6},(_,index)=>attempt(index,{dayKey:'2026-11-20'}));
  const result=authorizeProactiveContact(base({attempts:otherDay}));
  assert.equal(result.budget.used,0);
  assert.equal(result.budget.requiresConfirmation,false);
});


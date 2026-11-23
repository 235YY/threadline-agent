import test from 'node:test';
import assert from 'node:assert/strict';
import {PROACTIVE_HOST_FORMAT,buildProactiveHostLedger,classifyProactiveHostEntry,assertProactiveHostSend,proactiveHostTargetClass} from '../src/proactive-contact-host.mjs';
import {authorizeProactiveContact,proactiveAttemptKey,proactiveDayKey} from '../src/proactive-contact.mjs';

const T=Date.parse('2026-11-20T17:00:00Z'); // Beijing 2026-11-21 01:00
const DAY='2026-11-21';
const ref=(id,revision=1)=>({id,revision});
const option=(kind,payload)=>({id:'o',kind,payload});
function proactiveEntry(index,{targetScene='qq/private/7',summary='想问问她面试结果',status='proposed',recordedAt=T}={}){
  const decisionId='decision:proactive:'+index,actionId='action:proactive:'+index;
  return {decision:{type:'decision',id:decisionId,revision:1,recordedAt,reflection:false,currentEvent:null,
      input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}},output:{summary,options:[option('act',{tool:'proactive_contact',args:{targetScene}})],selected:'o'},action:{id:actionId,revision:1}},
    action:{type:'action',id:actionId,revision:1,tool:'proactive_contact',args:{targetScene,text:'在吗'},inputRefs:[ref('event:e1'),ref('note:n1',2)],status}};
}
function replyEntry(index){
  const decisionId='decision:reply:'+index;
  return {decision:{type:'decision',id:decisionId,revision:1,recordedAt:T,reflection:false,currentEvent:{id:'event:e1',revision:1,scene:'qq/private/7'},
      input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}},output:{summary:'回复',options:[option('respond',{text:'在的'})],selected:'o'}},
    response:{type:'response',id:decisionId+':response',revision:1,decision:ref(decisionId),scene:'qq/private/7'}};
}
function followupEntry(index){
  const decisionId='decision:followup:'+index;
  return {decision:{type:'decision',id:decisionId,revision:1,recordedAt:T,reflection:true,currentEvent:null,
      input:{payload:{continuity:{subject:{id:'jingyang'}},followup:{id:'f1',targetScene:'qq/private/7'}}},output:{summary:'跟进',options:[option('respond',{text:'上次说到的事'})],selected:'o'}},
    response:{type:'response',id:decisionId+':response',revision:1,decision:ref(decisionId),scene:'qq/private/7'}};
}
function thoughtEntry(index){
  return {decision:{type:'decision',id:'decision:thought:'+index,revision:1,recordedAt:T,reflection:true,currentEvent:null,
    input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}},output:{summary:'想了想',options:[option('wait',{})],selected:'o'}}};
}
function peekEntry(index){
  return {decision:{type:'decision',id:'decision:peek:'+index,revision:1,recordedAt:T,reflection:true,currentEvent:null,
      input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}},output:{summary:'看看群',options:[option('act',{tool:'group_peek',args:{}}) ],selected:'o'},action:{id:'action:peek:'+index,revision:1}},
    action:{type:'action',id:'action:peek:'+index,revision:1,tool:'group_peek',args:{},inputRefs:[],status:'proposed'}};
}
const baseLedger=entries=>buildProactiveHostLedger({subjectId:'jingyang',entries,dayKey:DAY});

test('maps same-day proactive actions to module attemptKey rows and keeps others uncounted',()=>{
  const entries=[proactiveEntry(1),proactiveEntry(2),replyEntry(1),followupEntry(1),thoughtEntry(1),peekEntry(1)];
  const ledger=baseLedger(entries);
  assert.equal(ledger.format,PROACTIVE_HOST_FORMAT);
  assert.equal(ledger.complete,true);
  assert.equal(ledger.dayKey,DAY);
  assert.deepEqual(ledger.attempts.map(attempt=>attempt.attemptKey),[
    proactiveAttemptKey({subjectId:'jingyang',dayKey:DAY,kind:'initiation',targetScene:'qq/private/7',reason:'想问问她面试结果',sourceRef:ref('decision:proactive:1')}),
    proactiveAttemptKey({subjectId:'jingyang',dayKey:DAY,kind:'initiation',targetScene:'qq/private/7',reason:'想问问她面试结果',sourceRef:ref('decision:proactive:2')})]);
  assert.deepEqual(new Set(ledger.uncounted.map(row=>row.kind)),new Set(['reply','followup','thought','group-peek']));
  assert.equal(Object.isFrozen(ledger),true);
  assert.equal(Object.isFrozen(ledger.attempts),true);
  assert.equal(JSON.parse(JSON.stringify(ledger)).complete,true);
});

test('host facts feed the module: third initiation allowed, sixth requires reason+confirmation',()=>{
  const prior=[proactiveEntry(1),proactiveEntry(2),replyEntry(1)];
  const current={...proactiveEntry(9),action:{...proactiveEntry(9).action,status:'proposed'}};
  const facts=assertProactiveHostSend({subjectId:'jingyang',entries:[...prior,current],action:current.action,dayKey:DAY});
  assert.equal(facts.moduleInput.attempts.length,2,'the current action is not a prior attempt');
  assert.deepEqual(facts.actionInputRefs,[ref('event:e1'),ref('note:n1',2)]);
  const result=authorizeProactiveContact({...facts.moduleInput,confirmation:undefined});
  assert.equal(result.allowed,true);
  assert.equal(result.attempt.ordinal,3);
  const five=Array.from({length:5},(_,index)=>proactiveEntry(index+10));
  const sixth={...proactiveEntry(99,{summary:'第六次有新的由头'}),action:{...proactiveEntry(99).action,status:'proposed'}};
  assert.throws(()=>authorizeProactiveContact({...assertProactiveHostSend({subjectId:'jingyang',entries:[...five,sixth],action:sixth.action,dayKey:DAY}).moduleInput,reason:'第六次有新的由头'}),error=>error.code==='PROACTIVE_CONFIRMATION_REQUIRED');
  const confirmed=authorizeProactiveContact({...assertProactiveHostSend({subjectId:'jingyang',entries:[...five,sixth],action:sixth.action,dayKey:DAY,confirmation:{approved:true,evidence:'host-policy:proactive-soft-budget'}}).moduleInput,reason:'第六次有新的由头',confirmation:{approved:true,evidence:'host-policy:proactive-soft-budget'}});
  assert.equal(confirmed.attempt.ordinal,6);
});

test('host layer rejects qq/group proactive sends; group peek stays read-only and uncounted',()=>{
  assert.equal(proactiveHostTargetClass('qq/private/7'),'private');
  assert.equal(proactiveHostTargetClass('qq/group/9'),'group');
  assert.equal(proactiveHostTargetClass('synthetic'),'invalid');
  const current={...proactiveEntry(1,{targetScene:'qq/group/9'}),action:{...proactiveEntry(1,{targetScene:'qq/group/9'}).action,status:'proposed'}};
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY}),error=>error.code==='PROACTIVE_HOST_GROUP_DISABLED');
  const history=buildProactiveHostLedger({subjectId:'jingyang',entries:[proactiveEntry(1,{targetScene:'qq/group/9'})],dayKey:DAY});
  assert.equal(history.complete,false);
  assert.equal(history.problems[0].code,'PROACTIVE_HOST_GROUP_DISABLED');
  const peek=baseLedger([peekEntry(1)]);
  assert.equal(peek.complete,true);
  assert.deepEqual(peek.uncounted.map(row=>row.kind),['group-peek']);
});

test('action.inputRefs are passed through exactly; context refs must be their exact subset',()=>{
  const current={...proactiveEntry(1),action:{...proactiveEntry(1).action,status:'proposed'}};
  const facts=assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY});
  assert.deepEqual(facts.moduleInput.actionInputRefs,current.action.inputRefs);
  assert.deepEqual(facts.moduleInput.contextRefs,current.action.inputRefs,'default context is the exact input refs');
  const subset=assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY,contextRefs:[ref('event:e1')]});
  assert.deepEqual(subset.moduleInput.contextRefs,[ref('event:e1')]);
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY,contextRefs:[ref('event:other')]}),error=>error.code==='PROACTIVE_HOST_CONTEXT');
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY,contextRefs:[]}),error=>error.code==='PROACTIVE_HOST_CONTEXT_SHAPE');
  const noRefs={...current,action:{...current.action,inputRefs:[]}};
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[noRefs],action:noRefs.action,dayKey:DAY}),error=>error.code==='PROACTIVE_HOST_INPUT_REFS_SHAPE'||error.code==='PROACTIVE_LEDGER_INCOMPLETE');
});

test('incomplete ledger fails closed before any model call',()=>{
  const respondWithoutResponse={decision:{type:'decision',id:'decision:dangling',revision:1,recordedAt:T,reflection:false,currentEvent:{id:'event:e1',revision:1,scene:'qq/private/7'},
    input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}},output:{summary:'回复',options:[option('respond',{text:'x'})],selected:'o'}}};
  const legacyReflection={...followupEntry(1),decision:{...followupEntry(1).decision,id:'decision:legacy',reflection:true,input:{payload:{continuity:{subject:{id:'jingyang'}},followup:null}}}};
  const ledger=baseLedger([respondWithoutResponse,legacyReflection]);
  assert.equal(ledger.complete,false);
  assert.ok(ledger.problems.some(problem=>problem.code==='PROACTIVE_HOST_AMBIGUOUS'));
  const current={...proactiveEntry(1),action:{...proactiveEntry(1).action,status:'proposed'}};
  let moduleCalls=0;
  assert.throws(()=>{const facts=assertProactiveHostSend({subjectId:'jingyang',entries:[respondWithoutResponse,current],action:current.action,dayKey:DAY});moduleCalls++;authorizeProactiveContact(facts.moduleInput);},error=>error.code==='PROACTIVE_LEDGER_INCOMPLETE');
  assert.equal(moduleCalls,0,'the module is never called on an incomplete ledger');
  const duplicate=baseLedger([proactiveEntry(1),proactiveEntry(1)]);
  assert.equal(duplicate.complete,false);
  assert.ok(duplicate.problems.some(problem=>problem.code==='PROACTIVE_LEDGER_DUPLICATE'));
});

test('only an unexecuted proposed proactive_contact action can be authorized',()=>{
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[{...proactiveEntry(1)}],action:{...proactiveEntry(1).action,tool:'remember_note'},dayKey:DAY}),error=>error.code==='PROACTIVE_LEDGER_INCOMPLETE'||error.code==='PROACTIVE_HOST_TOOL');
  const executing={...proactiveEntry(1),action:{...proactiveEntry(1).action,status:'succeeded'}};
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[executing],action:executing.action,tool:'proactive_contact',dayKey:DAY}),error=>error.code==='PROACTIVE_HOST_STATE');
  const invalidTarget={...proactiveEntry(1,{targetScene:'global'}),action:{...proactiveEntry(1,{targetScene:'global'}).action,status:'proposed'}};
  assert.throws(()=>assertProactiveHostSend({subjectId:'jingyang',entries:[invalidTarget],action:invalidTarget.action,dayKey:DAY}),error=>error.code==='PROACTIVE_HOST_TARGET');
});

test('explicit action.args.reason wins over decision summary and stays module-consistent',()=>{
  const entry=proactiveEntry(1);
  entry.action.args.reason='为了答谢她上次帮忙';
  const row=classifyProactiveHostEntry(entry,{subjectId:'jingyang'});
  assert.equal(row.reason,'为了答谢她上次帮忙');
  assert.equal(row.attemptKey,proactiveAttemptKey({subjectId:'jingyang',dayKey:DAY,kind:'initiation',targetScene:'qq/private/7',reason:'为了答谢她上次帮忙',sourceRef:ref('decision:proactive:1')}));
  const current={...entry,action:{...entry.action,status:'proposed'}};
  const facts=assertProactiveHostSend({subjectId:'jingyang',entries:[current],action:current.action,dayKey:DAY});
  assert.equal(facts.moduleInput.reason,'为了答谢她上次帮忙');
});

test('classification is pure and records the same China day from decision.recordedAt',()=>{
  assert.equal(proactiveDayKey({now:T,timezoneMinutes:480}),DAY);
  const row=classifyProactiveHostEntry(proactiveEntry(1),{subjectId:'jingyang'});
  assert.equal(row.counted,true);
  assert.equal(row.dayKey,DAY);
  assert.equal(classifyProactiveHostEntry(replyEntry(1),{subjectId:'jingyang'}).kind,'reply');
  assert.equal(classifyProactiveHostEntry(followupEntry(1),{subjectId:'jingyang'}).kind,'followup');
  assert.equal(classifyProactiveHostEntry(thoughtEntry(1),{subjectId:'jingyang'}).kind,'thought');
  const otherDay=buildProactiveHostLedger({subjectId:'jingyang',entries:[proactiveEntry(1)],dayKey:'2026-11-22'});
  assert.equal(otherDay.attempts.length,0);
  assert.equal(otherDay.excluded.length,1);
  assert.equal(otherDay.complete,true);
});


import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {officialDashboard,officialDay} from '../src/official-dashboard.mjs';import {RequestJournal} from '../src/request-journal.mjs';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {createModelDecision,modelRequestSource} from '../src/model-transport.mjs';
import {keepAttention} from '../src/attention.mjs';
import {readActivity} from '../src/turn-activity.mjs';
import {frame,put,ref,event} from './helpers.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {affectTurnId} from '../src/affect-contract.mjs';

const KEY='sk-offlineabcdefghijkl',T=Date.UTC(2026,10,17,3);
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const reply=p=>JSON.stringify({packetId:p.packetId,options:[{id:'wait',kind:'wait',payload:{}}],selected:'wait',summary:'offline contract fixture',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
const provider=content=>new Response(JSON.stringify({id:'offline',choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:20,completion_tokens:10,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:20}}),{status:200});
function fixture(t,{networkCheck=async()=>({ok:true}),response=null,formatRecovery=false,affect=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'jy-isolation-')),db=join(dir,'subject.sqlite'),path=join(dir,'requests.json'),token='q'.repeat(40);
 let now=T,calls=0,p,network=networkCheck,currentResponse=response;
 const monitor=officialDashboard({file:join(dir,'official.json'),token,clock:()=>now});
 const report=spendMicros=>monitor.accept({source:'https://platform.deepseek.com/usage',keyLabel:'新版鲸漾系统',period:'today',timeZone:'Asia/Shanghai',currency:'CNY',day:officialDay(now),spendMicros,requestCount:calls,capturedAt:now},token);
 report(1000);
 let store,journal,model,session,driver,w;
 const open=()=>{
  store=new ContinuityStore(db);journal=new RequestJournal(path);
  session=new ContinuitySession({store,subjectId:'s',maxForeground:16,attention:true,requestJournal:journal});
  w=store.read('qq')??put(store,'w',frame())[0];
  model=createModelDecision({ledgerPath:path,requestJournal:journal,officialSpend:monitor,getKey:()=>KEY,profile:{formatRecovery},networkCheck:()=>network(),
   transport:async()=>{calls++;return currentResponse?currentResponse(p,calls):provider(reply(p));}});
  const decide=(packet,options)=>{p=packet;return model.decide(packet,options);};decide.requestJournal=journal;
  driver=new TurnDriver({store,subjectId:'s',workspace:ref(w),decide,eventBypass:true,sessionFactory:affect?args=>new AffectSession(args):null});
 };
 const close=()=>{model.close();store.close();};
 open();t.after(()=>close());
 const packet=(id,at=now)=>{const e=store.read(id)??put(store,'seed:'+id,event(id))[0];return session.prepare({currentEvent:ref(e),workspace:ref(w),now:at,budgetBytes:131072});};
 return {dir,path,monitor,report,packet,get store(){return store;},get journal(){return journal;},get model(){return model;},get driver(){return driver;},get session(){return session;},get calls(){return calls;},
  setResponse:fn=>currentResponse=fn,setNetwork:fn=>network=fn,setNow:n=>now=n,restart:()=>{close();open();},
  tick:()=>driver.tick({now,localHour:11}),send:(key,body='new message')=>driver.ingest({key,body,actor:'same-contact',scene:'qq/private/synthetic',at:now}),
  decide:packet=>{p=packet;return model.decide(packet);}};
}

test('UNKNOWN is source-local across changed packets and restart; same contact new message proceeds',async t=>{
 const f=fixture(t,{response:()=>{throw Error('offline reset');}});const a=f.send('a');
 await assert.rejects(f.tick(),{code:'UNCERTAIN_REQUEST'});const original=f.journal.data.requests[0],id=original.id;
 assert.deepEqual(original.source,{subject:'s',kind:'event',event:a});assert.equal(original.status,'uncertain');
 await assert.rejects(f.decide(f.packet(a.id,T+1)),{code:'SOURCE_REQUEST_BLOCKED'});assert.equal(f.calls,1);
 f.restart();await assert.rejects(f.tick(),{code:'TURN_OUTCOME_UNKNOWN'});assert.equal(f.calls,1);
 f.setResponse(null);f.send('b');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');
 assert.equal(f.calls,2);assert.equal(f.journal.find(id).status,'uncertain');assert.equal(f.journal.data.halted,undefined);
 assert.equal([...f.store.all('decision')].length,1);
});

test('definitely unsent remains stopped until explicit readmission of original id; accepted packet replay is free',async t=>{
 const f=fixture(t,{networkCheck:async()=>({ok:false})});f.send('unsent');
 await assert.rejects(f.tick(),{code:'NETWORK_PREFLIGHT_FAILED',transportInvoked:false});
 const original=f.journal.data.requests[0],id=original.id;
 assert.equal(original.status,'released');assert.equal(f.calls,0);
 f.setNetwork(async()=>({ok:true}));f.setNow(T+1000);await f.tick();assert.equal(f.calls,0);
 await assert.rejects(async()=>f.driver.readmitRequest({requestId:id,evidence:{requestId:id},verify:()=>false,now:T+2000}),{code:'REQUEST_EVIDENCE'});
 const result=await f.driver.readmitRequest({requestId:id,evidence:{requestId:id,approval:'explicit offline authorization'},verify:()=>true,now:T+2000});
 assert.equal(result.action,'decided');assert.equal(f.calls,1);assert.equal(f.journal.data.requests.length,1);
 const row=f.journal.find(id);assert.equal(row.validation.status,'accepted');assert.equal(row.attempts[0].status,'released');
 const committed=[...f.store.all('decision')][0];await f.decide(committed.input);assert.equal(f.calls,1);
 f.restart();assert.equal(f.journal.find(id).attempts[0].transportInvoked,false);
});

test('invalid captured output retains fees and text; rejects adoption and isolates only its source',async t=>{
 const f=fixture(t,{response:()=>provider('{')});f.send('bad');
 await assert.rejects(f.tick(),{code:'OUTPUT_JSON'});
 const row=f.journal.data.requests[0];assert.equal(row.status,'settled');assert.equal(row.output,'{');assert.ok(row.actualMicros>0);
 assert.equal(row.validation.status,'rejected');assert.equal([...f.store.all('decision')].length,0);assert.equal([...f.store.all('action')].length,0);
 f.restart();f.setResponse(null);f.send('good');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,2);
 assert.equal(f.journal.find(row.id).output,'{');
});

test('official threshold and stale reports stop new dispatch, not settlement or trusted reconciliation',async t=>{
 const f=fixture(t);f.report(5000000);
 await assert.rejects(f.decide(f.packet('limit')),{code:'OFFICIAL_BUDGET_LIMIT'});assert.equal(f.calls,0);
 f.report(1000);f.setNow(T+90001);
 await assert.rejects(f.decide(f.packet('stale')),{code:'OFFICIAL_USAGE_UNAVAILABLE'});assert.equal(f.calls,0);
 const j=f.journal,source={subject:'s',kind:'event',event:{id:'original',revision:1}};
 j.reserve('unresolved','fingerprint',null,{source,packetId:'old'});j.dispatch('unresolved');j.uncertain('unresolved','TIMEOUT');
 j.find('unresolved').reserveMicros=123456;j.save();
 assert.throws(()=>j.reconcile('unresolved',{evidence:{requestId:'different',fingerprint:'fingerprint',outcome:'not-sent'},verify:()=>true}),{code:'REQUEST_EVIDENCE'});
 j.reconcile('unresolved',{evidence:{requestId:'unresolved',fingerprint:'fingerprint',outcome:'not-sent',proof:'offline verifier'},verify:()=>true});
 assert.equal(j.find('unresolved').reserveMicros,123456);assert.equal(j.find('unresolved').status,'released');
 assert.throws(()=>j.reserve('new-id','another',null,{source,packetId:'another'}),{code:'SOURCE_REQUEST_BLOCKED'});
 j.reserve('settle','f');j.dispatch('settle');j.settle('settle',{upperMicros:99});assert.equal(j.find('settle').status,'settled');
});

test('gate is rechecked after async preflight, and maintenance shares the same gate',async t=>{
 const wait=latch(),entered=latch(),f=fixture(t,{networkCheck:async()=>{entered.resolve();await wait.promise;return {ok:true};}});
 const request=f.decide(f.packet('race'));await entered.promise;f.report(5000000);wait.resolve();
 await assert.rejects(request,{code:'OFFICIAL_BUDGET_LIMIT'});assert.equal(f.calls,0);
 assert.equal(f.journal.data.requests[0].transportInvoked,false);
 await assert.rejects(f.model.invokeMaintenance({packetId:'maintenance',messages:[],source:{subject:'s',kind:'maintenance',jobId:'persisted-day-job'}}),{code:'OFFICIAL_BUDGET_LIMIT'});
 assert.equal(f.calls,0);
});

test('two concurrent packet preparations of one source cannot dispatch twice',async t=>{
 const entered=latch(),finish=latch(),f=fixture(t,{response:async p=>{entered.resolve();await finish.promise;return provider(reply(p));}});
 const p=f.packet('parallel'),q=f.packet('parallel',T+1),one=f.decide(p);await entered.promise;
 await assert.rejects(f.decide(q),{code:'SOURCE_REQUEST_BLOCKED'});assert.equal(f.calls,1);
 finish.resolve();await one;
});

test('different sources preserve genuine in-flight serialization without global UNKNOWN halt',async t=>{
 const entered=latch(),finish=latch(),f=fixture(t,{response:async p=>{entered.resolve();await finish.promise;return provider(reply(p));}});
 const one=f.decide(f.packet('first'));await entered.promise;
 await assert.rejects(f.decide(f.packet('second')),{code:'REQUEST_IN_FLIGHT',transportInvoked:false});assert.equal(f.calls,1);
 finish.resolve();await one;assert.equal(f.journal.data.requests[1].status,'released');
});

test('one format recovery child keeps source lineage, both raw outputs and fees; no third dispatch',async t=>{
 const f=fixture(t,{formatRecovery:true,response:(p,n)=>provider(n===1?'{':reply(p))});f.send('repair');
 assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,2);
 const [parent,child]=f.journal.data.requests;assert.equal(parent.output,'{');assert.equal(child.parentRequestId,parent.id);
 assert.deepEqual(child.source,parent.source);assert.equal(parent.validation.status,'accepted');
 await f.decide([...f.store.all('decision')][0].input);assert.equal(f.calls,2);
});

test('UNKNOWN corrective attempt blocks the same source after restart; unrelated new input proceeds',async t=>{
 const f=fixture(t,{formatRecovery:true,response:(p,n)=>{if(n===2)throw Error('offline repair unknown');return provider(n===1?'{':reply(p));}});f.send('repair-unknown');
 await assert.rejects(f.tick(),{code:'UNCERTAIN_REQUEST'});assert.equal(f.calls,2);
 f.restart();await assert.rejects(f.tick(),{code:'TURN_OUTCOME_UNKNOWN'});assert.equal(f.calls,2);
 f.setResponse(null);f.send('after-repair');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,3);
});

test('accepted SQLite Decision repairs a missing Journal validation on restart without dispatch',async t=>{
 const f=fixture(t);f.send('commit-io');const record=f.journal.recordValidation.bind(f.journal);
 let fail=true;f.journal.recordValidation=(...args)=>{if(fail){fail=false;throw Error('injected journal IO boundary');}return record(...args);};
 await assert.rejects(f.tick(),/injected journal IO/);assert.equal(f.calls,1);
 assert.equal([...f.store.all('decision')].length,1);assert.equal(f.journal.data.requests[0].validation,undefined);
 f.restart();assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,1);
 assert.equal(f.journal.data.requests[0].validation.status,'accepted');
});

test('legacy unlinked UNKNOWN is bound only from its exact stored activity packet and survives restart',async t=>{
 const f=fixture(t,{response:()=>{throw Error('offline unknown');}});const a=f.send('legacy');
 await assert.rejects(f.tick(),{code:'UNCERTAIN_REQUEST'});
 const row=f.journal.data.requests[0];delete row.source;delete row.packetId;f.journal.save();
 f.restart();const restored=f.journal.data.requests[0];
 assert.deepEqual(restored.source,{subject:'s',kind:'event',event:a});assert.ok(restored.sourceEvidence.ref);
 await assert.rejects(f.decide(f.packet(a.id,T+1)),{code:'SOURCE_REQUEST_BLOCKED'});assert.equal(f.calls,1);
});

test('failed idle reflection does not revive solely with another timestamp; new event still proceeds',async t=>{
 const f=fixture(t,{networkCheck:async()=>({ok:false})});
 await assert.rejects(f.driver.tick({now:T,followup:{reason:'offline followup'}}));
 const row=f.journal.data.requests[0];assert.equal(row?.source.kind,'reflection');
 f.setNetwork(async()=>({ok:true}));f.setNow(T+7200000);
 assert.equal((await f.driver.tick({now:T+7200000,idleReflection:true})).reason,'source-stopped');assert.equal(f.calls,0);
 f.report(1000);f.send('after-reflection');assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,1);
});

test('crossing official threshold after dispatch cannot prevent recording the received result',async t=>{
 const f=fixture(t);f.setResponse(p=>{f.report(5000000);return provider(reply(p));});f.send('dispatched');
 assert.equal((await f.tick()).action,'decided');assert.equal(f.journal.data.requests[0].validation.status,'accepted');
 f.send('later');f.setNow(T+1000);await assert.rejects(f.tick(),{code:'OFFICIAL_BUDGET_LIMIT'});assert.equal(f.calls,1);
});

test('format correction cannot bypass a newly reached official threshold',async t=>{
 const f=fixture(t,{formatRecovery:true});f.setResponse(()=>{f.report(5000000);return provider('{');});f.send('repair-budget');
 await assert.rejects(f.tick(),{code:'OFFICIAL_BUDGET_LIMIT'});assert.equal(f.calls,1);
 assert.equal(f.journal.data.requests[0].output,'{');assert.equal(f.journal.data.requests[1].status,'released');
});

test('Affect with the actual engine keeps UNKNOWN local across SQLite restart and permits a new source',async t=>{
 const f=fixture(t,{affect:true,response:()=>{throw Error('offline unknown');}});f.send('affect-unknown');
 await assert.rejects(f.tick(),{code:'UNCERTAIN_REQUEST'});f.restart();
 await assert.rejects(f.tick(),{code:'TURN_OUTCOME_UNKNOWN'});assert.equal(f.calls,1);
 f.setResponse(null);f.send('affect-next');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,2);
 assert.equal(f.journal.data.requests[0].status,'uncertain');
});

test('Affect malformed capture retains raw text and settlement across restart without blocking other messages',async t=>{
 const f=fixture(t,{affect:true,response:()=>provider('{')});f.send('affect-invalid');
 await assert.rejects(f.tick(),{code:'OUTPUT_JSON'});
 f.restart();assert.equal([...f.store.all('affect_turn')][0].rawOutput,'{');assert.equal(f.journal.data.requests[0].validation.status,'rejected');
 f.setResponse(null);f.send('affect-valid');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,2);
});

test('semantic rejection never receives format repair or executes an unauthorized tool',async t=>{
 const f=fixture(t,{formatRecovery:true,response:p=>{const value=JSON.parse(reply(p));value.options=[{id:'w',kind:'act',payload:{tool:'not-granted',args:{}}}];value.selected='w';return provider(JSON.stringify(value));}});
 f.send('semantic');await assert.rejects(f.tick(),{code:'TOOL_NOT_GRANTED'});
 assert.equal(f.calls,1);assert.equal(f.journal.data.requests[0].validation.status,'rejected');assert.equal([...f.store.all('action')].length,0);
});

test('crash-left dispatched becomes uncertain after exclusive reopen; B proceeds and A cannot resend',async t=>{
 const f=fixture(t),a=f.send('crash-left'),p=f.packet(a.id),source=modelRequestSource(p),id='turn:'+p.packetId;
 f.journal.reserve(id,'frozen-request',null,{source,packetId:p.packetId});f.journal.dispatch(id);
 f.journal.find(id).reserveMicros=321;f.journal.save();f.restart();
 const row=f.journal.find(id);assert.equal(row.status,'uncertain');assert.equal(row.recovery.from,'dispatched');assert.equal(row.reserveMicros,321);assert.equal(row.fingerprint,'frozen-request');
 await assert.rejects(f.decide(f.packet(a.id,T+1)),{code:'SOURCE_REQUEST_BLOCKED'});assert.equal(f.calls,0);
 f.send('after-crash');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,1);assert.equal(f.journal.find(id).status,'uncertain');
});

test('crash-left Affect dispatched recovers from the same Journal fact and does not block B',async t=>{
 const f=fixture(t,{affect:true}),a=f.send('affect-crash'),session=new AffectSession({store:f.store,subjectId:'s',requestJournal:f.journal});
 const p=await session.prepare({currentEvent:a,workspace:ref(f.store.read('qq')),now:T,budgetBytes:131072});
 const id='turn:'+p.packetId;f.journal.reserve(id,'crash-fingerprint',null,{source:modelRequestSource(p),packetId:p.packetId});f.journal.dispatch(id);
 const turn=f.store.read(affectTurnId(p));put(f.store,'offline-crash-dispatch',{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'});
 f.restart();assert.equal(f.store.read(turn.id).status,'uncertain');assert.equal(f.store.read(turn.id).error,'INTERRUPTED_DISPATCH');
 f.send('after-affect-crash');f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,1);
 assert.equal(f.journal.find(id).status,'uncertain');
});

test('orphan Affect dispatch preserves missing/reserved/released/settled Journal facts and isolates only A',async t=>{
 for(const status of ['missing','reserved','released','settled']){
  const f=fixture(t,{affect:true}),a=f.send('orphan-'+status),session=new AffectSession({store:f.store,subjectId:'s',requestJournal:f.journal});
  const p=await session.prepare({currentEvent:a,workspace:ref(f.store.read('qq')),now:T,budgetBytes:131072}),id='turn:'+p.packetId;
  if(status!=='missing'){f.journal.reserve(id,'frozen-'+status,null,{source:modelRequestSource(p),packetId:p.packetId});if(status==='released')f.journal.release(id,'NO_KEY');if(status==='settled'){f.journal.dispatch(id);f.journal.settle(id,{upperMicros:123});f.journal.attachOutput(id,'original raw capture');}}
  const turn=f.store.read(affectTurnId(p));put(f.store,'orphan-dispatched',{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'});
  f.restart();assert.equal(f.store.read(turn.id).status,'uncertain');
  assert.equal(f.journal.tryFind(id)?.status,status==='missing'?undefined:status==='reserved'?'released':status);
  if(status==='reserved')assert.equal(f.journal.find(id).recovery.from,'reserved');
  if(status==='settled'){assert.equal(f.journal.find(id).actualMicros,123);assert.equal(f.journal.find(id).output,'original raw capture');}
  f.send('independent-'+status);f.setNow(T+1000);assert.equal((await f.tick()).action,'decided');assert.equal(f.calls,1);
 }
});

test('crash-left reserved is known unsent, requires explicit readmission, and retains its original id',async t=>{
 const f=fixture(t),a=f.send('reserved-crash'),p=f.packet(a.id),id='turn:'+p.packetId;
 f.journal.reserve(id,'reserved-fingerprint',null,{source:modelRequestSource(p),packetId:p.packetId});f.restart();
 assert.equal(f.journal.find(id).status,'released');assert.equal(f.journal.find(id).transportInvoked,false);
 await assert.rejects(f.decide(f.packet(a.id,T+1)),{code:'SOURCE_REQUEST_BLOCKED'});assert.equal(f.calls,0);
 assert.equal((await f.driver.readmitRequest({requestId:id,evidence:{requestId:id,approval:'offline reviewed unsent request'},verify:()=>true,now:T+1000})).action,'decided');
 assert.equal(f.journal.data.requests.length,1);assert.equal(f.journal.find(id).attempts[0].recovery.from,'reserved');assert.equal(f.calls,1);
});
test('only fresh official today/Key/CNY reports authorize calls; threshold, stale and wrong scope stop',()=>{const dir=mkdtempSync(join(tmpdir(),'jy-official-')),token='x'.repeat(40);let now=Date.now();const gate=officialDashboard({file:join(dir,'page.json'),token,clock:()=>now}),report={source:'https://platform.deepseek.com/usage',keyLabel:'新版鲸漾系统',period:'today',timeZone:'Asia/Shanghai',currency:'CNY',day:officialDay(now),spendMicros:430000,requestCount:17,capturedAt:now};assert.equal(gate.gate().allow,false);assert.throws(()=>gate.accept(report,'wrong'));for(const bad of [{keyLabel:'DSH'},{period:'month'},{currency:'USD'},{day:'2020-01-01'},{capturedAt:now-90001}])assert.throws(()=>gate.accept({...report,...bad},token));gate.accept(report,token);assert.equal(gate.gate().allow,true);gate.accept({...report,spendMicros:5000000},token);assert.equal(gate.gate().allow,false);now+=90001;assert.equal(gate.gate().known,false);});
test('request journal keeps unknown identities without monetary holds or blocking fresh requests; old history stays read-only',()=>{const dir=mkdtempSync(join(tmpdir(),'jy-requests-')),history=join(dir,'history.json'),raw=JSON.stringify({halted:'old unknown',requests:[{id:'old',status:'uncertain',reserveMicros:999999999}]});writeFileSync(history,raw);let j=new RequestJournal(join(dir,'calls.json'),{history});assert.throws(()=>j.reserve('old','x'));j.reserve('one','x',999999999);j.dispatch('one');j.uncertain('one','TIMEOUT');j.reserve('two','x',999999999);assert.equal(j.data.halted,undefined);assert.equal(j.find('one').reserveMicros,undefined);j.close();j=new RequestJournal(join(dir,'calls.json'),{history});assert.throws(()=>j.reserve('one','x'));j.reserve('three','x');j.close();assert.equal(readFileSync(history,'utf8'),raw);});

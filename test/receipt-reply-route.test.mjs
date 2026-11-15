import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {sourceReplyRoute} from '../src/reply-route.mjs';
import {prepareReflection,commitDecision} from '../src/cognition.mjs';
import {reflectionFrame} from '../src/reflection-frame.mjs';

const pin=r=>({id:r.id,revision:r.revision});
const output=(p,kind,payload)=>({packetId:p.packetId,options:[{id:'one',kind,payload}],selected:'one',summary:'合成路由检查',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});
const input=(scene,id)=>({source:'qq',key:scene.startsWith('qq/group/')?'group:'+scene.slice(9):'private:'+scene.slice(11),scene,message_id:id,messages:[{role:'user',content:'synthetic '+id}],execute:false});
async function setup(t,options={}){
  let at=1794623000000;const sent=[];
  const s=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,global:true,clock:()=>at,rhythm:{minGapMs:1},allowedActionTools:['probe'],
    adapter:{send:async x=>{sent.push(x);return {delivered:true};}},decide:p=>output(p,p.payload.current.origin==='tool_receipt'?'respond':'act',p.payload.current.origin==='tool_receipt'?{text:'synthetic result'}:{tool:'probe',args:{}}),...options});
  t.after(async()=>{await new Promise(r=>s.server.close(r));s.close();});return {s,sent,advance:()=>{at+=10000;}};
}
function receipt(s,action,id){const claim=s.actionClaim({action});return s.receipt({scene:'global',action:claim.action,claimId:claim.claimId,status:'succeeded',body:'synthetic result',eventId:id});}

test('global workspace tool receipt and response preserve the source private scene',async t=>{
  const {s,sent,advance}=await setup(t);const first=await s.reply(input('qq/private/7','first'));receipt(s,first.outbox[0].action,'receipt-one');advance();const next=await s.tick();await s.dispatch(next.outbox,{scene:'global',execute:true});
  assert.equal(s.store.read('receipt-one').scene,'qq/private/7');const r=[...s.store.all('response')][0];assert.equal(r.scene,'qq/private/7');assert.equal(r.status,'sent');assert.equal(sent[0].scene,'qq/private/7');
});

test('interleaved private and group actions reply to their own source, not last caller or dispatch fallback',async t=>{
  const {s,sent,advance}=await setup(t);const a=await s.reply(input('qq/private/7','a'));advance();const b=await s.reply(input('qq/group/9','b'));
  receipt(s,b.outbox[0].action,'receipt-group');receipt(s,a.outbox[0].action,'receipt-private');advance();
  for(let i=0;i<2;i++){const result=await s.tick();await s.dispatch(result.outbox,{scene:'qq/private/999',execute:true});advance();}
  assert.deepEqual(sent.map(x=>x.scene),['qq/group/9','qq/private/7']);
  for(const r of s.store.all('response'))assert.equal(r.status,'sent');
});

function graph(){
  const e={id:'source',revision:1,type:'event',origin:'reported',scene:'qq/private/7'},history={id:'history',revision:1,type:'event',origin:'reported',scene:'qq/group/90'},r={id:'receipt',revision:1,type:'event',origin:'tool_receipt',scene:'global'};
  const a={id:'action',revision:3,type:'action',inputRefs:[pin(history),pin(e)],receipt:pin(r)},d={id:'decision',revision:1,type:'decision',action:{id:a.id,revision:1},currentEvent:pin(e),input:{payload:{continuity:{subject:{id:'s',revision:1}}}}};
  const records=[e,history,r,a,d];const route=extra=>sourceReplyRoute({read:(id,rev)=>records.find(x=>x.id===id&&x.revision===rev),all:type=>records.filter(x=>x.type===type),subjectId:'s',event:pin(r),...extra});return {e,history,r,a,d,records,route};
}

test('legacy global receipt follows the creating Decision, ignoring unrelated historical inputs',()=>{
  const f=graph();const r=f.route();assert.equal(r.scene,'qq/private/7');assert.ok(r.sources.some(x=>x.id===f.e.id));assert.equal(f.r.scene,'global');
});

test('missing, wrong-version and foreign-subject provenance cannot guess a recipient',()=>{
  const f=graph();f.d.currentEvent.revision=2;assert.equal(f.route().scene,null);f.d.currentEvent=pin(f.e);f.d.input.payload.continuity.subject.id='another';assert.equal(f.route().reason,'foreign-subject-decision');f.d.input.payload.continuity.subject.id='s';f.records.splice(f.records.indexOf(f.e),1);assert.equal(f.route().scene,null);
});

test('ambiguous receipt ownership and source cycles remain unresolved',()=>{
  const f=graph();f.records.push({...f.a,id:'second-action'});assert.equal(f.route().reason,'ambiguous-receipt-action');f.records.pop();f.d.currentEvent=pin(f.r);f.a.inputRefs=[pin(f.r)];assert.equal(f.route().reason,'source-cycle');
});

test('task feedback follows exact origin or explicit saved target, preserving subject ownership',()=>{
  const f=graph();f.records.splice(f.records.indexOf(f.a),1);const task={type:'agent_task',id:'task',revision:2,subjectId:'s',target:null,originEventRef:pin(f.e),feedback:{event:pin(f.r)},observationRefs:[]};f.records.push(task);
  assert.equal(f.route().scene,'qq/private/7');task.target='qq/group/12';assert.equal(f.route().scene,'qq/group/12');task.subjectId='another';assert.equal(f.route().reason,'foreign-subject-task');
});

test('unresolved response remains pending before claim; no external call or uncertain-send record is created',async t=>{
  const {s,sent,advance}=await setup(t,{decide:p=>output(p,'respond',{text:'synthetic unresolved'})});s.observe({source:'fixture',key:'orphan',scene:'global',text:'synthetic receipt'});
  advance();const result=await s.tick();const delivered=await s.dispatch(result.outbox,{scene:'qq/private/999',execute:true});
  const response=[...s.store.all('response')][0];assert.equal(response.status,'pending');assert.equal(response.claimId,null);assert.equal(response.receipts.length,0);assert.equal(delivered[0].error,'RESPONSE_TARGET_UNRESOLVED');assert.equal(sent.length,0);
  await s.recoverPendingEffects();assert.equal(sent.length,0);
});

test('ordinary cognition cannot add a reply target to redirect a conversation',async t=>{
  const {s,sent}=await setup(t,{decide:p=>output(p,'respond',{text:'synthetic explicit target',target:'qq/group/12'})});const result=await s.reply({...input('qq/private/7','explicit'),execute:true});
  assert.equal(result.outbox.length,0);assert.equal(sent.length,0);assert.equal([...s.store.all('response')].length,0);
});

test('reflection preserves a valid explicitly delivered contact target',async t=>{
  const {s,sent}=await setup(t,{decide:p=>output(p,'wait',{})});await s.reply(input('qq/group/12','known-contact'));
  const workspace=pin(s.store.read('ws:global'));
  const p=prepareReflection({store:s.store,subjectId:'jingyang',workspace,identity:'synthetic',internal:reflectionFrame({read:(id,revision)=>s.store.read(id,revision),subjectId:'jingyang',workspace,now:1794623000000}),budgetBytes:131072});
  const proposed=output(p,'respond',{text:'synthetic explicit target',target:'qq/group/12'});delete proposed.continuity.expressionChoice;delete proposed.continuity.observationDisposition;
  const d=commitDecision({store:s.store,packet:p,output:proposed,requestId:'reflection-route',decisionId:'reflection-route',allowedActionTools:[]});
  const r=s.store.read(d.id+':response');await s.dispatch([{kind:'respond',response:pin(r)}],{scene:'qq/private/999',execute:true});
  assert.equal(sent[0].scene,'qq/group/12');assert.equal(s.store.read(r.id).status,'sent');
});

test('AgentTask observations and terminal feedback recover the origin scene when target is absent',async t=>{
  const {s,advance}=await setup(t,{subjectTask:true,decide:p=>p.payload.task?output(p,'act',{tool:'task_finish',args:{result:'synthetic task result'}}):output(p,'wait',{})});
  const first=await s.reply(input('qq/private/7','task-origin'));advance();const origin=[...s.store.all('event')].find(e=>e.origin==='reported');
  const task=await s.createAgentTask({goal:'synthetic task',subjectId:'jingyang',target:null,originEventRef:pin(origin),budget:{maxSteps:2,maxCalls:2,maxToolCalls:2,maxOutputBytes:8192,maxDurationMs:60000},metadata:{allowedTools:[]}});
  await s.stepAgentTask(task.id);const events=[...s.store.all('event')].filter(e=>e.source.system==='agent-runtime');assert.ok(events.length>0);for(const event of events)assert.equal(event.scene,'qq/private/7');
});

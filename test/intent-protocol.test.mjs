import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId} from '../src/attention.mjs';
import {intentPacket,verifiedIntent,intentEligible} from '../src/intent-protocol.mjs';
import {eventProcessId} from '../src/task-threads.mjs';
import {runtimeFeedback} from '../src/runtime-feedback.mjs';
import {put,event,frame,ref,note} from './helpers.mjs';

test('compact belief, concern, condition and impression persist across restart and preparation can use their fixed handles',async t=>{
 const {disk}=await import('./helpers.mjs');
 let store;t.after(()=>store?.close());
 const file=disk(t);store=new ContinuityStore(file);
 let session=new ContinuitySession({store,subjectId:'jingyang',attention:true});
 const [first,w]=put(store,'initial',event('a'),frame());
 const prepare=e=>session.prepare({currentEvent:ref(e),workspace:ref(w),mind:true,unified:true,workbenchFocus:true,
   workbenchMaterials:true,localLookupPolicy:{maxReads:2,maxHits:4},subjectiveDomains:true,subjectiveMemoryV2:true,apperceptionV1:true,intentProtocol:true,budgetBytes:131072});
 const answer=(p,id,x)=>session.commit({packet:p,decisionId:id,requestId:id,output:{packetId:intentPacket(p).packetId,...x}});
 answer(prepare(first),'meaning',{decision:{type:'reply',text:'明白了。'},perception:{domain:'normative',meaning:'答应的核对应有据可查'},states:[
   {kind:'appraisal',text:'原件需要核对',confidence:'tentative',domains:['world']},
   {kind:'concern',text:'保住记录的准确性',stance:'preserve'},
   {kind:'condition',text:'已有原件',stance:'unknown'},
   {kind:'impression',text:'这次先看原件再下判断'}]});
 assert.equal(store.read('meaning').output.apperception.activated_cells[0].domain,'normative');
 store.close();store=new ContinuityStore(file);session=new ContinuitySession({store,subjectId:'jingyang',attention:true});
 const next=put(store,'next',event('b')).at(-1),p=prepare(next),wire=intentPacket(p),view=JSON.parse(wire.messages[1].content).view;
 const handles=Object.fromEntries(view.states.map(x=>[x.kind,x.handle]));
 assert.equal(view.states.find(x=>x.kind==='condition').assessment.stance,'unknown');
 assert.ok(handles.impression);
 assert.throws(()=>answer(p,'bad',{decision:{type:'wait'},states:[{kind:'readiness',text:'先核对',links:['S999']}]}),{code:'INTENT_HANDLE'});
 const d=answer(p,'readiness',{decision:{type:'wait'},states:[{kind:'readiness',text:'先查清准确性再行动',links:[handles.concern,handles.appraisal,handles.condition]}]});
 assert.equal(d.output.options[0].kind,'wait');
 const ready=[...store.all('personal_state')].find(x=>x.kind==='readiness');
 assert.equal(ready.mind.concerns[0].revision,1);
 const later=prepare(put(store,'later',event('c')).at(-1)),v=JSON.parse(intentPacket(later).messages[1].content).view;
 assert.ok(v.judgments.links.some(x=>x.relation==='concerns'&&x.status==='delivered'));
 assert.ok(wire.bytes<p.bytes);
});
function world(t){
 const store=new ContinuityStore(':memory:');t.after(()=>store.close());
 const session=new ContinuitySession({store,subjectId:'jingyang',attention:true});
 const [e,w]=put(store,'init',event('m1',{body:'朋友：港口那批货单帮我核一下，集装箱数对不上',actor:'brother'}),frame());
 const n=put(store,'n',note('note-port',[],{body:'港口货单原件：集装箱 12 个，单位待核验'}))[0].record;
 const s={store,session,e,w,n,i:0};
 s.prepare=(extra={})=>session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),identity:'你是小栈。',mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,taskThreads:true,subjectiveMemoryV2:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:['office_read'],budgetBytes:131072,now:1_800_000_000_000,...extra});
 s.say=(body)=>{s.e=put(store,'e'+(++s.i),event('m'+(s.i+1),{body,actor:'brother'})).at(-1);};
 s.answer=(p,intent)=>{const wire=intentPacket(p);const id='d'+(++s.i);return {wire,d:session.commit({packet:p,output:JSON.stringify({packetId:wire.packetId,...intent}),decisionId:id,requestId:id,allowedActionTools:['office_read']})};};
 return s;
}

test('intent packet is a small, verifiable projection with handles instead of ids',t=>{
 const s=world(t),p=s.prepare({materials:[{ref:ref(s.n),aspect:'knowledge'}]}),wire=intentPacket(p);
 assert.ok(intentEligible(p));
 assert.ok(Buffer.byteLength(wire.instruction)*4<Buffer.byteLength(p.instruction),`${Buffer.byteLength(wire.instruction)} vs ${Buffer.byteLength(p.instruction)}`);
 const view=JSON.parse(wire.messages[1].content).view;
 assert.equal(view.current.handle,'E0');assert.equal(view.materials[0].handle,'M1');assert.equal(view.tools[0].name,'office_read');assert.match(view.tools[0].args.path,/必填/);
 assert.doesNotMatch(wire.messages[1].content,/revision|expectedRevision|attention:/);
 assert.doesNotThrow(()=>verifiedIntent(wire));
 const forged=structuredClone(wire);forged.messages[0].content+='x';assert.throws(()=>verifiedIntent(forged),{code:'PACKET_CHANGED'});
});

test('reply, a kept feeling and a new piece of work commit through the ordinary path and carry into the next turn',t=>{
 const s=world(t);let p=s.prepare({materials:[{ref:ref(s.n),aspect:'knowledge'}]});
 const {d}=s.answer(p,{summary:'先接下来',decision:{type:'reply',text:'好，我对一下原件'},states:[{kind:'feeling',text:'有点担心单位写错'}],work:[{title:'港口货单核对',note:'集装箱数对不上，先核原件单位',thisMessage:true}],used:['M1']});
 assert.equal(d.output.options[0].kind,'respond');assert.equal(d.output.used[0].ref.id,'note-port');
 const frameRec=s.store.read(attentionId('jingyang')),proc=frameRec.processes[0];
 assert.equal(proc.label,'港口货单核对');assert.equal(proc.status,'active');
 assert.equal(s.store.read(eventProcessId('jingyang',ref(s.e),proc.id))?.value.status,'active');
 const audit=[...s.store.all('extension_record')].find(r=>r.stateType==='intent-compilation');assert.ok(audit.value.rawOutput.includes('港口货单核对'));
 s.say('厨房排班的事你也记一下');p=s.prepare();
 const view=JSON.parse(intentPacket(p).messages[1].content).view;
 assert.equal(view.states[0].text,'有点担心单位写错');assert.equal(view.states[0].handle,'S1');
 assert.equal(view.work[0].handle,'P1');assert.equal(view.work[0].title,'港口货单核对');assert.equal(view.lastAction.text,'好，我对一下原件');
 // Second turn: separate new work for the kitchen, update the feeling, finish nothing by guesswork.
 s.answer(p,{decision:{type:'reply',text:'嗯，排班我另记一件'},states:[{update:'S1',text:'单位的事还悬着，不过排班更简单'}],work:[{title:'厨房排班',status:'active',thisMessage:true}]});
 const procs=s.store.read(attentionId('jingyang')).processes;assert.deepEqual(procs.map(x=>x.label).sort(),['厨房排班','港口货单核对']);
 const port=procs.find(x=>x.label==='港口货单核对');assert.equal(port.revision,1,'untouched work is not rewritten');
 assert.equal(s.store.read(eventProcessId('jingyang',ref(s.e),port.id)),null,'kitchen message is not attached to the port work');
 s.say('货单我刚发你了');p=s.prepare();const v3=JSON.parse(intentPacket(p).messages[1].content).view;
 assert.match(v3.states[0].text,/排班更简单/);
});

test('status-only update keeps the real body from the delivered frame version',t=>{
 const s=world(t);let p=s.prepare();
 s.answer(p,{decision:{type:'wait'},work:[{title:'港口货单核对',note:'核对集装箱数量和单位'}]});
 s.say('核完了吗');p=s.prepare();
 s.answer(p,{decision:{type:'reply',text:'核完了'},work:[{update:'P1',status:'completed'}]});
 const proc=s.store.read(attentionId('jingyang')).processes[0];assert.equal(proc.status,'completed');assert.equal(proc.body,'核对集装箱数量和单位');
});

test('mixing a work handle into states, or an ungranted tool, is a precise rejection with feedback, never a partial commit',t=>{
 const s=world(t);let p=s.prepare();
 s.answer(p,{decision:{type:'wait'},work:[{title:'港口货单核对'}]});
 s.say('那个呢');p=s.prepare();
 assert.throws(()=>s.answer(p,{decision:{type:'reply',text:'在弄'},states:[{update:'P1',text:'进行中'}]}),e=>e.code==='INTENT_HANDLE'&&/不是本轮 view 里的状态 S编号/.test(e.message));
 assert.throws(()=>s.answer(p,{decision:{type:'act',tool:'office_write',args:{path:'a',content:'b'}}}),{code:'TOOL_NOT_GRANTED'});
 assert.equal([...s.store.all('response')].length,0);
 const codes=[...s.store.all('extension_record')].filter(r=>r.stateType==='operation-feedback').map(r=>r.value.error);
 assert.deepEqual(codes.sort(),['INTENT_HANDLE','TOOL_NOT_GRANTED']);
 assert.equal(runtimeFeedback({store:s.store,subjectId:'jingyang',now:Date.now()}).recentFeedback[0].adopted,false);
});

test('lookup can open a delivered material by handle; act passes the granted tool through unchanged',t=>{
 const s=world(t);const p=s.prepare({materials:[{ref:ref(s.n),aspect:'knowledge'}]});
 const {d}=s.answer(p,{decision:{type:'lookup',open:'M1'}});assert.deepEqual(d.output.options[0].payload,{ref:ref(s.n)});
 s.say('看看办公室那份');const p2=s.prepare();
 const {d:d2}=s.answer(p2,{decision:{type:'act',tool:'office_read',args:{path:'port/manifest.txt'}}});assert.deepEqual(d2.output.options[0].payload,{tool:'office_read',args:{path:'port/manifest.txt'}});
});

test('transport opt-in sends the intent messages, keeps request identity, and repairs format once with intent feedback',async t=>{
 const {createModelDecision}=await import('../src/model-transport.mjs');
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const s=world(t),p=s.prepare(),wire=intentPacket(p),dir=mkdtempSync(join(tmpdir(),'jy-intent-transport-')),sent=[];
 const replies=['{"packetId":"wrong"}',JSON.stringify({packetId:wire.packetId,decision:{type:'reply',text:'在呢'}})];
 const transport=async(_url,init)=>{sent.push(JSON.parse(init.body).messages);return new Response(JSON.stringify({id:'r'+sent.length,created:1,model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:replies[sent.length-1]}}],usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60}}),{status:200,headers:{'content-type':'application/json'}});};
 const m=createModelDecision({ledgerPath:join(dir,'journal.json'),getKey:()=>'sk-abcdefghijklmnop',networkCheck:async()=>({ok:true}),transport,profile:{dailyMicros:1000000,formatRecovery:true,intentProtocol:true}});
 t.after(()=>m.close());
 const raw=await m.decide(p);
 assert.equal(sent.length,2,'one mechanical repair');assert.equal(sent[0][0].content,wire.instruction);
 assert.equal(JSON.parse(sent[1].at(-1).content).packetId,wire.packetId,'repair feedback must carry wire packetId, not base packetId');
 assert.match(sent[1].at(-1).content,/packetId/);
 assert.ok(m.ledger.tryFind('turn:'+p.packetId),'journal keyed by the base packet');
 const d=s.session.commit({packet:p,output:raw,decisionId:'dx',requestId:'dx',allowedActionTools:['office_read']});
 assert.equal(d.output.options[0].payload.text,'在呢');
});

test('a correct reply to a tool result is not lost because the model also called it part of the work',async t=>{
 const {SCENARIOS,TOOLS}=await import('../experiments/intent-study/scenarios.mjs');
 const s=SCENARIOS['tool-receipt'].build();t.after(()=>s.store.close());const p=s.prepare(),wire=intentPacket(p);
 assert.equal(JSON.parse(wire.messages[1].content).view.current.attachable,false);
 const d=s.session.commit({packet:p,decisionId:'x',requestId:'x',allowedActionTools:TOOLS,output:JSON.stringify({packetId:wire.packetId,
  decision:{type:'reply',text:'看了，10 个柜子，合计 12 TEU'},work:[{update:'P1',note:'已读 manifest',status:'completed',thisMessage:true}],used:['E0']})});
 assert.equal(d.output.options[0].payload.text,'看了，10 个柜子，合计 12 TEU');
 const audit=[...s.store.all('extension_record')].find(r=>r.stateType==='intent-compilation');
 assert.deepEqual(audit.value.diagnostics.map(x=>x.code).sort(),['CURRENT_NOT_A_MATERIAL_IGNORED','NOT_ATTACHABLE_IGNORED']);
});

test('used is a declaration: non-material or unknown handles are noted, never discard the turn',t=>{
 const s=world(t),p=s.prepare({materials:[{ref:ref(s.n),aspect:'knowledge'}]}),wire=intentPacket(p);
 const d=s.session.commit({packet:p,decisionId:'u1',requestId:'u1',allowedActionTools:['office_read'],output:JSON.stringify({packetId:wire.packetId,decision:{type:'wait'},used:['M1','T1','E0']})});
 assert.deepEqual(d.output.used.map(u=>u.ref.id),['note-port']);
 const p2=s.prepare({materials:[{ref:ref(s.n),aspect:'knowledge'}]});
 const d2=s.session.commit({packet:p2,decisionId:'u2',requestId:'u2',allowedActionTools:['office_read'],output:JSON.stringify({packetId:intentPacket(p2).packetId,decision:{type:'reply',text:'嗯'},used:['M9']})});
 assert.deepEqual(d2.output.used,[]);
});

test('group messages say whether they are aimed at her; private chats are marked private',async()=>{
 const {selfNames}=await import('../src/intent-protocol.mjs');
 assert.deepEqual(selfNames('你叫“阿栈”，大家也叫你小栈。').sort(),['小栈','阿栈']);
 const {SCENARIOS}=await import('../experiments/naturalness/scenarios.mjs');
 const view=name=>{const {s,e,w}=SCENARIOS[name].build();const v=JSON.parse(intentPacket(s.prepare(e,w)).messages[1].content).view;s.store.close();return v.current;};
 assert.deepEqual([view('group-not-for-her').chat,view('group-not-for-her').mentionsYou],['group',false]);
 assert.equal(view('group-secret').mentionsYou,true);
 assert.equal(view('quote-natural').chat,'private');
});

test('intentProtocol: true skips heavy legacy instructions in base packet while keeping verification and fallback intact',t=>{
 const s=world(t),legacy=s.prepare({style:'温和口语'}),compact=s.prepare({style:'温和口语',intentProtocol:true});
 assert.ok(Buffer.byteLength(compact.instruction)<1000,`compact base instruction should skip legacy prompts, got ${Buffer.byteLength(compact.instruction)}`);
 assert.ok(Buffer.byteLength(legacy.instruction)>20000);
 const wire=intentPacket(compact);
 assert.doesNotThrow(()=>verifiedIntent(wire));
 const tampered=structuredClone(compact);tampered.instruction+='\nextra';
 assert.throws(()=>intentPacket(tampered),{code:'PACKET_CHANGED'});
 const {d}=s.answer(compact,{decision:{type:'reply',text:'轻装上阵'}});
 assert.equal(d.output.options[0].payload.text,'轻装上阵');
 const fallback=s.prepare({style:'温和口语',intentProtocol:true,instructionSuffix:'【显式重新准入】测试'});
 assert.ok(Buffer.byteLength(fallback.instruction)>20000,'ineligible turns still retain full base instruction');
 assert.equal(intentEligible(fallback),false);
});

test('ordinary intent wires keep their own budget instead of the autonomy ceiling',async t=>{
 const s=world(t),mats=[];
 for(let i=0;i<24;i++){
  const [rec]=put(s.store,'big'+i,note('big-'+i,[],{body:'port manifest unit check. '.repeat(50)}));
  mats.push({ref:ref(rec.record),aspect:'knowledge'});
 }
 const p=s.prepare({materials:mats}),wire=intentPacket(p);
 assert.ok(wire.bytes>16384,`ordinary wire must not be capped at 16KB, got ${wire.bytes}`);
 assert.ok(wire.bytes<=p.budgetBytes);
});

test('intent-v1 state residences carry no process endpoint, so they are never task bindings',t=>{
 const s=world(t);
 s.answer(s.prepare({intentProtocol:true}),{decision:{type:'wait'},states:[{kind:'feeling',text:'有点想笑'}]});
 const attention=s.store.read(attentionId('jingyang'));
 assert.equal(attention.residences.length,1);
 for(const purpose of attention.residences[0].purposes){
  assert.equal(purpose.kind,'active-task');
  assert.deepEqual(purpose.eventIds,[]);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {intentPacket,verifiedIntent} from '../src/intent-protocol.mjs';
import {admitSubjectEvent} from '../src/continuity.mjs';
import {memoryReminders} from '../src/memory-reminders.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {motivationId} from '../src/affect-contract.mjs';
import {event,frame,memory,note,put,ref} from './helpers.mjs';

const subjectId='test-subject',privateChat='qq/private/test-person',groupChat='qq/group/test-room';
const now=1_800_000_000_000;
const scope=(scenes=[],people=[],validFrom=null,validUntil=null)=>({scenes,people,validFrom,validUntil});
const output=(wire,choice)=>JSON.stringify({packetId:wire.packetId,...choice});
const projection=wire=>JSON.parse(wire.messages[1].content).view;

test('recall uses specific topic evidence, skips chatter and keeps a user pin separate',t=>{
  const {store}=memory(t);
  new ContinuitySession({store,subjectId,attention:true});
  put(store,'notes',
    note('note:core-pinboard',[],{body:'目前想整理桌面的阅读资料。'}),
    note('note:port',[],{body:'北岬港口货单：集装箱数量为十二，需要核对原件。'}),
    note('note:copy',[],{body:'北岬港口货单：集装箱数量为十二，需要核对原件。'}),
    note('note:appendix',[],{body:'北岬港口货单的集装箱编号，另外记录在附录甲。'}),
    note('note:manifest',[],{body:'北岬港口货单的集装箱重量需等称重回执。'}),
    note('note:kitchen',[],{body:'厨房收纳用浅色盒子，贴上标签。'}),
    note('note:sticker',[],{body:'贴纸里那张纸飞机，右上角有蓝边。'}),
    note('note:release',[],{body:'LLM-007 已提交变更，等待审查。'}),
    note('note:noise',[],{body:'今天好累。那天我也刚好说今天好累。'}));
  put(store,'related',{op:'write_link',id:'link:port',expectedRevision:0,from:{id:'note:appendix',revision:1},to:{id:'note:port',revision:1},relation:'related',strength:1,direction:'both',basis:[],status:'active'});
  const collect=(id,text)=>{
    const msg=put(store,id,event(id,{body:text,scene:privateChat,occurredAt:now,actor:'test-person'}))[0];
    return memoryReminders({store,subjectId,event:ref(msg),now});
  };
  for(const [i,text] of ['早安！','今天有点累。','你现在忙吗？','哈哈，谢谢啦'].entries()){
    assert.deepEqual(collect('idle'+i,text).map(m=>m.reminder),['pinboard'],text);
  }
  const result=collect('work','北岬港口的货单上，集装箱数量核实了吗？');
  assert.equal(result.length,3);
  const ids=result.filter(m=>m.reminder==='related').map(m=>m.ref.id);
  assert.ok(ids.some(id=>['note:copy','note:port'].includes(id)));
  assert.ok(ids.includes('note:appendix'));
  assert.ok(!ids.includes('note:kitchen'));
  assert.ok(result.every(m=>m.ref.revision===1));
  assert.deepEqual(collect('sticker','能再发一张纸飞机吗？').map(m=>m.ref.id),['note:core-pinboard','note:sticker']);
  assert.deepEqual(collect('release','帮我把 LLM-007 接着做').map(m=>m.ref.id),['note:core-pinboard','note:release']);
});

test('back-reference uses a recent admitted topic from the same sender and scene',t=>{
  const {store}=memory(t);
  new ContinuitySession({store,subjectId,attention:true});
  put(store,'notes',
    note('note:a',[],{body:'北岬港口货单，集装箱在附录核验。',scope:scope([groupChat])}),
    note('note:b',[],{body:'厨房收纳盒需要测量顶层柜子。',scope:scope([groupChat])}));
  const add=(id,body,scene,actor,at,admitted=true)=>{
    const e=put(store,id,event(id,{body,scene,actor,occurredAt:at}))[0];
    if(admitted)admitSubjectEvent({store,subjectId,event:ref(e),requestId:'admit:'+id});
    return e;
  };
  add('source','北岬港口货单和集装箱清点进度。',groupChat,'test-person',now-10_000);
  add('other-person','厨房收纳盒柜子都到了。',groupChat,'someone-else',now-8000);
  add('other-scene','厨房收纳盒柜子都到了。',privateChat,'test-person',now-5000);
  add('unadmitted','厨房收纳盒柜子都到了。',groupChat,'test-person',now-2000,false);
  const ask=add('ask','上次那个项目后来呢？',groupChat,'test-person',now);
  assert.deepEqual(memoryReminders({store,subjectId,event:ref(ask),now}).map(m=>m.ref.id),['note:a']);
});

test('reminders reject other scenes, other people, private provenance and stale versions',t=>{
  const {store}=memory(t);
  new ContinuitySession({store,subjectId,attention:true});
  const body='北岬港口货单的集装箱数量需要核验。';
  const [priv,msg]=put(store,'events',event('private-evidence',{scene:privateChat,body}),event('group-query',{scene:groupChat,body,actor:'test-person'}));
  admitSubjectEvent({store,subjectId,event:ref(priv),requestId:'admit:priv'});
  const [source]=put(store,'source',note('inner',[ref(priv)],{body,scope:scope([privateChat])}));
  put(store,'notes',
    note('note:core-pinboard',[],{body,scope:scope([privateChat])}),
    note('note:expired',[],{body,scope:scope([groupChat],[],null,now)}),
    note('note:future',[],{body,scope:scope([groupChat],[],now+1)}),
    note('note:wrong-person',[],{body,scope:scope([groupChat],['different-person'])}),
    note('note:derived',[ref(source.record)],{body,scope:scope([groupChat])}),
    note('note:unscoped',[],{body}),
    note('note:group-but-personal',[],{body,scope:scope([groupChat],['test-person'])}),
    note('note:allowed',[],{body,scope:scope([groupChat])}));
  const [old]=put(store,'old',note('old-note',[],{body:'曾用简称',scope:scope([groupChat])}));
  put(store,'stale',note('note:stale',[ref(old.record)],{body,change:'reinterpretation',scope:scope([groupChat])}));
  put(store,'update',note('old-note',[],{body:'更新后的简称',expectedRevision:1,scope:scope([groupChat])}));
  assert.deepEqual(memoryReminders({store,subjectId,event:ref(msg),now}).map(m=>m.ref.id),['note:allowed']);
});

test('service delivers a pinned recall, and plain memo commits as an impression with real grounds',async()=>{
  const delivered=[];
  const service=createBrainService({subjectId,global:true,intentProtocol:true,timezoneMinutes:-300,
    cognition:{subjectiveMemoryV2:true},clock:()=>now,
    decide(packet){
      const wire=intentPacket(packet),view=projection(wire);delivered.push({packet,wire,view});
      const card=view.materials.find(m=>m.from==='想起的旧笔记');
      return output(wire,{decision:{type:'reply',text:'我先核对货单。'},used:[card.handle],memo:'北岬港口的货单要先核对集装箱数量。'});
    }});
  try{
    const [source]=put(service.store,'recall-seed',note('note:port',[],{body:'北岬港口货单上，集装箱数量为十二。'}));
    const r=await service.reply({scene:'local/chat',text:'查一下北岬港口货单的集装箱数量。',source:'local-test',key:'chat',message_id:'one'});
    assert.equal(r.ok,true);
    const {packet,wire,view}=delivered[0];
    assert.equal(view.timeFeel.utcOffsetMinutes,-300);
    assert.ok(view.materials.some(m=>wire.handles[m.handle].ref.id===source.record.id&&m.text===source.record.body));
    assert.equal(view.lookup.remaining,2,'unsolicited recall does not spend the explicit lookup budget');
    assert.doesNotThrow(()=>verifiedIntent(wire));
    const impression=[...service.store.all('personal_state')].find(x=>x.kind==='impression');
    assert.deepEqual(impression.basis.observations,[ref(packet.payload.current)]);
    assert.equal(impression.stage,'recent');
    const committed=[...service.store.all('decision')].at(-1);
    assert.deepEqual(committed.output.used.map(u=>u.ref),[ref(source.record)]);
  }finally{service.close();}
});

test('new projection preserves legacy wire verification and keeps full validation',t=>{
  const {store}=memory(t);
  const session=new ContinuitySession({store,subjectId,attention:true});
  const [e,w]=put(store,'setup',event('first'),frame());
  const args={currentEvent:ref(e),workspace:ref(w),mind:true,workbenchFocus:true,workbenchMaterials:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},now,budgetBytes:131072};
  const legacy=intentPacket(session.prepare(args)),packet=session.prepare({...args,intentProtocol:true}),wire=intentPacket(packet);
  assert.doesNotThrow(()=>verifiedIntent(legacy));
  assert.ok(wire.instruction.length<legacy.instruction.length*0.7,[wire.instruction.length,legacy.instruction.length].join(' vs '));
  assert.throws(()=>session.commit({packet,output:output(wire,{decision:{type:'act',tool:'qq_send_message'},memo:'同行便签'}),decisionId:'bad',requestId:'bad'}),{code:'TOOL_NOT_GRANTED'});
  assert.equal(store.read('bad'),null);
  assert.equal([...store.all('personal_state')].length,0);
});

test('a shared workspace only shows last reply text in its actual conversation',t=>{
  const {store}=memory(t),session=new ContinuitySession({store,subjectId,attention:true});
  const [workspace,a,b,group]=put(store,'conversations',frame({scene:'global'}),
    event('a',{scene:privateChat}),event('b',{scene:privateChat}),event('group',{scene:groupChat,actor:'different-person'}));
  const prepare=current=>session.prepare({currentEvent:ref(current),workspace:ref(workspace),mind:true,unified:true,
    workbenchFocus:true,workbenchMaterials:true,localLookupPolicy:{maxReads:2,maxHits:4},intentProtocol:true,now,budgetBytes:131072});
  const packet=prepare(a);
  session.commit({packet,output:output(intentPacket(packet),{decision:{type:'reply',text:'私聊测试记号 orange-harbor'}}),decisionId:'reply-a',requestId:'reply-a'});
  const other=projection(intentPacket(prepare(group)));
  assert.doesNotMatch(JSON.stringify(other),/orange-harbor/);
  assert.equal(other.lastAction,undefined);
  assert.equal(projection(intentPacket(prepare(b))).lastAction.where,privateChat);
});

test('a malformed memo turns into bounded feedback for the same chat without replaying the turn',async()=>{
  const seen=[];
  const service=createBrainService({subjectId,global:true,intentProtocol:true,clock:()=>now,storage:{clock:()=>now},decide(packet){
    const wire=intentPacket(packet),view=projection(wire);
    seen.push(view);
    return output(wire,{decision:{type:'reply',text:'收到。'},...(seen.length===1?{memo:{text:'格式错误的便签'}}:{})});
  }});
  const send=(id,scene)=>service.reply({scene,text:'你好。',source:'test',key:id,message_id:id});
  try{
    const rejected=await send('bad','local/chat');
    assert.equal(rejected.error,'INTENT_SHAPE');
    assert.equal((await send('other','local/other')).ok,true);
    assert.equal((await send('new','local/chat')).ok,true);
    assert.equal(seen.length,3);
    assert.ok(!seen[1].hostFeedback?.some(x=>x.kind==='input-feedback'));
    assert.deepEqual(seen[2].hostFeedback?.find(x=>x.kind==='input-feedback'),
      {kind:'input-feedback',adopted:false,error:'INTENT_SHAPE',field:'memo[0]'});
    assert.equal([...service.store.all('decision')].length,2);
  }finally{service.close();}
});

test('compact lookup labels a partial page and lets the model read the next page',async()=>{
  const pages=[];
  const service=createBrainService({subjectId,global:true,intentProtocol:true,clock:()=>now,decide(packet){
    const wire=intentPacket(packet),{lookup}=projection(wire);
    const page=lookup.done?.at(-1);
    pages.push(page??null);
    if(!page)return output(wire,{decision:{type:'lookup',terms:['雨燕清单']}});
    if(page.more)return output(wire,{decision:{type:'lookup',open:page.more}});
    return output(wire,{decision:{type:'reply',text:'两页都看到了。'}});
  }});
  try{
    put(service.store,'pages',...Array.from({length:5},(_,n)=>note('page-note-'+n,[],{body:'雨燕清单第 '+n+' 项。'})));
    const reply=await service.reply({scene:'local/chat',key:'lookup',text:'帮忙查一下清单。',message_id:'pages',source:'test'});
    assert.equal(reply.ok,true,JSON.stringify(reply));
    assert.deepEqual(pages,[null,{status:'found',found:4,delivered:4,total:5,partial:true,more:'L1'},
      {status:'found',found:1,delivered:1,total:5,partial:false}]);
    assert.deepEqual([...service.store.all('lookup_result')].map(result=>result.offset).sort((a,b)=>a-b),[0,4]);
  }finally{service.close();}
});

test('real Limbic initialization feeds a read-only autonomy view and the same core turn commits',async t=>{
  const {store,setTime}=memory(t);
  setTime(now);
  const session=new AffectSession({store,subjectId});
  const initial=await session.initialize(now-60_000);
  const [workspace]=put(store,'autonomy-workspace',frame({id:'agent/autonomy',scene:'agent/autonomy'}));
  const packet=await session.prepareAutonomy({workspace:ref(workspace),opportunity:1,now,timezoneMinutes:-300});
  const wire=intentPacket(packet),view=projection(wire);
  assert.ok(view.feltSense.text);
  assert.equal(view.feltSense.asOf,'1分钟前');
  assert.equal(packet.payload.continuity.motivation.canAppraiseCurrent,false);
  const raw=await session.invoke(packet,()=>output(wire,{decision:{type:'none'}}));
  const decision=await session.commit({packet,output:raw,decisionId:'idle',requestId:'idle'});
  assert.equal(decision.type,'decision');
  assert.equal(store.read(motivationId(subjectId)).revision,initial.revision);
  assert.equal([...store.all('affect_turn')].length,0);
});

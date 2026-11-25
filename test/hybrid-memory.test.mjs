import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {SemanticMemory} from '../src/memory-semantic.mjs';
import {memoryReminders} from '../src/memory-reminders.mjs';
import {intentPacket} from '../src/intent-protocol.mjs';
import {keepAttention} from '../src/attention.mjs';
import {admitSubjectEvent} from '../src/continuity.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {runSlowBrainConsolidation} from '../src/slow-brain.mjs';
import {disk,event,fixtureJournal,frame,modelJSON,note,put,ref} from './helpers.mjs';

const now=1_800_000_000_000,subjectId='fixture-hybrid',group='qq/group/fixture-room';
const sceneA='qq/private/fixture-window-a',sceneB='qq/private/fixture-window-b';
const sender={system:'qq',id:'fixture-contact',name:'测试联系人',entityId:'person:qq:fixture-contact',isOwner:false};
const other={system:'qq',id:'fixture-other',name:'另一联系人',entityId:'person:qq:fixture-other',isOwner:false};
const policy={maxReads:2,maxHits:4};
const scoped=(scenes=[],people=[])=>({scenes,people,validFrom:null,validUntil:null});
function world(t,path=':memory:'){
  const store=new ContinuityStore(path,{clock:()=>now});t.after(()=>store.close());
  const session=new ContinuitySession({store,subjectId,attention:true});
  const [workspace]=put(store,'workspace:'+Date.now(),frame({scene:'global'}));
  const admit=(id,body,scene,who,at=now)=>{
    const [e]=put(store,id,event(id,{body,scene,sender:who,actor:who?.entityId??'fixture',occurredAt:at}));
    admitSubjectEvent({store,subjectId,event:ref(e),requestId:'admit:'+id});
    return e;
  };
  const prepare=current=>session.prepare({currentEvent:ref(current),workspace:ref(workspace),mind:true,unified:true,
    workbenchFocus:true,workbenchMaterials:true,taskThreads:true,subjectiveMemoryV2:true,localLookupPolicy:policy,
    intentProtocol:true,now,budgetBytes:131072});
  return {store,session,admit,prepare};
}
const reminders=(store,e,semantic=[])=>store.view(()=>memoryReminders({store,subjectId,event:ref(e),now,semantic}));
const compact=(packet,decision,extra={})=>({packetId:intentPacket(packet).packetId,decision,...extra});
function commitLookup(w,current,id,query){
  const packet=w.prepare(current);
  return w.session.commit({packet,decisionId:id,requestId:id,output:{
    packetId:packet.packetId,options:[{id:'q',kind:'lookup',payload:query}],selected:'q',summary:'查看材料',used:[],
    continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()},
  }});
}

test('whole-library recall follows proven identity across windows and keeps the audience sealed',t=>{
  const {store,admit}=world(t);
  const start=admit('start','雕刻进度确认。',sceneA,sender,now-3_600_000);
  put(store,'notes',
    note('cross-window',[ref(start)],{body:'琥珀观景塔，阁楼屋顶已经封好。',scope:scoped([], [sender.entityId])}),
    note('same-scene-only',[],{body:'琥珀观景塔单窗限定。',scope:scoped([sceneA])}));
  const query='琥珀观景塔的阁楼屋顶怎样了？';
  const same=admit('same',query,sceneB,sender);
  const unrelated=admit('different',query,'qq/private/other-window',other);
  const publicRoom=admit('group',query,group,sender);
  assert.deepEqual(reminders(store,same).map(m=>m.ref.id),['cross-window']);
  assert.deepEqual(reminders(store,unrelated),[]);
  assert.deepEqual(reminders(store,publicRoom),[]);
});

test('same audience rule covers compact terms and direct open before counts and pagination',t=>{
  const w=world(t);
  const root=w.admit('private-source','只有私聊收到的内容。',sceneA,sender,now-1000);
  put(w.store,'lookup-seed',
    note('group-visible',[],{body:'沼泽穹顶公开进度。',scope:scoped([group])}),
    note('private-note',[ref(root)],{body:'沼泽穹顶 SECRET_PRIVATE。'}),
    ...Array.from({length:7},(_,n)=>note('private-'+n,[ref(root)],{body:'沼泽穹顶 HIDDEN '+n})));
  const current=w.admit('group-in','查一下记录。',group,sender);
  const reader=new LocalLookupSession({store:w.store,subjectId,policy});
  const result=reader.execute({decision:ref(commitLookup(w,current,'find',{terms:['沼泽穹顶']}))});
  assert.equal(result.total,1);
  assert.equal(result.nextOffset,null);
  assert.deepEqual(result.entries.map(e=>e.ref.id),['group-visible']);
  const pinned=reader.execute({decision:ref(commitLookup(w,current,'open-private',{ref:{id:'private-note',revision:1}}))});
  assert.equal(pinned.outcome,'not-found');
  assert.equal(pinned.total,0);
  assert.deepEqual(pinned.entries,[]);
});

test('a named Process finds pinned outcomes even when the text uses unrelated words',t=>{
  const w=world(t);
  const start=w.admit('work-source','把红石电路的地线独立接出来，验收完成。',sceneA,sender,now-3_600_000);
  const p=w.prepare(start);
  w.session.commit({packet:p,decisionId:'work-start',requestId:'work-start',output:compact(p,{type:'none'},
    {work:[{title:'蓝港排障',note:'继续检查',thisMessage:true}]})});
  const later=w.admit('carry','我们继续蓝港排障。',sceneB,sender);
  assert.ok(reminders(w.store,later).some(r=>r.ref.id===start.id&&r.aspect==='experience'));
});

test('person memory and recent impressions participate without copying ordinary chat logs',t=>{
  const w=world(t);
  const first=w.admit('preference','说过平常周末骑车。',sceneA,sender,now-3_600_000);
  const p=w.prepare(first);
  w.session.commit({packet:p,decisionId:'note-memo',requestId:'note-memo',output:compact(p,{type:'none'},{memo:'骑公路自行车，每周日清晨出门。'})});
  put(w.store,'anchor',note('person-work',[],{body:'偏爱在北坡长途骑行。',anchor:{kind:'entity',id:sender.entityId}}));
  const personal=w.admit('person-query','你还记得我喜欢啥吗？',sceneB,sender);
  assert.ok(reminders(w.store,personal).some(m=>m.ref.id==='person-work'));
  const search=w.admit('memo-query','公路自行车每周日要几点出门？',sceneB,sender);
  assert.ok(reminders(w.store,search).some(m=>m.state===true&&w.store.read(m.ref.id).body.includes('每周日')));
});

test('derived lexical index follows committed revisions and can rebuild after reopening',t=>{
  const file=disk(t),w=world(t,file),save=(expectedRevision,body,status='current')=>put(w.store,'edit:'+expectedRevision,
    note('index-checked',[],{expectedRevision,body,status}));
  save(0,'鸽子传信的卷轴收在书架。');
  const q=w.admit('version-q','鸽子传信的卷轴收在哪？','local/chat',null);
  assert.ok(reminders(w.store,q).some(r=>r.ref.id==='index-checked'));
  save(1,'风雨长廊的进度等复核。');
  assert.ok(!reminders(w.store,q).some(r=>r.ref.id==='index-checked'));
  w.store.close();
  const reopened=new ContinuityStore(file,{clock:()=>now});
  try{
    assert.ok(!reminders(reopened,q).some(r=>r.ref.id==='index-checked'));
    const newQ=put(reopened,'new-q',event('new-q',{scene:'local/chat',body:'风雨长廊的进度复核了吗？'}))[0];
    assert.ok(reminders(reopened,newQ).some(r=>r.ref.id==='index-checked'&&r.ref.revision===2));
  }finally{reopened.close();}
});

test('optional semantic lane reaches both live protocol paths and checks versions',async()=>{
  const select=text=>/湖岸/u.test(text)?[1,0.2,0]:[1,0,0];
  const inputs=[];
  const semanticMemory=new SemanticMemory({encode:async texts=>texts.map(select),deadlineMs:500,rerank:async(query,passages)=>{
    inputs.push({query,passages});
    return passages.map(text=>text.startsWith('湖岸')?-2:-5);
  }});
  const delivered=[];
  const service=createBrainService({subjectId,clock:()=>now,storage:{clock:()=>now},global:true,intentProtocol:true,semanticMemory,
    decide(packet){
      const wire=intentPacket(packet),view=JSON.parse(wire.messages[1].content).view;
      delivered.push(view.materials?.map(row=>row.text)??[]);
      const decision=view.lookup.done?{type:'reply',text:'接着做。'}:{type:'lookup',terms:['水边的房子']};
      return {packetId:wire.packetId,decision};
    }});
  try{
    put(service.store,'semantic',note('nearby',[],{body:'湖岸木屋已经搭好屋檐。'}),note('other',[],{body:'书架分类按年份。'}),
      note('hidden',[],{body:'湖岸木屋私密资料。',scope:scoped([sceneA])}));
    await semanticMemory.indexBatch({store:service.store,subjectId});
    const r=await service.reply({scene:'local/chat',source:'synthetic',text:'水边的房子继续盖吧。',key:'hybrid',message_id:'semantic-q'});
    assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal(delivered.length,2);
    for(const rows of delivered){
      assert.ok(rows.includes('湖岸木屋已经搭好屋檐。'));
      assert.ok(!rows.includes('书架分类按年份。'));
    }
    assert.equal(inputs.length,2);
    assert.ok(inputs.every(x=>!x.passages.some(text=>text.includes('私密'))));
    const result=[...service.store.all('lookup_result')][0];
    assert.ok(result.semanticHints.some(x=>x.ref.id==='nearby'&&x.relevance===-2));
    put(service.store,'remove',note('nearby',[],{expectedRevision:1,body:'暂时撤下。',status:'suspended'}));
    const e=[...service.store.all('event')].find(row=>row.body==='水边的房子继续盖吧。');
    assert.ok(e);
    assert.ok(!reminders(service.store,e,[{ref:{id:'nearby',revision:1},similarity:1}]).some(x=>x.ref.id==='nearby'));
  }finally{service.close();}
});

test('automatic reminders select complementary facts for the named project and abstain on a missing subject',t=>{
  const {store,admit}=world(t);
  put(store,'recall-choices',
    note('progress',[],{body:'湖边木屋的楼梯已搭好下半段，确定朝东。'}),
    note('next-step',[],{body:'湖边木屋的楼梯下一步装扶手。'}),
    note('wrong-project',[],{body:'湖边仓房的楼梯下一步装扶手，确定朝西。'}),
    note('unrelated-shared-word',[],{body:'鸽子每天在钟楼东侧觅食。'}));
  const both=admit('both','湖边木屋的楼梯上次做到哪了，下一步呢？','local/chat',null);
  assert.deepEqual(reminders(store,both).map(row=>row.ref.id),['progress','next-step']);
  const missing=admit('missing','还记得鸽子船的船票价格吗？','local/chat',null);
  assert.deepEqual(reminders(store,missing),[]);
});

test('an exact identifier remains available even when reranking scores it low',t=>{
  const {store,admit}=world(t);
  put(store,'tickets',note('correct',[],{body:'JY-271 的阻塞原因是缺少截图。'}),
    note('other',[],{body:'JY-217 已关闭。'}));
  const trigger=admit('ticket','再看看 JY-271 卡在哪里？','local/chat',null);
  const semantic=[{ref:{id:'correct',revision:1},similarity:0.9,relevance:-4},
    {ref:{id:'other',revision:1},similarity:0.95,relevance:-5}];
  assert.deepEqual(reminders(store,trigger,semantic).map(row=>row.ref.id),['correct']);
});

test('a failed local reranker leaves dense hints available',async t=>{
  const {store,admit}=world(t);
  put(store,'fallback',note('remaining',[],{body:'观景塔楼梯的扶手已装好。'}));
  const trigger=admit('recall-fallback','观景塔楼梯进度如何？','local/chat',null);
  const memory=new SemanticMemory({encode:async texts=>texts.map(()=>[1,0]),
    rerank:async()=>{throw new Error('missing test weights');},deadlineMs:200});
  t.after(()=>memory.stop());
  await memory.indexBatch({store,subjectId});
  const input={store,subjectId,event:trigger,now,text:trigger.body};
  assert.deepEqual((await memory.find(input)).map(x=>x.ref.id),['remaining']);
  assert.equal(memory.status.failed,false);
  assert.equal(memory.status.rerankerFailed,true);
  assert.deepEqual((await memory.find(input)).map(x=>x.ref.id),['remaining']);
});

test('slow-brain synthesis stays on the desktop and preserves existing note scopes',async t=>{
  const {store,admit}=world(t);
  admit('orig-private','青铜钥匙放在松木盒子里。',sceneA,sender);
  admit('own-desk','蓝色玻璃整理盒在书柜下一层。','local/chat',null);
  put(store,'one-scoped',note('one-scoped',[],{body:'青铜钥匙只允许在原私聊谈及。',scope:scoped([sceneA])}));
  const consolidation=await runSlowBrainConsolidation({store,subjectId,now,live:true,apiKey:'fixture',journal:fixtureJournal(t),
    fetchImpl:async(_url,init)=>{
      const parts=JSON.parse(init.body).messages;
      const input=JSON.parse(parts[1].content);
      if(!input.atoms)return modelJSON({atoms:[
        {id:'A1',body:'青铜钥匙放在松木盒子里。',evidence:['E1']},
        {id:'A2',body:'蓝色玻璃整理盒在书柜下一层。',evidence:['E2']},
      ]});
      assert.ok(!input.candidateNotes.some(n=>n.body.includes('只允许在原私聊谈及')));
      return modelJSON({journal:'我记下了青铜钥匙。',pinboardBlocks:{recentFocus:'青铜钥匙在松木盒子。'},
        decisions:[{atomId:'A1',op:'ADD'},{atomId:'A2',op:'ADD'}]});
    }});
  assert.equal(consolidation.notesCreated,2);
  assert.equal(consolidation.notesArchived,0);
  assert.equal(consolidation.notesUpdated,0);
  assert.deepEqual(store.read('one-scoped').scope.scenes,[sceneA]);
  assert.deepEqual(store.read('note:core-pinboard').scope.scenes,['local/chat']);
  const ask='青铜钥匙放在哪里？';
  assert.deepEqual(reminders(store,admit('other-asks',ask,sceneB,other)),[]);
  const desktop=reminders(store,admit('desk-asks','蓝色玻璃整理盒放在哪里？','local/chat',null));
  assert.ok(desktop.some(row=>row.reminder==='pinboard'));
  assert.ok(desktop.some(row=>row.reminder==='related'&&row.ref.id.startsWith('note:slow:')));
});

test('remember_note retains the source of a private conversation without a model supplied scope',async()=>{
  const service=createBrainService({subjectId,global:true,intentProtocol:true,allowedActionTools:['remember_note'],decide(packet){
    const wire=intentPacket(packet),view=JSON.parse(wire.messages[1].content).view;
    return {packetId:wire.packetId,decision:view.current.kind==='tool-result'?{type:'none'}:
      {type:'act',tool:'remember_note',args:{body:'玄武石城墙的秘密修建方法。'}}};
  }});
  try{
    const result=await service.reply({scene:sceneA,sender,text:'把这项做法记下来。',source:'synthetic',key:'memo',message_id:'native-evidence',execute:true});
    assert.equal(result.ok,true,JSON.stringify(result));
    const saved=[...service.store.all('note')].find(n=>n.body.startsWith('玄武石城墙'));
    assert.equal(saved?.evidence.length,1);
    assert.equal(service.store.read(saved.evidence[0].id,saved.evidence[0].revision).scene,sceneA);
  }finally{service.close();}
});

test('semantic warmup indexes beyond one batch and stops cleanly',async()=>{
  const rows=Array.from({length:30},(_,n)=>({id:'note-'+n,revision:1,position:n+1,body:'样本 '+n}));
  const store={memoryEmbeddingChanges:({after,limit})=>rows.slice(after,after+limit)};
  const memory=new SemanticMemory({encode:async texts=>texts.map(()=>[1,0])});
  try{
    memory.warm({store,subjectId});
    for(let n=0;n<100&&memory.status.indexed<30;n++)await delay(12);
    assert.equal(memory.status.indexed,30);
  }finally{memory.stop();}
});

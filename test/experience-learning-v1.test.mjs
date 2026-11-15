import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {keepAttention} from '../src/attention.mjs';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {ExperienceLearningSession} from '../src/learning-session.mjs';
import {digest} from '../src/contracts.mjs';
import {resolveBrainConfig} from '../tools/brain-service/runtime-config.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {testEvidence} from '../experiments/review-tools/evidence-run.mjs';

const archive=testEvidence('experience-learning-v1'),pin=r=>({id:r.id,revision:r.revision});
const proposal=(p,extra={})=>({packetId:p.packetId,options:[{id:'next',kind:'wait',payload:{}}],selected:'next',summary:'没有必要形成经验',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},attention:keepAttention(),...(p.stage==='reflection'?{}:{expressionChoice:null,observationDisposition:'handled'})},...extra});
const lesson=(evidence,extra={})=>({lesson:'提交配置前先读当前版本',conditions:'配置可能由多个进程更新',scope:'仅隔离配置工具；其他环境未验证',status:'tentative',
  evidence:[{ref:evidence,nature:'receipt'}],unknowns:['一次错误不能证明普遍规律'],...extra});
function fixture(t){
  let now=1800000000000,n=0;
  const path=join(mkdtempSync(join(tmpdir(),'jy-experience-')),'subject.sqlite');
  let store=new ContinuityStore(path,{clock:()=>++now}),session;
  store.execute({requestId:'seed',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'配置实验'}},
    {op:'append_event',id:'q',body:'准备更新配置',origin:'observed',actor:'fixture',scene:'synthetic',occurredAt:now,source:{system:'fixture',key:'q'}},
    {op:'propose_action',id:'a',workspace:{id:'w',revision:1},tool:'fixture.patch',args:{version:1},inputRefs:[{id:'q',revision:1}]},
    {op:'record_receipt',actionId:'a',expectedRevision:1,eventId:'r',body:'参数校验拒绝，外部配置未修改',status:'failed',actor:'fixture',occurredAt:now+1,source:{system:'fixture',key:'r'}}]});
  session=new ContinuitySession({store,subjectId:'s',attention:true,maxForeground:16});
  const prep=(args={})=>session.prepare({currentEvent:{id:'r',revision:1},workspace:{id:'w',revision:1},mind:true,unified:true,
    workbenchFocus:true,workbenchMaterials:true,workbenchRecovery:true,experienceLearningV1:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,...args});
  const commit=(p,extra={})=>{const id='d'+(++n);return session.commit({packet:p,output:proposal(p,extra),decisionId:id,requestId:id,allowedActionTools:['fixture.patch']});};
  t.after(()=>{archive.write('case-'+path.split(/[\\/]/).at(-2)+'.json',{notes:[...store.all('note')],decisions:[...store.all('decision')],attempts:[...store.all('decision_attempt')],actions:[...store.all('action')]});store.close();});
  return {get store(){return store;},get session(){return session;},path,prep,commit,
    reopen(){store.close();store=new ContinuityStore(path,{clock:()=>++now});session=new ContinuitySession({store,subjectId:'s',attention:true,maxForeground:16});},
    readNote(){return [...store.all('note')].find(n=>n.id.startsWith('lesson:'));}};
}

test('formation is optional; receipt persistence does not automatically create a lesson',t=>{
  const f=fixture(t);f.commit(f.prep());assert.equal(f.readNote(),undefined);
  const d=f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});
  const note=f.readNote(),body=JSON.parse(note.body);
  assert.equal(body.status,'tentative');assert.equal(body.subject,'s');assert.deepEqual(body.previous,null);
  assert.deepEqual(note.evidence,[{id:'r',revision:1}]);assert.equal(d.output.lessons.length,1);
  assert.equal(note.confidence,'tentative');assert.equal(note.kind,'skill');
});

test('restart retains the exact note, provenance and schema 11 without migration',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const note=f.readNote();f.reopen();
  assert.deepEqual(f.store.read(note.id,1),note);
  const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);}finally{db.close();}
});

test('recent directory is not body delivery: lookup must read pinned note before use or revision',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const note=f.readNote(),p=f.prep();
  assert.equal(p.payload.experienceLearning.directory[0].ref.id,note.id);assert.equal(p.payload.materials.length,0);
  assert.throws(()=>f.commit(p,{used:[{ref:pin(note),aspect:'knowledge',effect:'support'}]}),e=>e.code==='UNDELIVERED_REFERENCE');
  const d=f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1},{ref:pin(note)})]});
  assert.equal(d.output.lessons.length,1); // retained proposal is not evidence of a successful write
  assert.equal(f.readNote().revision,1);
  const query=f.commit(f.prep(),{options:[{id:'next',kind:'lookup',payload:{terms:['提交配置']}}]}),lookup=new LocalLookupSession({store:f.store,subjectId:'s',policy:{maxReads:2,maxHits:4}});
  const result=lookup.execute({decision:pin(query)}),p2=f.prep({lookupResults:[pin(result)]});
  assert.ok(p2.payload.materials.some(m=>m.ref.id===note.id&&m.record.body===note.body));
});

test('same delivered experience can be adopted, opposed, considered uncertain, or ignored',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const note=f.readNote();
  for(const effect of ['support','oppose','context','uncertain',null]){
    const d=f.commit(f.prep({materials:[{ref:pin(note),aspect:'knowledge'}]}),{summary:effect??'忽略，不适用于当前环境',used:effect?[{ref:pin(note),aspect:'knowledge',effect}]:[]});
    assert.equal(d.output.used.length,effect?1:0);assert.equal(f.readNote().revision,1);
  }
});

test('unknown/failed/interrupted/proposed actions do not automatically promote knowledge or retry',t=>{
  const f=fixture(t);
  f.store.execute({requestId:'unknown',commands:[{op:'propose_action',id:'pending',workspace:{id:'w',revision:1},tool:'fixture.patch',args:{},inputRefs:[{id:'q',revision:1}]}]});
  f.commit(f.prep());assert.equal(f.readNote(),undefined);assert.equal(f.store.read('pending').status,'proposed');
  const p=f.prep({currentEvent:{id:'q',revision:1}});
  const d=f.commit(p,{lessons:[lesson({id:'q',revision:1})]});
  assert.equal(d.output.lessons.length,1); // retained proposal is not evidence of a successful write
  assert.equal(f.readNote(),undefined);
  // It is legitimate to retain a tentative interpretation of uncertainty, never a fabricated receipt.
  f.commit(f.prep({currentEvent:{id:'q',revision:1}}),{lessons:[lesson({id:'q',revision:1},{evidence:[{ref:{id:'q',revision:1},nature:'observation'}],lesson:'待确认结果前不要重发',unknowns:['执行结果仍未知']})]});
  assert.equal(JSON.parse(f.readNote().body).status,'tentative');assert.equal(f.store.read('pending').revision,1);
  for(const status of ['interrupted','cancelled']){
    f.store.execute({requestId:status,commands:[{op:'propose_action',id:status,workspace:{id:'w',revision:1},tool:'fixture.patch',args:{},inputRefs:[{id:'q',revision:1}]},
      {op:'record_receipt',actionId:status,expectedRevision:1,eventId:status+'-r',body:'中断或取消；外部结果仍未知',status,actor:'fixture',source:{system:'fixture',key:status}}]});
    f.commit(f.prep({currentEvent:{id:status+'-r',revision:1}}));assert.equal(f.store.read(status).status,status);assert.equal(f.readNote().revision,1);
  }
});

test('optional malformed lesson degrades locally, retains raw attempt and does not erase a valid decision',t=>{
  const f=fixture(t);const d=f.commit(f.prep(),{lessons:[lesson({id:'missing',revision:1}),lesson({id:'r',revision:1})]});
  assert.equal(d.output.lessons.length,2);assert.ok(f.readNote());
  const raw=f.store.read(d.id+':attempt');assert.equal(raw.output.lessons.length,2);
  assert.ok(!f.readNote().evidence.some(e=>e.id==='missing'));
  const receipt=f.prep().payload.experienceLearning.lastSubmission;
  assert.deepEqual(receipt.items.map(i=>i.status),['not-saved','saved']);assert.deepEqual(receipt.items[1].ref,pin(f.readNote()));
});

test('revision preserves original bytes and roots; stale, foreign and unread versions cannot overwrite',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const old=f.readNote();
  const p=f.prep({materials:[{ref:pin(old),aspect:'knowledge'}]});
  f.commit(p,{lessons:[lesson({id:'r',revision:1},{ref:pin(old),status:'contested',conditions:'只有版本读取不会过期时，才可能有效'})]});
  assert.equal(f.readNote().revision,2);assert.deepEqual(f.store.read(old.id,1),old);assert.deepEqual(JSON.parse(f.readNote().body).previous,pin(old));
  // A new packet can deliberately read a historical version, but it cannot use it as the update base.
  f.commit(f.prep({materials:[{ref:pin(old),aspect:'knowledge'}]}),{lessons:[lesson({id:'r',revision:1},{ref:pin(old)})]});
  assert.equal(f.readNote().revision,2);
  const other=new ContinuitySession({store:f.store,subjectId:'other',attention:true});
  const p2=other.prepare({currentEvent:{id:'r',revision:1},workspace:{id:'w',revision:1},materials:[{ref:pin(f.readNote()),aspect:'knowledge'}],experienceLearningV1:true,mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072});
  const d=other.commit({packet:p2,output:proposal(p2,{lessons:[lesson({id:'r',revision:1},{ref:pin(f.readNote())})]}),decisionId:'other-d',requestId:'other-d'});
  assert.equal(d.output.lessons.length,1); // retained proposal is not evidence of a successful write
  assert.equal(f.readNote().revision,2);assert.equal(p2.payload.experienceLearning.total,0);
});

test('business transaction rollback includes lesson writes if action permissions fail',t=>{
  const f=fixture(t),p=f.prep();
  assert.throws(()=>f.commit(p,{lessons:[lesson({id:'r',revision:1})],options:[{id:'next',kind:'act',payload:{tool:'not-granted',args:{}}}]}),e=>e.code==='TOOL_NOT_GRANTED');
  assert.equal(f.readNote(),undefined);assert.equal([...f.store.all('decision')].length,0);
});

test('directory and context budget remain bounded without delivering all lessons or evidence',t=>{
  const f=fixture(t);for(let i=0;i<6;i++)f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1},{lesson:'局部经验 '+i})]});
  const p=f.prep();assert.equal(p.payload.experienceLearning.total,6);assert.equal(p.payload.experienceLearning.directory.length,3);
  assert.equal(p.payload.experienceLearning.hasMore,true);assert.equal(p.payload.materials.length,0);
  assert.throws(()=>f.prep({budgetBytes:p.bytes-1}),e=>e.code==='INPUT_OVERFLOW');
  assert.equal([...f.store.all('note')].length,6);
});

test('ordinary, reflection and task entries share optional capability and existing handoff',async t=>{
  const f=fixture(t),seen=[],driver=new TurnDriver({store:f.store,subjectId:'s',workspace:{id:'w',revision:1},experienceLearningV1:true,maxForeground:16,
    decide:p=>{seen.push(p);return JSON.stringify(proposal(p,{summary:'保留经验问题，但不强制学习'}));}});
  driver.ingest({key:'ordinary',body:'合成问题',scene:'synthetic',actor:'fixture'});await driver.tick({now:1800000010000,eventBypass:true});
  await driver.tick({now:1800008000000,idleReflection:true,localHour:12});
  const task=new AgentRuntime().createTask({id:'task:experience',goal:'只读练习',subjectId:'s',metadata:{allowedTools:[]}});
  f.store.execute({requestId:'put-task',commands:[{op:'put_agent_task',task,expectedRevision:0}]});
  await driver.decideTaskStep(task,{now:1800008000001,maxModelCalls:1});
  assert.equal(seen.length,3);assert.equal(seen[1].stage,'reflection');assert.ok(seen[2].payload.task);
  assert.ok(seen.every(p=>p.payload.experienceLearning.enabled&&p.instruction.includes('【可选经验学习 V1】')));
  assert.ok(seen[1].payload.previousDecisions.length>0);assert.equal(f.readNote(),undefined);
});

test('standard service feature is opt-in and does not expand tools, token budget or default behavior',async t=>{
  const a=resolveBrainConfig({root:process.cwd(),env:{JY_AFFECT:'0'}}),b=resolveBrainConfig({root:process.cwd(),env:{JY_AFFECT:'0',JY_EXPERIENCE_LEARNING_V1:'1'}});
  assert.equal(a.cognition.experienceLearningV1,false);assert.equal(b.cognition.experienceLearningV1,true);assert.deepEqual(a.profile,b.profile);
  assert.throws(()=>resolveBrainConfig({root:process.cwd(),env:{JY_AFFECT:'0',JY_EXPERIENCE_LEARNING_V1:'yes'}}),e=>e.code==='RUNTIME_CONFIG');
  const seen=[],s=await startBrainService({port:0,global:true,heartbeatMs:0,storePath:':memory:',cognition:b.cognition,decide:p=>{seen.push(p);return JSON.stringify(proposal(p));}});
  try{await s.reply({scene:'synthetic',key:'feature',message_id:'q',messages:[{role:'user',content:'不必总结'}]});assert.equal(seen[0].payload.experienceLearning.enabled,true);}
  finally{await new Promise(r=>s.server.close(r));s.close();}
  const f=fixture(t),p=f.prep({experienceLearningV1:false});assert.equal(p.payload.experienceLearning,undefined);assert.ok(!p.instruction.includes('【可选经验学习 V1】'));
});

test('full simulated feedback trajectory: formation -> restart -> lookup -> chosen use -> actual receipt -> revision',async t=>{
  const f=fixture(t);f.commit(f.prep(),{summary:'一次参数失败后提出局部经验',lessons:[lesson({id:'r',revision:1})]});const original=f.readNote();f.reopen();
  let calls=0,feedback=false;const packets=[];
  const driver=new TurnDriver({store:f.store,subjectId:'s',workspace:{id:'w',revision:1},experienceLearningV1:true,allowedActionTools:['fixture.patch'],decide:p=>{
    calls++;packets.push(p);
    const full=p.payload.materials.some(m=>m.ref.id===original.id);
    if(!full)return JSON.stringify(proposal(p,{options:[{id:'next',kind:'lookup',payload:{ref:pin(original)}}],summary:'自行选择读回原经验'}));
    const used=[{ref:pin(original),aspect:p.payload.materials.find(m=>m.ref.id===original.id).aspects[0],effect:feedback?'oppose':'support'}];
    if(!feedback)return JSON.stringify(proposal(p,{options:[{id:'next',kind:'act',payload:{tool:'fixture.patch',args:{version:2}}}],used,summary:'参考旧经验；预期当前版本检查可以避免覆盖',
      continuity:{changes:[{id:'expected',expectedRevision:0,kind:'expectation',body:'预期版本检查避免覆盖；依据原经验@1',nature:'self-report',mind:{role:'expectation',confidence:'tentative',unresolved:['尚未执行'],action:{tool:'fixture.patch',args:{version:2}},when:{constant:true},likelihood:'possible',effects:[]},basis:{observations:[],priorStates:[],memories:[pin(original)]}}],
        residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{...keepAttention(),focus:{select:[{kind:'state',id:'expected',path:[]}]}}}}));
    assert.ok(p.payload.previousDecisions.some(d=>d.used.some(u=>u.ref.id===original.id)));
    assert.ok(JSON.stringify(p.payload.continuity).includes('预期版本检查避免覆盖'));
    return JSON.stringify(proposal(p,{used,summary:'工具明确失败：版本读取与提交间仍有竞争，缩小原经验范围；目标未完成',
      lessons:[lesson(p.payload.current,{ref:pin(original),lesson:'读版本后还必须在提交时原子校验版本',conditions:'配置可被并发更新且工具提供提交时版本检查',status:'contested',
        counterexamples:[{ref:pin(p.payload.current),nature:'receipt'}],unknowns:['尚未验证其他工具及真实并发环境']})]}));
  }});
  driver.ingest({key:'practice',body:'再尝试更新隔离配置',scene:'synthetic',actor:'fixture'});
  const first=await driver.tick({now:1800000010000,eventBypass:true}),out=first.outbox.find(x=>x.kind==='act');assert.ok(out);
  assert.equal(f.store.read(out.action.id).status,'proposed');assert.equal(f.readNote().revision,1);
  feedback=true;const receipt=driver.applyReceipt({action:out.action,status:'failed',body:'版本读取后被并发修改，提交被拒绝，配置未写入',eventId:'practice-result',occurredAt:1800000011000});
  await driver.tick({now:1800000012000,eventBypass:true});
  const current=f.readNote();assert.equal(current.revision,2);assert.deepEqual(f.store.read(original.id,1),original);
  assert.ok(current.evidence.some(r=>r.id==='r'));assert.ok(current.evidence.some(r=>r.id===receipt.receipt.id));
  assert.deepEqual(JSON.parse(current.body).previous,pin(original));assert.equal(f.store.read(out.action.id).status,'failed');assert.equal(calls,4);
  archive.write('TRAJECTORY.json',{evidenceKind:'deterministic-simulated-model-not-real-model-learning',packets,original,current,receipt,expectation:f.store.read('expected'),decisionRecords:[...f.store.all('decision')],paidCalls:0});
});

test('P3 objective statistics and subjective lessons coexist without converting counts into preferences',t=>{
  const f=fixture(t),spec={domain:'fixture',subject:'s',tool:'fixture.stat',actions:['A','B'],outcomes:['works','fails'],features:{material:['wood','stone']}};
  const stats=new ExperienceLearningSession({store:f.store,id:'learning:p3',spec});stats.initialize();
  f.store.execute({requestId:'stat-example',commands:[
    {op:'append_event',id:'stat-q',body:JSON.stringify({format:'learning-context-v1',domain:'fixture',subject:'s',features:{material:'wood'}}),origin:'observed',actor:'fixture',scene:'synthetic',source:{system:'fixture',key:'stat-q'}},
    {op:'propose_action',id:'stat-a',tool:'fixture.stat',workspace:{id:'w',revision:1},args:{choice:'A',context:{id:'stat-q',revision:1}},inputRefs:[{id:'stat-q',revision:1}]},
    {op:'record_receipt',actionId:'stat-a',expectedRevision:1,eventId:'stat-r',status:'succeeded',actor:'fixture',source:{system:'fixture',key:'stat-r'},
      body:JSON.stringify({format:'learning-result-v1',domain:'fixture',subject:'s',action:{id:'stat-a',revision:1},context:{id:'stat-q',revision:1},executed:true,outcome:'works'})} ]});
  stats.observe({action:{id:'stat-a',revision:2}});const before=stats.inspect();assert.equal(before.projection.known,1);
  f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});assert.deepEqual(stats.inspect(),before);
  assert.equal(f.prep().payload.experienceLearning.total,1);assert.ok(!f.prep().payload.experienceLearning.directory.some(d=>d.ref.id==='learning:p3'));
});

test('replaying the identical captured decision does not duplicate lessons or rewrite history',t=>{
  const f=fixture(t),packet=f.prep(),output=proposal(packet,{lessons:[lesson({id:'r',revision:1})]}),args={packet,output,decisionId:'same',requestId:'same'};
  const first=f.session.commit(args),note=f.readNote(),second=f.session.commit(args);
  assert.deepEqual(first,second);assert.deepEqual(f.readNote(),note);assert.equal(f.readNote().revision,1);
});

test('a late note write conflict rolls back decision and subject together, preserving captured proposal',t=>{
  const f=fixture(t),id='lesson:s:'+digest({decisionId:'collision',index:0});
  f.store.execute({requestId:'occupy',commands:[{op:'write_note',id,expectedRevision:0,body:'其他合法记录',kind:'fact_claim',change:'self_report',evidence:[]}]});
  const p=f.prep(),subject=f.store.read('s');
  assert.throws(()=>f.session.commit({packet:p,output:proposal(p,{lessons:[lesson({id:'r',revision:1})]}),decisionId:'collision',requestId:'collision'}),e=>e.code==='VERSION_CONFLICT');
  assert.equal(f.store.read('collision'),null);assert.deepEqual(f.store.read('s'),subject);assert.equal(f.store.read(id).body,'其他合法记录');
  assert.equal(f.store.read('collision:attempt').status,'captured');
});

test('disabled feature follows legacy normalization; malformed optional list does not trigger learning',t=>{
  const f=fixture(t);f.commit(f.prep({experienceLearningV1:false}),{lessons:[lesson({id:'r',revision:1})]});assert.equal(f.readNote(),undefined);
  const d=f.commit(f.prep(),{lessons:null});assert.equal(d.output.lessons,null);assert.equal(f.readNote(),undefined);
  assert.throws(()=>f.prep({experienceLearningV1:'false'}),e=>e.code==='INVALID_INPUT');
  for(const ref of [{id:'x',revision:'oops'},{id:{bad:true},revision:1},42]){
    f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1},{ref})]});
    assert.equal(f.prep().payload.experienceLearning.lastSubmission.items[0].status,'not-saved');assert.equal(f.readNote(),undefined);
  }
});

test('scope is preserved in an unrelated situation without an automatic applicability or truth verdict',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const note=f.readNote();
  f.store.execute({requestId:'other-domain',commands:[{op:'append_event',id:'sea',origin:'observed',actor:'fixture',scene:'synthetic',body:'现在是海上导航，没有配置文件工具',source:{system:'fixture',key:'sea'}}]});
  const p=f.prep({currentEvent:{id:'sea',revision:1},materials:[{ref:pin(note),aspect:'knowledge'}]});
  assert.equal(JSON.parse(p.payload.materials[0].record.body).scope,'仅隔离配置工具；其他环境未验证');
  assert.equal(p.payload.experienceLearning.directory[0].applicable,undefined);
  f.commit(p,{summary:'未见环境不能直接推广，暂不采用',used:[{ref:pin(note),aspect:'knowledge',effect:'uncertain'}]});
  assert.deepEqual(f.readNote(),note);assert.equal(p.payload.experienceLearning.verified,undefined);
});

test('duplicate revision proposals have distinct write receipts; a saved version does not validate the rejected duplicate',t=>{
  const f=fixture(t);f.commit(f.prep(),{lessons:[lesson({id:'r',revision:1})]});const original=f.readNote();
  f.commit(f.prep({materials:[{ref:pin(original),aspect:'knowledge'}]}),{lessons:[lesson({id:'r',revision:1},{ref:pin(original)}),lesson({id:'r',revision:1},{ref:pin(original)})]});
  assert.equal(f.readNote().revision,2);assert.deepEqual(f.prep().payload.experienceLearning.lastSubmission.items.map(i=>i.status),['saved','not-saved']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId,keepAttention,advanceAttention,emptyAttention} from '../src/attention.mjs';
import {initializeSubject,admitSubjectEvent,continuityInput} from '../src/continuity.mjs';
import {prepareDecision,commitDecision} from '../src/cognition.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {disk,put,event,frame,ref,note} from './helpers.mjs';

const refOf=x=>({id:x.id,revision:x.revision});

function setup(t,{path=':memory:'}={}){
  const store=new ContinuityStore(path);
  t.after(()=>store.close());
  const session=new ContinuitySession({store,subjectId:'algorithm-test',maxForeground:8,attention:true});
  const [e,w,nResult]=put(store,'algorithm-setup',event('alg-o1'),frame({id:'alg-ws'}),note('alg-n1'));
  const n=nResult.record;
  admitSubjectEvent({store,subjectId:'algorithm-test',event:ref(e),requestId:'algorithm-admit'});
  return {store,session,e,w,n};
}

function packet(s,extra={}){
  return prepareDecision({store:s.store,subjectId:'algorithm-test',currentEvent:ref(s.e),workspace:ref(s.w),
    identity:'测试',budgetBytes:48000,mind:true,workbenchMaterials:true,workbenchFocus:true,
    workbenchRecovery:true,localLookupPolicy:{maxReads:2,maxHits:4},...extra});
}

function output(p,{attention=keepAttention(),changes=[],residency={add:[],remove:[]},attentionPolicy=undefined,disposition='handled'}={}){
  const continuity={changes,residency,expressionChoice:null,observationDisposition:disposition,attention};
  if(attentionPolicy!==undefined)continuity.attentionPolicy=attentionPolicy;
  return {packetId:p.packetId,options:[{id:'a',kind:'respond',payload:{text:'好'}}],selected:'a',summary:'算法接入测试',used:[],continuity};
}

test('subject.attentionPolicy 由主体提案持久化，缺省保持 task',t=>{
  const s=setup(t);
  const p=packet(s);
  const d=commitDecision({store:s.store,packet:p,output:output(p,{attentionPolicy:'explore'}),requestId:'policy-1',decisionId:'policy-1'});
  assert.equal(d.type,'decision');
  assert.equal(s.store.read('algorithm-test').attentionPolicy,'explore');
  const e2=put(s.store,'policy-o2',event('alg-o2'))[0];
  admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e2),requestId:'policy-admit2'});
  const next=packet({...s,e:e2});
  assert.equal(next.payload.continuity.attentionPolicy,'explore');
});

test('attention_frame.deferrals 可持久化；host 只能标记 host 条件',t=>{
  const s=setup(t);
  const p1=packet(s,{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const residence={id:'alg-res:1',target:{kind:'material',ref:refOf(s.n)},cue:'材料入口',
    purposes:[{kind:'self-directed',eventIds:[],questionId:null,appliesTo:null}],presentation:'full'};
  const a1={...keepAttention(),residency:{upsert:[residence],remove:[]}};
  commitDecision({store:s.store,packet:p1,output:output(p1,{attention:a1}),requestId:'defer-res',decisionId:'defer-res'});
  assert.equal(s.store.read(attentionId('algorithm-test')).residences.length,1);

  const e2=put(s.store,'defer-o2',event('alg-o2'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e2),requestId:'defer-admit'});
  const p2=packet({...s,e:e2},{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const deferral={id:'alg-defer:1',ref:refOf(s.n),condition:{kind:'host',expr:'report:version>=2'}};
  const a2={...keepAttention(),residency:{upsert:[],remove:['alg-res:1']},deferrals:{upsert:[deferral],restore:[],cancel:[]}};
  commitDecision({store:s.store,packet:p2,output:output(p2,{attention:a2}),requestId:'defer-1',decisionId:'defer-1'});
  const frame1=s.store.read(attentionId('algorithm-test'));
  assert.equal(frame1.residences.length,0);
  assert.equal(frame1.deferrals.length,1);
  assert.equal(frame1.deferrals[0].status,'pending');

  const marked=s.store.execute({requestId:'mark-defer',commands:[{op:'mark_deferral_eligible',subjectId:'algorithm-test',deferId:'alg-defer:1'}]}).at(-1);
  assert.equal(marked.status,'eligible');
  assert.equal(s.store.read(attentionId('algorithm-test')).deferrals[0].status,'eligible');

  const e3=put(s.store,'defer-o3',event('alg-o3'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e3),requestId:'defer-admit3'});
  const p3=packet({...s,e:e3},{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const a3={...keepAttention(),residency:{upsert:[residence],remove:[]},deferrals:{upsert:[],restore:['alg-defer:1'],cancel:[]}};
  commitDecision({store:s.store,packet:p3,output:output(p3,{attention:a3}),requestId:'defer-restore',decisionId:'defer-restore'});
  const frame2=s.store.read(attentionId('algorithm-test'));
  assert.equal(frame2.residences.length,1);
  assert.equal(frame2.deferrals[0].status,'restored');
});

test('deferral 跨 reopen 保留；恢复不自动进工作台',t=>{
  const path=disk(t);
  const first=new ContinuityStore(path);
  const session=new ContinuitySession({store:first,subjectId:'algorithm-test',maxForeground:8,attention:true});
  const [e,w,nResult]=put(first,'reopen-setup',event('reopen-o1'),frame({id:'reopen-ws'}),note('reopen-n1'));
  const n=nResult.record;
  admitSubjectEvent({store:first,subjectId:'algorithm-test',event:ref(e),requestId:'reopen-admit'});
  const p=prepareDecision({store:first,subjectId:'algorithm-test',currentEvent:ref(e),workspace:ref(w),identity:'测试',budgetBytes:48000,
    materials:[{ref:refOf(n),aspect:'experience'}],mind:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
    localLookupPolicy:{maxReads:2,maxHits:4}});
  const residence={id:'r:reopen',target:{kind:'material',ref:refOf(n)},cue:'入口',
    purposes:[{kind:'self-directed',eventIds:[],questionId:null,appliesTo:null}],presentation:'full'};
  commitDecision({store:first,packet:p,output:output(p,{attention:{...keepAttention(),residency:{upsert:[residence],remove:[]}}}),requestId:'reopen-res',decisionId:'reopen-res'});
  const e2=put(first,'reopen-o2',event('reopen-o2'))[0];admitSubjectEvent({store:first,subjectId:'algorithm-test',event:ref(e2),requestId:'reopen-admit2'});
  const p2=prepareDecision({store:first,subjectId:'algorithm-test',currentEvent:ref(e2),workspace:ref(w),identity:'测试',budgetBytes:48000,
    materials:[{ref:refOf(n),aspect:'experience'}],mind:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
    localLookupPolicy:{maxReads:2,maxHits:4}});
  commitDecision({store:first,packet:p2,output:output(p2,{attention:{...keepAttention(),residency:{upsert:[],remove:['r:reopen']},
    deferrals:{upsert:[{id:'d:reopen',ref:refOf(n),condition:{kind:'host',expr:'x'}}],restore:[],cancel:[]}}}),requestId:'reopen-defer',decisionId:'reopen-defer'});
  const frameState=first.read(attentionId('algorithm-test'));
  assert.equal(frameState.deferrals.length,1);
  first.close();

  const second=new ContinuityStore(path);
  const reopened=second.read(attentionId('algorithm-test'));
  assert.equal(reopened.deferrals.length,1);
  assert.equal(reopened.deferrals[0].id,'d:reopen');
  assert.equal(reopened.residences.length,0);
  second.close();
});

test('算法提示是显式可选能力，旧包不自动获得',t=>{
  const s=setup(t);
  const normal=packet(s);
  assert.equal(normal.payload.algorithmV011,undefined);
  assert.doesNotMatch(normal.instruction,/attentionPolicy/);
  const enabled=packet(s,{algorithmV011:true});
  assert.equal(enabled.payload.algorithmV011.enabled,true);
  assert.match(enabled.instruction,/attentionPolicy/);
  assert.match(enabled.instruction,/task.*优先当前任务/);
  assert.match(enabled.instruction,/explore.*新颖/);
  assert.match(enabled.instruction,/cautious.*核对来源/);
});

function apperception(domain,perspective,content,status,uncertainty=null){
  return {
    schema_version:'apperception.slice.v1',
    activated_cells:[{domain,perspective,content,epistemic_status:status,source_refs:[],uncertainty}],
    integrated_understanding:content
  };
}

function decisionWith(packet, apperceptionValue, options={}){
  const out=output(packet,options);
  if(apperceptionValue!==undefined)out.apperception=apperceptionValue;
  return out;
}

test('五类事件：apperception 结构化保存，不写长期记忆/状态变更',t=>{
  const s=setup(t);
  const cases=[
    ['普通事实','world','relevance','今晚群里说九点开黑','fact'],
    ['模糊关系','relationship','meaning','朋友可能在分享偏好，也可能只是随口说','inference'],
    ['历史冲突','world','meaning','旧认识和新消息不一致，暂不下结论','uncertain'],
    ['情绪自我','self','norm_self','我有点被触动，但不想立刻表现','interpretation'],
    ['新旧材料','relationship','coping','先保留新材料，再查旧记录是否仍适用','interpretation']
  ];
  const stateCount=()=>[...s.store.all('personal_state')].length;
  const noteCount=()=>[...s.store.all('note')].length;
  const actionCount=()=>[...s.store.all('action')].length;
  const before=[stateCount(),noteCount(),actionCount()];
  for(let i=0;i<cases.length;i++){
    const [label,domain,perspective,content,status]=cases[i];
    const e=put(s.store,`app-o${i}`,event(`app-o${i}`))[0];
    admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e),requestId:`app-admit${i}`});
    const extra=i===4?{materials:[{ref:refOf(s.n),aspect:'experience'}]}:{};
    const p=packet({...s,e},{apperceptionV1:true,...extra});
    const app=apperception(domain,perspective,content,status);
    if(i===4)app.activated_cells[0].source_refs=[refOf(s.n),ref(e)];
    const d=commitDecision({store:s.store,packet:p,output:decisionWith(p,app),
      requestId:`app-commit${i}`,decisionId:`app-commit${i}`});
    assert.equal(d.output.apperception.schema_version,'apperception.slice.v1',label);
    assert.equal(d.output.apperception.activated_cells.length,1,label);
    assert.equal(d.output.apperception.activated_cells[0].domain,domain,label);
    assert.equal(d.output.apperception.activated_cells[0].perspective,perspective,label);
  }
  assert.deepEqual([stateCount(),noteCount(),actionCount()],before,'projection must not write state/memory/action');
});

test('apperception 格式失败安全降级，不阻断主体决策',t=>{
  const s=setup(t);
  const e=put(s.store,'app-bad-o',event('app-bad-o'))[0];
  admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e),requestId:'app-bad-admit'});
  const p=packet({...s,e},{apperceptionV1:true});
  const bad={schema_version:'apperception.slice.v1',activated_cells:[{domain:'not-a-domain',perspective:'meaning',content:'x',epistemic_status:'fact',source_refs:[],uncertainty:null}],integrated_understanding:'x'};
  const d=commitDecision({store:s.store,packet:p,output:decisionWith(p,bad),requestId:'app-bad',decisionId:'app-bad'});
  assert.equal(d.output.apperception,undefined);
  assert.equal(d.type,'decision');
});

test('apperception 不允许引用未交付来源',t=>{
  const s=setup(t);
  const e=put(s.store,'app-ref-o',event('app-ref-o'))[0];
  admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e),requestId:'app-ref-admit'});
  const p=packet({...s,e},{apperceptionV1:true});
  const bad=apperception('world','relevance','x','fact');
  bad.activated_cells[0].source_refs=[{id:'not-delivered',revision:1}];
  const d=commitDecision({store:s.store,packet:p,output:decisionWith(p,bad),requestId:'app-ref',decisionId:'app-ref'});
  assert.equal(d.output.apperception,undefined);
});

test('五组 A/B：旧决策与统觉投影决策都不写状态，投影只多审计字段',t=>{
  const cases=[
    ['fact','world','relevance','今晚九点开黑','fact'],
    ['ambiguous','relationship','meaning','朋友可能在分享偏好','inference'],
    ['conflict','world','meaning','旧认识与新消息不一致','uncertain'],
    ['emotion','self','norm_self','我有点被触动','interpretation'],
    ['old-new','relationship','coping','新旧材料一起判断','interpretation']
  ];
  const deltas=[];
  for(const [label,domain,perspective,content,status] of cases){
    const run=(mode)=>{
      const store=new ContinuityStore(':memory:');
      new ContinuitySession({store,subjectId:'ab-subject',maxForeground:8,attention:true});
      const [e,w]=put(store,`ab-${label}-${mode}`,event(`ab-${label}-${mode}`),frame({id:`ab-ws-${mode}`}));
      admitSubjectEvent({store,subjectId:'ab-subject',event:ref(e),requestId:`ab-admit-${label}-${mode}`});
      const p=prepareDecision({store,subjectId:'ab-subject',currentEvent:ref(e),workspace:ref(w),identity:'测试',budgetBytes:48000,
        mind:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,localLookupPolicy:{maxReads:2,maxHits:4},
        apperceptionV1:mode==='projection'});
      const out=output(p);
      if(mode==='projection')out.apperception=apperception(domain,perspective,content,status);
      const d=commitDecision({store,packet:p,output:out,requestId:`ab-commit-${label}-${mode}`,decisionId:`ab-commit-${label}-${mode}`});
      const result={decision:d,bytes:p.bytes,state:[...store.all('personal_state')].length,notes:[...store.all('note')].length,actions:[...store.all('action')].length};
      store.close();return result;
    };
    const A=run('baseline'),B=run('projection');
    assert.equal(A.decision.output.apperception,undefined,label);
    assert.equal(B.decision.output.apperception.schema_version,'apperception.slice.v1',label);
    assert.deepEqual([A.state,A.notes,A.actions],[B.state,B.notes,B.actions],label);
    deltas.push(B.bytes-A.bytes);
  }
  assert.ok(deltas.every(d=>d>0&&d<6000),JSON.stringify(deltas));
});

test('subject 条件只能由主体 confirm，host 不能代确认',t=>{
  const s=setup(t);
  const p1=packet(s,{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const residence={id:'alg-res:subject',target:{kind:'material',ref:refOf(s.n)},cue:'材料入口',
    purposes:[{kind:'self-directed',eventIds:[],questionId:null,appliesTo:null}],presentation:'full'};
  commitDecision({store:s.store,packet:p1,output:output(p1,{attention:{...keepAttention(),residency:{upsert:[residence],remove:[]}}}),requestId:'subj-res',decisionId:'subj-res'});
  const e2=put(s.store,'subj-o2',event('subj-o2'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e2),requestId:'subj-admit'});
  const p2=packet({...s,e:e2},{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const a2={...keepAttention(),residency:{upsert:[],remove:['alg-res:subject']},deferrals:{upsert:[{id:'alg-defer:subject',ref:refOf(s.n),condition:{kind:'subject',expr:'等我想想'}}],restore:[],cancel:[]}};
  commitDecision({store:s.store,packet:p2,output:output(p2,{attention:a2}),requestId:'subj-defer',decisionId:'subj-defer'});
  assert.throws(()=>s.store.execute({requestId:'subj-host',commands:[{op:'mark_deferral_eligible',subjectId:'algorithm-test',deferId:'alg-defer:subject'}]}),e=>e.code==='SUBJECT_CONDITION_NOT_HOST_VERIFIABLE');

  const e3=put(s.store,'subj-o3',event('subj-o3'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e3),requestId:'subj-admit3'});
  const p3=packet({...s,e:e3},{materials:[{ref:refOf(s.n),aspect:'experience'}]});
  const a3={...keepAttention(),deferrals:{upsert:[],restore:[],cancel:[],confirm:['alg-defer:subject']}};
  commitDecision({store:s.store,packet:p3,output:output(p3,{attention:a3}),requestId:'subj-confirm',decisionId:'subj-confirm'});
  assert.equal(s.store.read(attentionId('algorithm-test')).deferrals.find(d=>d.id==='alg-defer:subject').status,'eligible');
});

test('活跃 deferral 容量：restored 历史不占 32 上限',t=>{
  const frame=emptyAttention('capacity-subject');
  const material={id:'cap-material',revision:1,type:'note',body:'x'};
  frame.deferrals=Array.from({length:32},(_,i)=>({id:`old:${i}`,ref:{id:`cap-${i}`,revision:1},condition:{kind:'host',expr:'x'},conditionType:'host',status:'restored',events:[]}));
  const ref={id:'cap-material',revision:1};
  const delta={...keepAttention(),deferrals:{upsert:[{id:'new:1',ref,condition:{kind:'host',expr:'x'}}],restore:[],cancel:[]}};
  const next=advanceAttention(frame,delta,{read:(id)=>id==='cap-material'?material:null,at:1,maxForeground:8,memoryRefs:[ref],processRefs:[],relationRefs:[],questionRefs:[],residenceIds:[],stateRefs:[],changedStateIds:[],observations:[]});
  assert.equal(next.deferrals.filter(d=>!['restored','cancelled'].includes(d.status)).length,1);
});

test('端到端 brain-service：主体的 attentionPolicy 经 HTTP 入队/决策/持久化',async t=>{
  const path=disk(t);
  const outputPacket=packet=>({
    packetId:packet.packetId,
    options:[{id:'a',kind:'respond',payload:{text:'收到'}}],selected:'a',summary:'e2e',used:[],
    continuity:{
      changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',
      attention:{...keepAttention()},attentionPolicy:'explore'
    }
  });
  const service=await startBrainService({storePath:path,decide:packet=>JSON.stringify(outputPacket(packet)),rhythm:{minGapMs:1}});
  await service.observe({source:'qq',key:'private:1',text:'你好'});
  const result=await service.turn({preferred:'qq/private/1',deliver:false});
  assert.equal(result.ok,true);
  assert.equal(service.store.read('jingyang').attentionPolicy,'explore');
  await new Promise(r=>service.server.close(r));
  service.close();
});

test('V1.2.1 source_refs 白名单：current/material/recent/[] 可用，缺失或未交付安全降级',t=>{
  const s=setup(t);
  const old=put(s.store,'app-src-old',event('app-src-old',{occurredAt:900}))[0];
  const e=put(s.store,'app-src-current',event('app-src-current'))[0];
  admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e),requestId:'app-src-admit'});
  const p=packet({...s,e},{materials:[{ref:refOf(s.n),aspect:'experience'}],apperceptionV1:true});
  const recent=p.payload.continuity.recent.items.find(x=>x.ref.id===old.id);
  assert.ok(recent,'recent item must be delivered');
  const cell=(domain,perspective,source_refs,status='fact')=>({domain,perspective,content:'c',epistemic_status:status,source_refs,uncertainty:null});
  const app={
    schema_version:'apperception.slice.v1',
    activated_cells:[
      cell('world','relevance',[refOf(p.payload.current)]),
      cell('relationship','meaning',[refOf(s.n)]),
      cell('world','coping',[recent.ref],'inference'),
      cell('self','norm_self',[])
    ],
    integrated_understanding:'四种来源'
  };
  const before=[...s.store.all('personal_state')].length;
  const d=commitDecision({store:s.store,packet:p,output:decisionWith(p,app),requestId:'src-ok',decisionId:'src-ok'});
  assert.equal(d.output.apperception.activated_cells.length,4);
  assert.deepEqual(d.output.apperception.activated_cells[3].source_refs,[]);

  const e2=put(s.store,'src-missing',event('src-missing'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e2),requestId:'src-missing-admit'});
  const p2=packet({...s,e:e2},{apperceptionV1:true});
  const missing={...app,activated_cells:[{domain:'world',perspective:'relevance',content:'x',epistemic_status:'fact',uncertainty:null}]};
  const d2=commitDecision({store:s.store,packet:p2,output:decisionWith(p2,missing),requestId:'commit-src-missing',decisionId:'commit-src-missing'});
  assert.equal(d2.output.apperception,undefined);

  const e3=put(s.store,'src-bad',event('src-bad'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e3),requestId:'src-bad-admit'});
  const p3=packet({...s,e:e3},{apperceptionV1:true});
  const bad={...app,activated_cells:[cell('world','relevance',[{id:'not-delivered',revision:1}])]};
  const d3=commitDecision({store:s.store,packet:p3,output:decisionWith(p3,bad),requestId:'commit-src-bad',decisionId:'commit-src-bad'});
  assert.equal(d3.output.apperception,undefined);
  assert.equal([...s.store.all('personal_state')].length,before);

  const e4=put(s.store,'src-legacy2',event('src-legacy2'))[0];admitSubjectEvent({store:s.store,subjectId:'algorithm-test',event:ref(e4),requestId:'src-legacy-admit'});
  const p4=packet({...s,e:e4});
  const d4=commitDecision({store:s.store,packet:p4,output:output(p4),requestId:'commit-src-legacy',decisionId:'commit-src-legacy'});
  assert.equal(d4.output.apperception,undefined);
});

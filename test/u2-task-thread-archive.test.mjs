import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {keepAttention,attentionId} from '../src/attention.mjs';
import {threadUnits,taskThreads,taskProcessSource,taskProcessEvidenceSource} from '../src/task-threads.mjs';
import {canonical} from '../src/contracts.mjs';

// U2 / C: Task lifecycle integration — no host Action for task steps, terminal Process
// tombstones stay read-only/resolvable, and a Task delivers exactly one current result.
const ref=record=>({id:record.id,revision:record.revision});
const proc=id=>({id,expectedRevision:0,label:id,body:id,status:'active',world:'actual',intervals:[],basis:[]});
const out=(packet,kind='wait',payload={},processes=[])=>({packetId:packet.packetId,options:[{id:'x',kind,payload}],selected:'x',summary:'synthetic',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},...(packet.stage==='reflection'?{}:{expressionChoice:null,observationDisposition:'handled'}),attention:{...keepAttention(),processes}}});
const prepare=(s,extra={})=>s.session.prepare({currentEvent:ref(s.event),workspace:ref(s.w),mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,taskThreads:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072,...extra});

function setup(t,{taskActions=[]}={}){
  const actions=[...taskActions];
  const service=createBrainService({storePath:':memory:',subjectTask:true,global:true,heartbeatMs:0,agentMaxSteps:24,agentTools:{probe:async()=>({value:1})},
    decide:packet=>{
      if(packet.payload?.task){const action=actions.shift()??{tool:'task_finish',args:{result:'done'}};return JSON.stringify(out(packet,'act',action));}
      return JSON.stringify(out(packet));
    }});
  t.after(()=>service.close());
  const s={service,store:service.store,session:new ContinuitySession({store:service.store,subjectId:'jingyang',attention:true,maxForeground:16})};
  const [event,workspace]=s.store.execute({requestId:'seed',commands:[
    {op:'append_event',id:'e1',body:'outside message',origin:'reported',actor:'fixture',scene:'synthetic',source:{system:'fixture',key:'e1'},occurredAt:1000},
    {op:'set_workspace',id:'w1',expectedRevision:0,scene:'synthetic',focus:{id:'current',label:'synthetic'}}]});
  s.event=event;s.w=workspace;
  const packet=prepare(s),seed=out(packet,'wait',{},[proc('A')]);
  seed.continuity.attention.focus={select:[{kind:'process',id:'A',path:[]}]};
  s.session.commit({packet,output:seed,decisionId:'seed-d',requestId:'seed-d'});
  return s;
}
async function start(s,{goal='synthetic',allowedTools=['probe'],processId='A'}={}){
  const packet=prepare(s,{allowedActionTools:['start_agent_task']});
  const decision=s.session.commit({packet,output:out(packet,'act',{tool:'start_agent_task',args:{goal,processId,allowedTools}}),decisionId:'start-task',requestId:'start-task',allowedActionTools:['start_agent_task']});
  await s.service.executeAction(decision.action);
  return s.service.listAgent().find(task=>task.id==='task:'+decision.action.id);
}
const taskUnit=(s,processId)=>{const units=threadUnits({store:s.store,subjectId:'jingyang',threadId:processId}).units;return units.find(unit=>unit.kind==='task-execution-evidence');};

test('task steps leave no host Action; observation handled; exactly one current result',async t=>{
  const s=setup(t,{taskActions:[{tool:'probe',args:{}},{tool:'task_blocked',args:{reason:'first obstacle'}},{tool:'task_finish',args:{result:'done'}}]});
  const task=await start(s);
  await s.service.stepAgentTask(task.id);
  const afterTool=s.store.read(task.id);
  assert.equal(afterTool.status,'running');
  assert.equal(afterTool.stepCount,1);
  assert.equal([...s.store.all('action')].filter(action=>String(action.id).startsWith('task-decision:')).length,0,'task steps must not create host Action');
  assert.equal(s.service.pendingEffects().actions.length,0,'the start action is already receipted; task steps add nothing to pending effects');
  const observation=[...s.store.all('event')].find(event=>String(event.id).startsWith('agent-observation:'));
  assert.ok(observation);
  assert.equal(s.store.subjectObservation('jingyang',observation.id).status,'handled','tool observations are admitted already handled');
  assert.equal(s.store.subjectInbox({subjectId:'jingyang',pendingOnly:true}).items.some(row=>row.eventId===observation.id),false);
  await s.service.stepAgentTask(task.id);
  assert.equal(s.store.read(task.id).status,'blocked');
  await s.service.resumeAgentTask(task.id,{message:'new information'});
  await s.service.stepAgentTask(task.id);
  const saved=s.store.read(task.id);
  assert.equal(saved.status,'done');
  assert.equal([...s.store.all('action')].length,1,'only the receipted start_agent_task action exists');
  const taskDecisions=[...s.store.all('decision')].filter(decision=>decision.input?.payload?.task);
  assert.ok(taskDecisions.length>=3);
  for(const decision of taskDecisions)assert.equal(decision.action,null,'task-step decisions carry no host Action');
  const unit=taskUnit(s,'A');
  assert.ok(unit);
  const results=unit.evidence.filter(evidence=>evidence.role==='result');
  assert.equal(results.length,2,'blocked and done fixed receipts stay in history');
  assert.equal(results.filter(evidence=>evidence.historical!==true).length,1,'one current result only');
  assert.equal(unit.latestResult.ref.id,saved.feedback.event.id);
  assert.equal(unit.resultCount,2);
});

test('completed Process tombstone stays read-only and task evidence stays resolvable',async t=>{
  const s=setup(t,{taskActions:[{tool:'probe',args:{}},{tool:'task_finish',args:{result:'done'}}]});
  const task=await start(s);
  await s.service.stepAgentTask(task.id);
  await s.service.stepAgentTask(task.id);
  const before=taskUnit(s,'A');
  assert.ok(before);
  const packet=prepare(s),completed={...proc('A'),expectedRevision:1,status:'completed'};
  s.session.commit({packet,output:out(packet,'wait',{},[completed]),decisionId:'complete-A',requestId:'complete-A'});
  const frame=s.store.read(attentionId('jingyang'));
  const frameSnapshot=canonical(frame);
  const view=taskThreads({store:s.store,frame,currentEvent:null});
  const tombstone=view.archived.find(process=>process.id==='A');
  assert.ok(tombstone,'completed Process is exposed as read-only archive, not dropped');
  assert.equal(tombstone.archived,true);
  assert.equal(tombstone.readOnly,true);
  assert.equal(tombstone.stableIdentity,true);
  assert.equal(view.activeIds.includes('A'),false);
  assert.equal(view.archivedCount,1);
  assert.deepEqual(canonical(taskUnit(s,'A')),canonical(before),'tombstone does not change the Task evidence');
  assert.equal(canonical(s.store.read(attentionId('jingyang'))),frameSnapshot,'task thread projection performs no status mutation');
  assert.equal(taskProcessSource({store:s.store,subjectId:'jingyang',processId:'A',originDecisionRef:task.originDecisionRef})?.process.id,'A','strict creation contract still resolves the stable tombstone id');
});

test('a Task whose Process left the frame is surfaced orphaned instead of silently dropped',async t=>{
  const s=setup(t,{taskActions:[{tool:'task_finish',args:{result:'done'}}]});
  const task=await start(s);
  await s.service.stepAgentTask(task.id);
  const frame=s.store.read(attentionId('jingyang'));
  const synthetic={...frame,processes:frame.processes.filter(process=>process.id!=='A')};
  const view=taskThreads({store:s.store,frame:synthetic,currentEvent:null});
  const orphan=view.orphaned.find(taskView=>taskView.id===task.id);
  assert.ok(orphan,'bound Task is surfaced instead of disappearing with its Process');
  assert.equal(orphan.orphaned,true);
  assert.equal(orphan.readOnly,true);
  assert.equal(view.orphanedCount,1);
  const realRead=s.store.read.bind(s.store);
  s.store.read=(id,revision)=>{const value=realRead(id,revision);return id===frame.id&&revision===undefined&&value?.type==='attention_frame'?{...value,processes:value.processes.filter(process=>process.id!=='A')}:value;};
  try{
    assert.equal(taskProcessSource({store:s.store,subjectId:'jingyang',processId:'A',originDecisionRef:task.originDecisionRef}),null,'creation contract fails closed when the stable id is gone');
    const evidence=taskProcessEvidenceSource({store:s.store,subjectId:'jingyang',processId:'A',originDecisionRef:task.originDecisionRef});
    assert.ok(evidence);
    assert.equal(evidence.stableIdentity,false);
    assert.equal(evidence.processArchived,true);
    const unit=taskUnit(s,'A');
    assert.ok(unit,'history still resolves the archived Task evidence');
    assert.equal(unit.processArchived,true);
    assert.equal(unit.readOnly,true);
  }finally{s.store.read=realRead;}
});


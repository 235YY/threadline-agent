// 本机脑服务：串行队列 + 一个主体；默认 dry-run，不调模型、不联网。
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure,text,digest} from '../../src/contracts.mjs';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {subjectiveMemoryView,continuityInput} from '../../src/continuity.mjs';
import {TurnDriver} from '../../src/turn-driver.mjs';
import {SceneScheduler} from '../../src/scheduler.mjs';
import {keepAttention,attentionId} from '../../src/attention.mjs';
import {AgentRuntime} from '../../src/agent-runtime.mjs';
import {normalizeInbound} from './adapters.mjs';
import {normalizeMessage,projectText} from '../../src/message.mjs';
import {putBlob} from '../../src/blobs.mjs';
import {bindingCommands} from '../../src/binding-action.mjs';
import {CAPABILITIES} from '../../src/capabilities.mjs';
import {TOOL_NAMES} from '../qq-connect/tools.mjs';
import {AttentionPolicy} from '../../src/attention-policy.mjs';
import {rememberNote} from '../../src/remember.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {queryAnchor} from '../../src/anchor.mjs';
import {ensurePerson} from '../../src/identity.mjs';
import {claimResponse,recordResponseDelivery} from '../../src/continuity.mjs';
import {StyleStore} from '../../src/style-store.mjs';
import {validateBudgetRows} from '../../src/budget-integrity.mjs';
import {sourceReplyRoute,concreteReplyScene} from '../../src/reply-route.mjs';
import {recentContext} from '../../src/recent-context.mjs';
import {selectedModelOutput} from '../../src/model-output-recovery.mjs';
import {validateToolArguments} from '../../src/tool-contracts.mjs';

const MAX_BODY=1024*1024;
export const READ_ONLY_HOST_TOOLS=Object.freeze(['qq_list_friends','qq_list_groups','qq_list_stickers','qq_get_group_history','qq_get_friend_history','qq_get_group_members','qq_get_forward_msg','anchor_recall','attention_status','web_search','web_fetch','style_status','office_status','office_list','office_read','office_search','office_audit','github_status','github_repo','github_issues','github_issue','github_pulls','github_branches']);
const ATTENTION=()=>({...keepAttention()});

// Restore only dependencies of a process she has already explicitly focused.
// Exact pinned sources are delivered through the existing material channel;
// neither a directory entry nor a same-named state gains read authority.
export function focusedProcessMaterials({store,subjectId,event}){
 const frame=store.read(attentionId(subjectId));
 ensure(!frame||frame.subject===subjectId,'PROCESS_MATERIAL_OWNER','own attention frame required');
 const selected=new Set((frame?.focus?.selection??[]).filter(x=>x.kind==='process').map(x=>x.id)),refs=new Map();
 for(const process of frame?.processes??[])if(selected.has(process.id))for(const r of process.basis??[]){
  if(r.id===event.id&&r.revision===event.revision)continue;
  refs.set(r.id+'@'+r.revision,r);
 }
 // The timeline already presents these messages. Deliver their actual pinned
 // records through the same material channel so they can genuinely support a
 // later understanding. A response or another conversation gains no authority.
 const current=store.read(event.id,event.revision);
 if(current?.type==='event'&&['observed','reported'].includes(current.origin)&&current.scene){
  const recent=recentContext({store,subjectId,currentEvent:current,scene:current.scene,limit:50});
  let added=0;
  // Leave room in the existing 32-material contract for subsequent lookup hits.
  for(const item of recent.items.toReversed()){
   if(added>=16||refs.size>=24)break;
   const key=item.ref.id+'@'+item.ref.revision;
   if(item.role==='user'&&!(item.ref.id===event.id&&item.ref.revision===event.revision)&&!refs.has(key)){refs.set(key,item.ref);added++;}
  }
 }
 ensure(refs.size<=32,'PROCESS_MATERIAL_LIMIT','focused process dependencies exceed existing material limit; narrow focus or explicitly retrieve');
 return [...refs.values()].map(r=>{const record=store.read(r.id,r.revision);
  ensure(record&&['event','note'].includes(record.type),'PROCESS_MATERIAL_MISSING','pinned process source unavailable; never substitute its latest version');
  return {ref:{id:r.id,revision:r.revision},aspect:record.type==='event'?'experience':'knowledge'};
 });
}

function dryDecide(packet){
  const reflection=packet.stage==='reflection';
  const continuity=reflection?{changes:[],residency:{add:[],remove:[]},attention:ATTENTION()}
    :{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:ATTENTION()};
  return JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'dry-run',used:[],continuity});
}
function ensureWorkspace(store,scene){
  const id=`ws:${scene}`,old=store.read(id);
  const persona=store.read('legacy:persona:jingyang');
  const refs=persona?[{id:persona.id,revision:persona.revision}]:[];
  if(old){
    if(persona&&old.workingRefs?.[0]?.id!==persona.id){
      return store.execute({requestId:`workspace:persona:${id}:${old.revision}`,commands:[{op:'set_workspace',id,expectedRevision:old.revision,scene,
        focus:old.focus,workingRefs:[...refs,...old.workingRefs.filter(r=>r.id!==persona.id)],continuityRefs:old.continuityRefs,actionRefs:old.actionRefs}]}).at(-1);
    }
    return old;
  }
  return store.execute({requestId:`workspace:${id}`,commands:[{op:'set_workspace',id,expectedRevision:0,scene,focus:{id:'current',label:'当前'},
    workingRefs:refs,continuityRefs:[],actionRefs:[]}]}).at(-1);
}
function keyFor(scene,key){
  if(key)return key;
  if(scene.startsWith('qq/private/'))return `private:${scene.slice('qq/private/'.length)}`;
  if(scene.startsWith('qq/group/'))return `group:${scene.slice('qq/group/'.length)}`;
  if(scene.startsWith('mc/'))return scene.slice('mc/'.length);
  throw Object.assign(new Error('cannot derive source key from scene'),{code:'ADAPTER'});
}
function firstText(messages){
  const list=Array.isArray(messages)?messages:[];
  const last=[...list].reverse().find(m=>m&&typeof m.content==='string');
  return last?.content??'';
}

export function createBrainService({storePath=':memory:',subjectId='jingyang',identity='你是鲸漾。',decide=dryDecide,rhythm={},clock=Date.now,capabilities=CAPABILITIES.map(c=>c.id),allowedActionTools=READ_ONLY_HOST_TOOLS,adapter=null,stateDirectory=null,styleDirectory=null,heartbeatMs=0,global=false,eventBypass=true,agentTools={},agentMaxSteps=24,subjectTask=false,blobDirectory=null,hostAllowedTools=null,rhythmReset=false,sessionFactory=null,theoryStatus=null,idleIntervalMs=2*60*60*1000,cognition={},runtimeInfo=null,shutdownControl=null}={}){
  ensure(typeof storePath==='string'&&storePath.length>0,'BRAIN_SERVICE','store path required');
  const cognitiveKeys=['algorithmV011','apperceptionV1','subjectiveDomains','subjectiveMemory','subjectiveMemoryV2','taskThreads','anchorDirectory','memoryScopeV1','investigationContinuityV1','experienceLearningV1'];
  ensure(cognition&&Object.getPrototypeOf(cognition)===Object.prototype&&Object.entries(cognition).every(([key,value])=>cognitiveKeys.includes(key)&&typeof value==='boolean'),'COGNITION_CONFIG','explicit known boolean cognition flags required');
  cognition=Object.freeze({...cognition});
  const blobs=blobDirectory??join(stateDirectory??'.','blobs');
  const store=new ContinuityStore(storePath);
  new ContinuitySession({store,subjectId,attention:true,maxForeground:16});
  const scheduler=new SceneScheduler({clock});
  const drivers=new Map();
  let globalDriver=null;
  const stateFile=stateDirectory?join(stateDirectory,'scheduler.json'):null;
  if(stateDirectory)mkdirSync(stateDirectory,{recursive:true});
  const policy=new AttentionPolicy({file:stateDirectory?join(stateDirectory,'attention.json'):null});
  const styles=new StyleStore({directory:styleDirectory});
  const sourceRoute=input=>sourceReplyRoute({read:(id,revision)=>store.read(id,revision),all:type=>store.all(type),subjectId,...input});
  const taskReplyScene=task=>sourceRoute({task}).scene??'agent/task';
  function decisionReplyScene(reference,fallback=null){
    const decision=reference?store.read(reference.id,reference.revision):null;
    if(!decision)return fallback;
    const selected=decision.output.options.find(o=>o.id===decision.output.selected);
    if(selected?.kind==='respond'&&selected.payload.target!==undefined)return selected.payload.target;
    return sourceRoute({event:decision.currentEvent}).scene??fallback;
  }
  function subjectContext(){
    let subjectiveMemory=null;try{subjectiveMemory=subjectiveMemoryView({store,subjectId,maxRecent:20,maxCompressed:30,maxRecentBytes:16000,maxCompressedBytes:16000,maxSourceBodies:4});}catch{}
    let attention=null;try{attention=store.read(attentionId(subjectId));}catch{}
    return {identity,style:styles.text(),subjectiveMemory,attention};
  }
  function recordAgentObservation(task,observation){
    const key=`agent-observation:${task.id}:${task.stepCount}:${observation.tool??observation.kind}${observation.late?':late:'+observation.operationId:''}`;
    try{const content=observation?.result?.content;let messageValue=null,body=JSON.stringify(observation).slice(0,6000);
      if(Array.isArray(content)){try{messageValue=normalizeMessage({format:'jingyang-message-v1',role:'tool',content});body=projectText(messageValue);}catch(error){throw Object.assign(new Error('tool observation message invalid: '+error.message),{code:'OBSERVATION_MESSAGE_INVALID',cause:error});}}
      const event={id:key,revision:1};
      store.execute({requestId:`agent-observation:${key}`,commands:[
        {op:'append_event',id:key,body,...(messageValue?{message:messageValue}:{}),scene:taskReplyScene(task),actor:'agent',origin:'tool_receipt',source:{system:'agent-runtime',key},occurredAt:observation.at??clock(),...(task.threadId?{threadId:task.threadId}:{})},
        {op:'admit_subject_event',subjectId,event}
      ]});
      const current=loadAgent(task.id),changed=(current.controlRevision??0)!==(task.controlRevision??0)||current.lease?.token!==task.lease?.token;
      const destination=changed?agentRuntime.restore(current):task;
      if(!changed){destination.revision=current.revision;destination.interrupts=current.interrupts;}
      destination.observationRefs=Array.isArray(destination.observationRefs)?destination.observationRefs:[];
      if(!destination.observationRefs.some(r=>r.id===key)){
        destination.observationRefs.push(event);
        if(changed){
          destination.observations.push(observation);destination.stepCount=Math.max(destination.stepCount,task.stepCount);
          destination.toolOps={...destination.toolOps};
          for(const [operation,value] of Object.entries(task.toolOps??{}))if(['started','uncertain'].includes(destination.toolOps[operation]?.status)&&!['started','uncertain'].includes(value.status))destination.toolOps[operation]=value;
        }
      }
      saveAgent(destination);
      if(changed)task.observationRefs=[...(task.observationRefs??[]),event];
    }catch(error){if(error.code)throw error;throw Object.assign(new Error('observation persistence failed: '+error.message),{code:'OBSERVATION_PERSIST_FAILED',cause:error});}
  }
  function failAgentDecision(task,error){if(!task)return task;
    const current=loadAgent(task.id);
    if((current.controlRevision??0)!==(task.controlRevision??0)||['done','failed','cancelled','paused'].includes(current.status)||task.lease&&current.lease?.token!==task.lease.token){Object.assign(task,agentRuntime.restore(current));return task;}
    if(['done','failed','cancelled'].includes(task.status))return task;task.revision=current.revision;task.interrupts=current.interrupts;task.status='blocked';task.blockedReason=String(`MODEL_OUTPUT_INVALID:${error?.code??'TASK_STEP_ERROR'}`).slice(0,2000);task.updatedAt=clock();saveAgent(task);recordAgentResult(task);return task;}
  const resultStatuses=new Set(['done','blocked','failed','cancelled']);
  const resultKey=task=>`agent-result:${task.id}:${task.status}:${digest({control:task.controlRevision??0,steps:task.stepCount,decision:task.decisionRefs?.at(-1)??null,result:task.result??null,reason:task.blockedReason??null}).slice(0,24)}`;
  function recordAgentResult(task){
    const current=loadAgent(task.id);if(!resultStatuses.has(current.status))return false;
    const key=resultKey(current);if(current.feedback?.status==='recorded'&&current.feedback.key===key)return true;
    const event={id:key,revision:1},next=agentRuntime.restore(current);
    next.feedback={key,status:'recorded',event};
    const body=JSON.stringify({taskId:current.id,intentRef:current.intentRef??null,goal:current.goal,status:current.status,result:current.result,blockedReason:current.blockedReason}).slice(0,6000);
    try{
      store.execute({requestId:'agent-result-publish:'+key,commands:[
        {op:'append_event',id:key,body,scene:taskReplyScene(current),actor:'agent',origin:'tool_receipt',source:{system:'agent-runtime',key},occurredAt:current.updatedAt,...(current.threadId?{threadId:current.threadId}:{})},
        {op:'admit_subject_event',subjectId,event},
        {op:'put_agent_task',task:next,expectedRevision:current.revision}
      ]});return true;
    }catch(error){try{store.recordDiagnostic({stage:'agent.result-pending',status:'failed',context:{subjectId,taskId:current.id},data:{errorCode:error.code??'RESULT_PERSIST_FAILED'}});}catch{}return false;}
  }
  const driverFor=scene=>{
    if(global){
      if(globalDriver)return globalDriver;
      const workspace=ensureWorkspace(store,'global');
      globalDriver=new TurnDriver({...cognition,sessionFactory,store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,materialsFor:cognition.investigationContinuityV1?focusedProcessMaterials:null});
      globalDriver.loadState();if(rhythmReset){globalDriver.restore({state:{lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null},outbox:[]});globalDriver.persistState();}return globalDriver;
    }
    if(drivers.has(scene))return drivers.get(scene);
    const workspace=ensureWorkspace(store,scene);
    const driver=new TurnDriver({...cognition,sessionFactory,store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,materialsFor:cognition.investigationContinuityV1?focusedProcessMaterials:null});
    driver.loadState();if(rhythmReset){driver.restore({state:{lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null},outbox:[]});driver.persistState();}
    drivers.set(scene,driver);return driver;
  };
  const taskTools=hostAllowedTools===null?agentTools:Object.fromEntries(Object.entries(agentTools).filter(([name])=>hostAllowedTools.includes(name)));
  function assertTaskControl(task){
    const current=loadAgent(task.id);
    ensure(taskIntentCurrent(task),'INTENT_TASK_REVIEW_REQUIRED','bound Intent changed; explicit task review required');
    ensure((current.controlRevision??0)===(task.controlRevision??0)&&!['cancelled','paused'].includes(current.status),'AGENT_CONTROL_CHANGED','new host control supersedes the in-flight decision');
    ensure(!task.lease||current.lease?.token===task.lease.token,'AGENT_LEASE_LOST','another worker owns this task lease');
    return current;
  }
  function persistTaskProgress(task){
    const current=assertTaskControl(task);
    const identity=x=>x.eventRef?JSON.stringify(x.eventRef):JSON.stringify([x.at,x.message]);
    const interrupts=[...(current.interrupts??[])],known=new Set(interrupts.map(identity));
    for(const item of task.interrupts??[])if(!known.has(identity(item))){interrupts.push(item);known.add(identity(item));}
    task.interrupts=interrupts;task.revision=current.revision;saveAgent(task);
  }
  const agentRuntime=subjectTask?new AgentRuntime({tools:taskTools,now:clock,maxSteps:agentMaxSteps,onObservation:recordAgentObservation,checkpoint:persistTaskProgress}):null;
  function budgetGate(task){
    const exceeded=agentRuntime.budgetExceeded(task);if(!exceeded)return null;
    task.status='failed';task.blockedReason=exceeded;task.updatedAt=clock();saveAgent(task);try{recordAgentResult(task);}catch{}
    return {ok:false,status:'failed',error:exceeded};
  }
  function taskIntentCurrent(task){
    if(!task.intentRef)return true;
    const intent=store.read(task.intentRef.id);
    return intent?.type==='intent'&&intent.subject===subjectId&&intent.revision===task.intentRef.revision&&['open','pursuing','deferred'].includes(intent.status);
  }
  function claimAgentLease(id,owner,ttlMs=30000){
    for(let attempt=0;attempt<6;attempt++){
      const current=loadAgent(id);
      if(!['running','waiting'].includes(current.status))return {ok:false,reason:'NOT_RUNNABLE',status:current.status};
      const lease=current.lease;
      if(lease&&lease.expiresAt>clock())return {ok:false,reason:'LEASE_HELD',owner:lease.owner};
      const task=agentRuntime.restore(current);
      if(agentRuntime.pendingToolOperations(task).length){
        task.status='blocked';task.blockedReason='TOOL_OUTCOME_UNKNOWN';task.updatedAt=clock();
        try{store.execute({requestId:'agent-unknown-outcome:'+id+':'+randomUUID(),commands:[{op:'put_agent_task',task,expectedRevision:current.revision}]});recordAgentResult(task);return {ok:false,reason:'TOOL_OUTCOME_UNKNOWN',status:'blocked'};}
        catch(error){if(!['STATE_CONFLICT','CONFLICT','AGENT_TASK_CONFLICT'].includes(error.code))throw error;continue;}
      }
      if(!taskIntentCurrent(task)){task.status='blocked';task.blockedReason='INTENT_TASK_REVIEW_REQUIRED';task.updatedAt=clock();saveAgent(task);recordAgentResult(task);return {ok:false,reason:'INTENT_TASK_REVIEW_REQUIRED',status:'blocked'};}
      task.lease={owner,token:randomUUID(),expiresAt:clock()+ttlMs};task.updatedAt=clock();
      try{store.execute({requestId:'agent-lease:'+id+':'+task.lease.token,commands:[{op:'put_agent_task',task,expectedRevision:current.revision}]});return {ok:true,task:agentRuntime.restore(loadAgent(id))};}
      catch(error){if(!['STATE_CONFLICT','CONFLICT','AGENT_TASK_CONFLICT'].includes(error.code))throw error;}
    }
    return {ok:false,reason:'LEASE_CONTENTION'};
  }
  function releaseAgentLease(id,owner,token){
    const current=loadAgent(id);if(current.lease?.owner!==owner||current.lease?.token!==token)return false;const task=agentRuntime.restore(current);delete task.lease;task.updatedAt=clock();
    try{store.execute({requestId:'agent-release:'+id+':'+randomUUID(),commands:[{op:'put_agent_task',task,expectedRevision:current.revision}]});return true;}catch{return false;}
  }
  function saveAgent(task,{before=[],after=[]}={}){
    const current=store.read(task.id);
    ensure((task.revision??0)===(current?.revision??0),'AGENT_TASK_CONFLICT','task snapshot changed; do not overwrite current state');
    if(resultStatuses.has(task.status)){const key=resultKey(task);task.feedback=current?.feedback?.key===key?current.feedback:{key,status:'pending'};}
    const result=store.execute({requestId:`agent-save:${task.id}:${task.updatedAt}:${randomUUID()}`,commands:[...before,{op:'put_agent_task',task:JSON.parse(JSON.stringify(task)),expectedRevision:task.revision??0},...after]});task.revision=result.find(r=>r.type==='agent_task'&&r.id===task.id).revision;return result;
  }
  function loadAgent(id){const record=store.read(id);ensure(record?.type==='agent_task','AGENT_TASK','unknown agent task');return record;}
  function listAgent(){return [...store.all('agent_task')];}
  let draining=false;
  let agentBusy=false,reflectionBusy=false;
  async function createAgentTask(input={}){
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    const task=agentRuntime.createTask({goal:input.goal,plan:input.plan??'',target:input.target??null,threadId:input.threadId??null,processId:input.processId??null,originEventRef:input.originEventRef??null,originDecisionRef:input.originDecisionRef??null,completionCriteria:input.completionCriteria??null,subjectId:input.subjectId??null,intentRef:input.intentRef??null,budget:input.budget??null,metadata:input.metadata??null,id:input.id??null,context:input.context??subjectContext()});
    saveAgent(task,{before:(input.guardRefs??[]).map(ref=>({op:'assert_current',ref}))});return task;
  }
  async function interruptAgentTask(id,message){
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    const task=agentRuntime.restore(loadAgent(id));agentRuntime.interrupt(task,message);return {ok:true,id,count:task.interrupts.length};
  }
  async function runAgentStep(id,owner){
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null)return {ok:false,error:'AGENT_BUSY',skipped:true};
    agentBusy=true;let task,leaseToken,driver;
    try{
      const claimed=claimAgentLease(id,owner);if(!claimed.ok)return {ok:false,error:claimed.reason,status:claimed.status};
      task=claimed.task;leaseToken=task.lease?.token;
      driver=driverFor(global?'global':task.target??'agent/task');const recovered=driver.recoverTaskDecision(task),capture=driver.capturedTaskPacket(task);
      const gate=recovered||capture?agentRuntime.budgetExceeded(task,clock(),{ignoreCalls:true}):budgetGate(task);if(gate)return typeof gate==='string'?{ok:false,status:task.status,error:gate}:gate;
      if(task.status==='waiting'&&!agentRuntime.resume(task,{at:clock()}))return {ok:true,skipped:true,id,status:'waiting'};
      driver=driverFor(global?'global':task.target??'agent/task');
      const decided=recovered??(capture?await driver.recoverTaskCapture(task,capture):null)??await driver.decideTaskStep(task,{now:clock(),onDecisionReady:()=>assertTaskControl(task),maxModelCalls:agentRuntime.remainingCalls(task),onModelAttempt:()=>{
        assertTaskControl(task);task.callCount=(task.callCount??0)+1;persistTaskProgress(task);
      }});
      assertTaskControl(task);
      if(decided.lookupExhausted){task.status='blocked';task.blockedReason='LOOKUP_EXHAUSTED';task.updatedAt=clock();persistTaskProgress(task);return {ok:false,id,status:'blocked',error:'LOOKUP_EXHAUSTED'};}
      const result=await agentRuntime.step(task,decided.decision,{afterModelAttempt:true});
      if(['done','blocked','failed','cancelled'].includes(task.status))recordAgentResult(task);
      return {...result,id:task.id,status:task.status,step:task.stepCount};
    }catch(error){if(task)failAgentDecision(task,error);recoverSettledRejectedTurns();return {ok:false,id,status:task?.status,error:error.code??'TASK_STEP_ERROR'};}
    finally{if(task){try{releaseAgentLease(id,owner,leaseToken);}catch{}}try{driver?.persistState();}catch{}agentBusy=false;}
  }
  const stepAgentTask=id=>runAgentStep(id,'api-step');
  function supersedeTaskCaptures(task){return [...store.all('affect_turn')].filter(t=>t.subject===subjectId&&t.status==='captured'&&t.packet.payload.task?.id===task.id&&((t.packet.payload.task.controlRevision??0)!==(task.controlRevision??0)||['paused','cancelled'].includes(task.status))).map(t=>({op:'affect_turn',id:t.id,expectedRevision:t.revision,status:'superseded',error:'HOST_CONTROL_CHANGED'}));}
  async function stopAgentTask(id,reason){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(['done','failed','cancelled'].includes(task.status))return {ok:false,id,status:task.status};task.status='cancelled';task.result=String(reason??'stopped').slice(0,8000);task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
  async function redirectAgentTask(id,input){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(!['running','blocked','paused'].includes(task.status))return {ok:false,id,status:task.status};if(agentRuntime.pendingToolOperations(task).length)return {ok:false,id,status:task.status,error:'TOOL_OUTCOME_UNKNOWN'};if(typeof input?.goal==='string'&&input.goal.trim())task.goal=input.goal.trim();if(typeof input?.plan==='string')task.plan=input.plan.slice(0,8000);if(input?.target!==undefined)task.target=input.target;task.status='running';task.blockedReason=null;task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
  function reconcileAgentTool(id,input){
    const current=loadAgent(id),review=input?.review;
    ensure(review?.format==='jingyang-tool-outcome-review-v1'&&review.taskId===id&&input.reviewHash===digest(review),'TOOL_REVIEW','exact review artifact required');
    const key=Object.keys(current.toolOps??{}).find(k=>(current.toolOps[k].operationId??createHash('sha256').update(k).digest('hex'))===review.operationId);
    ensure(key,'TOOL_REVIEW','operation not found');const prior=current.toolOps[key];
    if(prior.reviewHash===input.reviewHash)return {ok:true,replayed:true};
    ensure(current.revision===input.expectedRevision,'AGENT_TASK_CONFLICT','review used a stale task');
    ensure(['started','uncertain'].includes(prior.status)&&['succeeded','not-executed'].includes(review.outcome)&&typeof review.evidence?.locator==='string'&&review.evidence.locator.length>0&&/^[a-f0-9]{64}$/.test(review.evidence?.sha256??''),'TOOL_REVIEW','unconfirmed operation and explicit outcome evidence required');
    const task=agentRuntime.restore(current),eventId='tool-review:'+digest(review),eventRef={id:eventId,revision:1};
    const observation={at:clock(),kind:'tool',operationId:review.operationId,ok:review.outcome==='succeeded',result:review.result??null,...(review.outcome==='not-executed'?{error:'CONFIRMED_NOT_EXECUTED'}:{}),verification:'operator-attested; not independently verified',evidence:review.evidence};
    task.toolOps[key]={...prior,status:observation.ok?'succeeded':'failed',observation,reviewHash:input.reviewHash};task.observations.push(observation);task.observationRefs.push(eventRef);
    task.status='blocked';task.blockedReason='TOOL_OUTCOME_RECONCILED';task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=clock();
    store.execute({requestId:eventId,commands:[{op:'put_extension_record',id:'extension:'+subjectId+':runtime:tool-review:'+digest(review),owner:subjectId,theory:'runtime',stateType:'tool-review',schemaVersion:'1',expectedRevision:0,value:review},
      {op:'append_event',id:eventId,body:JSON.stringify(observation),scene:task.target??'agent/task',actor:'host-review',origin:'tool_receipt',source:{system:'operator-tool-review',key:eventId},occurredAt:clock()},
      {op:'admit_subject_event',subjectId,event:eventRef},{op:'put_agent_task',task,expectedRevision:current.revision}]});
    return {ok:true,status:'blocked',resumeRequired:true};
  }
  async function stopAllAgentTasks(reason='user stop'){const out=[];for(const t of listAgent()){if(['running','waiting','blocked'].includes(t.status)){const r=await stopAgentTask(t.id,reason);out.push(r);}}return {ok:true,stopped:out.length,items:out};}
  async function pauseAgentTask(id,reason){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(!['running','waiting'].includes(task.status))return {ok:false,id,status:task.status};task.status='paused';task.blockedReason=String(reason??'paused').slice(0,2000);task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
  async function resumeAgentTask(id,input){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(!['blocked','paused','waiting'].includes(task.status))return {ok:false,id,status:task.status};if(agentRuntime.pendingToolOperations(task).length)return {ok:false,id,status:task.status,error:'TOOL_OUTCOME_UNKNOWN'};if(!taskIntentCurrent(task))return {ok:false,id,status:task.status,error:'INTENT_TASK_REVIEW_REQUIRED'};const replayCapture=task.status==='blocked'&&!input?.message&&[...store.all('affect_turn')].some(t=>t.subject===subjectId&&t.status==='captured'&&t.packet.payload.task?.id===task.id&&(t.packet.payload.task.controlRevision??0)===(task.controlRevision??0));if(typeof input?.message==='string'&&input.message.trim())task.interrupts.push({at:clock(),message:input.message.trim()});if(!repairAgentObservation(task))return {ok:false,id,status:'blocked',error:'OBSERVATION_REPAIR_FAILED'};task.status='running';task.blockedReason=null;task.controlRevision=(task.controlRevision??0)+(replayCapture?0:1);task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
  async function agentTick(){
    if(!agentRuntime||agentBusy||reflectionBusy||scheduler.active()!==null)return {skipped:true};
    for(const task of listAgent())if(resultStatuses.has(task.status)&&task.feedback?.status==='pending')recordAgentResult(task);
    const tasks=listAgent().filter(t=>t.status==='running'||t.status==='waiting').sort((a,b)=>a.updatedAt-b.updatedAt);
    const task=tasks.find(t=>t.status==='running'||(t.wakeAt??0)<=clock()||(t.interrupts?.length??0)>(t.interruptCursor??0));
    return task?runAgentStep(task.id,'brain-tick'):{skipped:true};
  }
  function repairAgentObservation(task){
    if(!task||task.blockedReason!=='OBSERVATION_PERSIST_FAILED')return true;
    const observation=[...task.observations].reverse().find(o=>o.kind==='tool');
    if(!observation)return false;
    try{recordAgentObservation(task,observation);task.blockedReason=null;task.status='running';task.updatedAt=clock();saveAgent(task);return true;}catch{return false;}
  }
  function associateTaskInterrupt(scene,event,message){
    if(!agentRuntime||!message)return;
    const record=store.read(event.id);if(!record)return;
    const all=listAgent().filter(t=>t.target===scene);
    const explicit=String(message).match(/\btask:([A-Za-z0-9:_-]+)/);
    const active=all.filter(t=>['running','waiting'].includes(t.status));
    const targets=explicit?all.filter(t=>t.id===('task:'+explicit[1])||t.id===explicit[1]):(active.length===1?active:[]);
    for(const stored of targets){
      const task=agentRuntime.restore(stored);task.interrupts=Array.isArray(task.interrupts)?task.interrupts:[];
      if(task.interrupts.some(x=>x.eventRef?.id===event.id))continue;
      task.interrupts.push({at:clock(),message:String(message).slice(0,4000),eventRef:{id:event.id,revision:event.revision},...(record.message?{messageParts:record.message}:{})});
      if(task.status==='blocked'){
        const observationBlock=task.blockedReason==='OBSERVATION_PERSIST_FAILED'||task.blockedReason==='OBSERVATION_ADMIT_FAILED'||task.blockedReason==='OBSERVATION_MESSAGE_INVALID';
        if(observationBlock&&!repairAgentObservation(task)){task.updatedAt=clock();saveAgent(task);continue;}
        task.status='running';task.blockedReason=null;
      }
      task.updatedAt=clock();saveAgent(task);
    }
  }
  function observe(input){
    const normalized=normalizeInbound(input);
    let sender=normalized.sender,actor=normalized.actor;
    if(sender?.system&&sender?.id){
      const person=ensurePerson(store,{system:sender.system,id:sender.id,name:sender.name,nickname:sender.nickname??null,isOwner:sender.isOwner===true});
      sender={...sender,entityId:person.entityId};actor=person.entityId;
    }
    const queueKey=global?'global':normalized.scene;
    const driver=driverFor(global?'global':normalized.scene);
    const at=normalized.at??clock();
    if(policy.matches(normalized.scene)){
      const event=driver.ingest({key:normalized.key,body:normalized.body,message:normalized.message??null,actor,sender,scene:normalized.scene,at,threadId:normalized.threadId,admit:false});
      policy.add({id:event.id,scene:normalized.scene,at});
      saveState();
      return {queued:false,muted:true,scene:normalized.scene,pending:scheduler.pending()};
    }
    const ev=driver.ingest({key:normalized.key,body:normalized.body,message:normalized.message??null,actor,sender,scene:normalized.scene,at,threadId:normalized.threadId});associateTaskInterrupt(normalized.scene,ev,normalized.body);
    cursor={...cursor,lastEventId:`obs:${normalized.key}`,lastAt:at,eventsSince:cursor.eventsSince+1};saveCursor();
    scheduler.enqueue(queueKey,{key:normalized.key,body:normalized.body,scene:normalized.scene,actor,at,threadId:normalized.threadId});
    saveState();
    return {queued:true,scene:normalized.scene,pending:scheduler.pending()};
  }
  function mute(prefix){return policy.mute(prefix);}
  function unmute(prefix,{load=true}={}){const next=policy.unmute(prefix);if(load)loadBacklog(prefix,50);return next;}
  function loadBacklog(prefix,limit=50){
    const entries=policy.take(prefix,limit);
    for(const entry of entries){
      const event=store.read(entry.id);if(!event)continue;
      store.execute({requestId:`attention:${entry.id}:admit`,commands:[{op:'admit_subject_event',subjectId,event:{id:event.id,revision:event.revision}}]});
      scheduler.enqueue(global?'global':entry.scene,{key:event.id,body:event.body,scene:entry.scene,actor:event.actor,at:event.occurredAt??event.recordedAt,threadId:event.threadId??null});
    }
    saveState();
    return {loaded:entries.length,pending:scheduler.pending()};
  }
  async function executeAction(actionRef){
    const action=store.read(actionRef.id);
    ensure(action?.type==='action','ACTION','existing action required');
    if(action.status!=='proposed')return {replayed:true,action:{id:action.id,revision:action.revision},status:action.status,receipt:action.receipt};
    try{validateToolArguments(action.tool,action.args??{});}catch(error){error.nativePreflight=true;throw error;}
    if(action.tool==='start_agent_task'){
      const args=action.args??{};
      const parentDecision=[...store.all('decision')].find(d=>d.action?.id===action.id);const originDecisionRef=parentDecision?{id:parentDecision.id,revision:parentDecision.revision}:null;
      const eventInputs=(action.inputRefs??[]).filter(r=>store.read(r.id,r.revision)?.type==='event');
      const originEventRef=parentDecision?.currentEvent??(!parentDecision&&eventInputs.length===1?eventInputs[0]:null);
      const origin=originEventRef?store.read(originEventRef.id,originEventRef.revision):null;
      const target=args.target??sourceRoute({action:{id:action.id,revision:action.revision}}).scene;
      const threadId=args.threadId??origin?.threadId??null;
      const processId=parentDecision?.output?.continuity?.attention?.processes?.[0]?.id??parentDecision?.input?.payload?.continuity?.attention?.processes?.[0]?.id??null;const effectiveThreadId=threadId??processId??originEventRef?.threadId??null;
      const plan=Array.isArray(args.plan)?args.plan.join('；'):String(args.plan??'');
      const tools=Array.isArray(args.allowedTools)&&args.allowedTools.length?args.allowedTools:['qq_list_friends','qq_list_groups','qq_list_stickers','anchor_recall','attention_status','web_search'];
      let task=store.read('task:'+action.id),intentRef=null;
      if(!task&&args.intentId){
        const intent=store.read(args.intentId);ensure(intent?.type==='intent'&&intent.subject===subjectId&&['open','pursuing'].includes(intent.status),'INTENT','open own intent required');
        intentRef={id:intent.id,revision:intent.revision};
        const related=[...store.all('agent_task')].filter(t=>t.intentRef?.id===intentRef.id);
        ensure(!related.some(t=>agentRuntime.pendingToolOperations(t).length),'TOOL_OUTCOME_UNKNOWN','an earlier task under this intent has an unconfirmed effect; cancellation is not execution evidence');
        task=related.find(t=>t.intentRef.revision===intentRef.revision&&t.goal===String(args.goal??'').trim()&&!['failed','cancelled'].includes(t.status));
        if(!task)ensure(!related.some(t=>t.intentRef.revision!==intentRef.revision&&['running','waiting','paused','blocked'].includes(t.status)),'INTENT_TASK_REVIEW_REQUIRED','an older intent version still has active work; explicitly review it before starting another');
        if(!task&&parentDecision){const pinned=action.intentRef;ensure(pinned?.id===intent.id&&pinned.revision===intent.revision,'STALE_INTENT','task start requires its committed intent version');}
      }
      if(!task)task=await createAgentTask({id:'task:'+action.id,goal:args.goal,plan,target,threadId:effectiveThreadId,processId,originEventRef,originDecisionRef,subjectId,intentRef,guardRefs:intentRef?[intentRef]:[],metadata:{allowedTools:tools}});
      const eventId=`task-receipt:${action.id}`;
      return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',eventId,body:`task started: ${task.id}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});
    }
    if(action.tool==='pause_agent_task'){const args=action.args??{};const out=await pauseAgentTask(args.taskId,args.reason);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task pause: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='stop_agent_task'){const args=action.args??{};const out=await stopAgentTask(args.taskId,args.reason);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task stop: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='redirect_agent_task'){const args=action.args??{};const out=await redirectAgentTask(args.taskId,args);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task redirect: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='remember_note'){
      const args=action.args??{};
      const note=rememberNote({store,id:`note:${randomUUID()}`,body:args.body,kind:args.kind??'fact_claim',scene:args.scene??null,anchor:args.anchor??null});
      const eventId=`remember-receipt:${action.id}`;
      return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',eventId,body:'已记下',source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});
    }
    ensure(action.tool==='remember-binding','ACTION','only remember-binding/remember_note are executable locally');
    const commands=bindingCommands({store,action,eventId:`${action.id}:receipt`,body:'已记下绑定'});
    return store.execute({requestId:`execute:${action.id}`,commands});
  }
  function admitNativeReceipt(actionId){
    const current=store.read(actionId);if(!current?.receipt)return null;
    const fixed=current.receipt,event=store.read(fixed.id,fixed.revision);
    ensure(event?.type==='event'&&event.origin==='tool_receipt','NATIVE_RECEIPT','stored native receipt required');
    store.execute({requestId:`native-receipt-admit:${subjectId}:${fixed.id}:${fixed.revision}`,commands:[{op:'admit_subject_event',subjectId,event:fixed}]});
    return fixed;
  }
  async function dispatch(outbox,{scene,execute=false}={}){
    const sent=[];
    for(const item of outbox??[]){
      if(item.kind==='respond'){
        if(execute&&adapter?.send){
          ensure(item.response,'RESPONSE_REQUIRED','durable response identity required before sending');
          const current=store.read(item.response.id);
          if(current?.status!=='pending'){sent.push({delivered:current?.status==='sent',status:current?.status??'missing',replayed:true});continue;}
          // A stored response may have been created with the legacy 'global'
          // label. Resolve its pinned execution source, not the current caller.
          const decision=store.read(current.decision.id,current.decision.revision);
          const storedScene=concreteReplyScene(current.scene)?current.scene:null;
          const itemScene=concreteReplyScene(item.scene)?item.scene:null;
          const originScene=decisionReplyScene(current.decision);
          const sendScene=storedScene??(decision?.currentEvent?originScene:(originScene??itemScene??scene));
          if(!concreteReplyScene(sendScene)){
            store.recordDiagnostic({stage:'response.route-unresolved',status:'rejected',context:{subjectId,decisionId:current.decision.id},data:{responseId:current.id,reason:'no-unambiguous-persisted-target; no-send-attempt'}});
            item.delivery={status:'route-unresolved'};sent.push({kind:'respond',delivered:false,status:'pending',error:'RESPONSE_TARGET_UNRESOLVED'});continue;
          }
          const claimed=responseClaim({response:item.response,worker:'brain-host'});let result,outcome='unknown';
          try{result=await adapter.send({scene:sendScene,text:current.body});outcome=result?.delivered===false?'failed':'sent';}
          catch(error){
            if(error.transportInvoked===false){outcome='failed';result={error:error.code??'SEND_ERROR',message:error.message,transportInvoked:false};}
            else result={error:error.code??'SEND_ERROR'};
          }
          responseDelivered({response:claimed.response,claimId:claimed.claimId,outcome,body:JSON.stringify({...(result??{outcome}),scene:sendScene})});
          item.delivery={status:outcome};sent.push({...result,delivered:outcome==='sent',status:outcome});
        }else sent.push({kind:'respond',text:item.text,delivered:false});
      }else if(item.kind==='act'){
        if(item.action&&['remember-binding','remember_note','start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task'].includes(item.tool)){
          try{const result=await executeAction(item.action);admitNativeReceipt(item.action.id);item.execution={status:store.read(item.action.id).status};sent.push(result);}
          catch(error){
            let current=store.read(item.action.id),recording='existing',recordingError=null;
            if(current?.status==='proposed'){
              const knownUnexecuted=error.nativePreflight===true&&error.transportInvoked===false;
              try{receipt({scene,action:{id:current.id,revision:current.revision},status:knownUnexecuted?'failed':'interrupted',body:JSON.stringify({error:error.code??'ACTION_ERROR',message:error.message,phase:knownUnexecuted?'preflight':'native-execution',...(knownUnexecuted?{transportInvoked:false}:{outcome:'unknown',warning:'local effect may exist; do not automatically retry'})}),eventId:'host-action:'+current.id});recording='recorded';}
              catch(e){recording='failed';recordingError=e.code??e.name;}
              current=store.read(item.action.id);
            }
            item.execution={status:current?.status??'unknown',error:error.code??'ACTION_ERROR',receiptRecording:recording,...(recordingError?{receiptError:recordingError}:{})};
            try{store.recordDiagnostic({stage:'native-action.failed',status:'rejected',context:{subjectId},data:{actionId:item.action.id,tool:item.tool,...item.execution}});}catch{}
            sent.push({kind:'act',tool:item.tool,action:item.action,delivered:false,error:{code:error.code??'ACTION_ERROR',message:error.message},receiptRecording:recording});
          }
        }
        else if(execute&&adapter?.act){
          ensure(item.action,'ACTION','durable action identity required');const claim=actionClaim({action:item.action,worker:'brain-host'});let status='interrupted',body;
          try{body=JSON.stringify(await adapter.act({scene,tool:item.tool,args:item.args,action:claim.action}));status='succeeded';}catch(error){if(error.transportInvoked===false){status='failed';body=JSON.stringify({error:error.code,message:error.message,transportInvoked:false});}else body=error.message;}
          receipt({scene,action:claim.action,claimId:claim.claimId,status,body:body??'',eventId:'host-action:'+item.action.id});item.execution={status};sent.push({kind:'act',status});
        }
        else sent.push({kind:'act',tool:item.tool,delivered:false});
      }
    }
    return sent;
  }
  function recoverSettledRejectedTurns(){
    const closed=[];if(!runtimeInfo?.ledgerPath)return closed;
    try{const bytes=readFileSync(runtimeInfo.ledgerPath),ledger=JSON.parse(bytes);
      for(const t of store.all('affect_turn'))if(t.subject===subjectId&&['failed','uncertain'].includes(t.status)){
        const row=ledger.requests?.find(r=>r.id==='turn:'+t.packet.packetId);
        // Quota refusal is terminal for this source, not an interrupted provider
        // request. Require both durable no-transport proof and no budget row;
        // genuine UNKNOWN reservations must remain blocked and fully retained.
        const unsentQuota=t.status==='failed'&&['DAILY_BUDGET_LIMIT','SPEND_LIMIT','CALL_LIMIT','BUDGET_EXPIRED','BUDGET_HALTED'].includes(t.error)&&t.transportInvoked===false&&!row;
        if(row?.status==='settled'||unsentQuota){
          closeRecoveryTurn({turnId:t.id,expectedRevision:t.revision,ledgerHash:createHash('sha256').update(bytes).digest('hex')});
          const done=store.read(t.id);if(done.status==='closed-incomplete')closed.push({format:'host-processing-outcome-v1',status:'failed-not-adopted',packetId:t.packet.packetId,sourceEvent:t.packet.payload.current?.id??null,adopted:false,execution:'not-started',accounting:unsentQuota?'not-dispatched':'settled',closure:{id:done.id,revision:done.revision},error:t.error});
        }
      }
    }catch(error){try{store.recordDiagnostic({stage:'recovery.deferred',status:'rejected',data:{error:error.code??'RECOVERY_ERROR'}});}catch{}}
    return closed;
  }
  async function turn({preferred=null,deliver=false,execute=false}={}){
    if(draining||agentBusy||reflectionBusy)return {ok:true,busy:true,pending:scheduler.pending()};
    syncSchedulerInbox();
    const queueKey=scheduler.next({preferred:global?null:preferred});
    if(queueKey===null)return {ok:true,busy:true,pending:scheduler.pending()};
    scheduler.activate(queueKey);
    try{
      const item=scheduler.shift(queueKey);
      const scene=item?.scene??queueKey;
      const driver=driverFor(global?'global':scene);
      let result;
      try{result=await driver.tick({now:clock()});}
      catch(error){
        const closed=recoverSettledRejectedTurns();let processingOutcome=closed.find(c=>c.sourceEvent===item?.key||c.sourceEvent==='obs:'+item?.key);
        // A failed input has no packet/provider call. Quarantine only an exact
        // fresh source with no prior adopted decision and no in-flight journal.
        if(!processingOutcome&&['INPUT_OVERFLOW','WORKBENCH_REQUIRED_OVERFLOW'].includes(error.code)){
          const id=item?.key?.startsWith('obs:')?item.key:'obs:'+item?.key,event=store.read(id);
          const adopted=[...store.all('decision')].some(d=>d.input?.payload?.continuity?.subject?.id===subjectId&&d.currentEvent?.id===id);
          const pending=[...store.all('extension_record')].some(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&!['complete','ready'].includes(r.value.phase));
          if(event?.type==='event'&&!adopted&&!pending){
            const fid='extension:'+subjectId+':runtime:input-failure:'+digest({id,error:error.code}),value={stage:'input',sourceEvent:id,error:error.code,message:error.message,details:error.details??{},adopted:false,execution:'not-started',accounting:'not-dispatched'};
            let record=store.read(fid);if(!record)record=store.execute({requestId:fid,commands:[{op:'quarantine_source',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:event.revision},reason:error.code},{op:'put_extension_record',id:fid,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value}]}).at(-1);
            processingOutcome={format:'host-processing-outcome-v1',status:'failed-not-adopted',sourceEvent:id,packetId:'input:'+id,packetPrepared:false,adopted:false,execution:'not-started',accounting:'not-dispatched',closure:{id:record.id,revision:record.revision},error:error.code};
          }
        }
        if(!processingOutcome)scheduler.enqueue(queueKey,item);driver.persistState();saveState();
        return {ok:false,error:error.code??'TURN_ERROR',message:error.message,retryable:!processingOutcome,...(processingOutcome?{processingOutcome}:{}),pending:scheduler.pending()};
      }
      if(!result?.decision&&(result?.wake===false||result?.action==='budget-blocked')){
        scheduler.enqueue(queueKey,item);
        driver.persistState();saveState();
        return {ok:true,busy:true,deferred:true,result,pending:scheduler.pending()};
      }
      try{store.execute({requestId:'release:'+randomUUID(),commands:[{op:'release_completed_workbench',subjectId}]});}catch{}
      const outbox=driver.takeOutbox();
      let targetScene=scene;
      if(global&&result.decision){
        targetScene=decisionReplyScene(result.decision,scene);
      }
      for(const o of outbox)o.scene=targetScene;
      driver.persistState();saveState();
      const delivery=deliver?await dispatch(outbox,{scene:targetScene,execute}):null;
      return {ok:true,scene:targetScene,item:item?.key??null,result,outbox,delivery,silent:!outbox.some(o=>o.kind==='respond'),pending:scheduler.pending()};
    }finally{scheduler.complete(queueKey);}
  }
  async function reply(input){
    const execute=input.execute!==false;
    const scene=String(input.scene??input.key??'');
    ensure(scene,'ADAPTER','scene required');
    const source=String(input.source??(scene.split('/')[0]||'qq'));
    const messageValue=input.message??null;
    let body=messageValue?projectText(normalizeMessage(messageValue)):firstText(input.messages??[{role:'user',content:input.text??''}]);
    ensure(body,'ADAPTER','reply needs message text');
    const chatKey=keyFor(scene,input.key);
    const sourceKey=`${chatKey}:${input.message_id??`${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    observe({source,key:chatKey,sourceKey,text:body,message:messageValue,scene,sender:input.sender??null,threadId:input.threadId??null,occurredAt:input.occurredAt??input.message_time??null});
    const maxWaitMs=Number.isSafeInteger(input.waitMs)&&input.waitMs>=0?Math.min(120000,input.waitMs):30000;
    const deadline=Date.now()+maxWaitMs;
    let result;
    for(;;){
      result=await turn({preferred:global?null:scene,deliver:true,execute});
      if(result?.error||result?.deferred||!result?.busy)break;
      if(Date.now()>=deadline)break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(10,deadline-Date.now()))));
    }
    if(result?.error)return {ok:false,error:result.error,message:result.message,retryable:false,scene,outbox:[],silent:true,busy:false,...(result.processingOutcome?{processingOutcome:result.processingOutcome}: {})};
    const text=result.outbox?.find(o=>o.kind==='respond')?.text??'';
    return {ok:true,scene,text,outbox:result.outbox??[],silent:result.silent??true,busy:result.busy??false,deferred:result.deferred??false};
  }
  function receipt({scene,action,status,body,eventId,claimId=null,actor='host',occurredAt=clock()}){
    ensure(scene&&action,'ADAPTER','receipt needs scene/action');
    const driver=driverFor(global?'global':scene);
    return driver.applyReceipt({action,status,body,eventId,claimId,actor,occurredAt});
  }
  function actionClaim(input){
    const current=store.read(input.action?.id);ensure(current?.type==='action','ACTION','action required');
    ensure(allowedActionTools.includes(current.tool),'TOOL_NOT_GRANTED','tool is no longer granted');
    const claimId='action-claim:'+randomUUID();
    const claimed=store.execute({requestId:claimId,commands:[{op:'claim_action',action:{id:current.id,revision:current.revision},claimId,worker:input.worker??'connector'}]}).at(-1);
    return {action:{id:claimed.id,revision:claimed.revision},claimId};
  }
  function responseClaim(input){
    const current=store.read(input.response?.id);ensure(current?.type==='response'&&current.subject===subjectId,'RESPONSE_REQUIRED','own response required');
    const claimId='claim:'+randomUUID();
    const claimed=claimResponse({store,response:{id:current.id,revision:current.revision},claimId,worker:input.worker??'qq-connector',requestId:claimId});
    return {response:{id:claimed.id,revision:claimed.revision},claimId};
  }
  function responseDelivered(input){
    const current=store.read(input.response?.id);ensure(current?.type==='response'&&current.subject===subjectId,'RESPONSE_REQUIRED','own response required');
    if(['sent','failed','unknown'].includes(current.status))return current;
    ensure(current.status==='dispatching'&&input.claimId===current.claimId,'RESPONSE_NOT_CLAIMED','claim before sending; do not send again when acknowledgement is missing');
    const receiptId='delivery:'+current.id+':'+input.claimId;
    return recordResponseDelivery({store,response:{id:current.id,revision:current.revision},claimId:input.claimId,outcome:input.outcome??'sent',eventId:receiptId,body:input.body??'发送回执',source:{system:'qq-host',key:receiptId},actor:'qq-connector',requestId:receiptId});
  }
  function recoveryTurn(id){
    const turn=store.read(id);ensure(turn?.type==='affect_turn'&&turn.subject===subjectId,'AFFECT_TURN','own model turn required');
    return {id:turn.id,revision:turn.revision,status:turn.status,error:turn.error??null,transportInvoked:turn.transportInvoked??null,packetId:turn.packet.packetId,outputHash:typeof turn.rawOutput==='string'?digest(turn.rawOutput):null};
  }
  function closeRecoveryTurn(input){
    const turn=store.read(input.turnId);recoveryTurn(input.turnId);ensure(turn.revision===input.expectedRevision,'AFFECT_TURN_VERSION','turn changed since review');
    ensure(typeof runtimeInfo?.ledgerPath==='string','AFFECT_RESOLUTION','configured accounting ledger required');
    const bytes=readFileSync(runtimeInfo.ledgerPath);const evidenceHash=createHash('sha256').update(bytes).digest('hex');ensure(evidenceHash===input.ledgerHash,'AFFECT_RESOLUTION','accounting file changed since review');
    const data=JSON.parse(bytes);ensure(data.format==='jingyang-daily-brain-budget-v1'&&Array.isArray(data.requests),'AFFECT_RESOLUTION','configured daily ledger format required');validateBudgetRows(data.requests);const row=data.requests.find(r=>r.id==='turn:'+turn.packet.packetId);let resolution;
    if(turn.status==='failed'&&turn.transportInvoked===false&&!row)resolution={reason:turn.error,requestId:null,noProviderCall:true};
    else if(row?.status==='settled'&&Number.isSafeInteger(row.actualMicros)&&row.actualMicros>=0){
      const selected=row.proposalRecovery?selectedModelOutput(data.requests,row):null;
      const raw=selected?.output??row.output??row.providerResult?.output;
      if(turn.status==='failed'&&typeof turn.rawOutput==='string'&&raw===turn.rawOutput)resolution={reason:'OUTPUT_REJECTED',outputHash:digest(turn.rawOutput)};
      else if(turn.error==='AFFECT_OUTPUT_LIMIT'&&typeof raw==='string'&&Buffer.byteLength(raw)>32768)resolution={reason:'AFFECT_OUTPUT_LIMIT',outputHash:digest(raw)};
      else ensure(turn.error==='MODEL_INCOMPLETE'&&row.providerResult?.complete===false,'AFFECT_RESOLUTION','settled row does not establish this rejected/incomplete output');
      resolution={...resolution,requestId:row.id,ledgerStatus:'settled',actualMicros:row.actualMicros,evidenceHash};
    }else if(turn.error==='UNCERTAIN_REQUEST'&&row?.status==='uncertain'&&Number.isSafeInteger(row.reserveMicros)&&row.reserveMicros>0&&input.keepUnknownReserve===true){
      resolution={reason:'UNCERTAIN_REQUEST',requestId:row.id,ledgerStatus:'uncertain',reserveMicros:row.reserveMicros,evidenceHash};
    }else ensure(false,'AFFECT_RESOLUTION','no positive accounting evidence; reservations and turn are preserved');
    const commands=[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'closed-incomplete',resolution}];
    // Close the host continuation in the same transaction. Closing only the affect
    // record would leave the journal trying to replay that quarantined source.
    for(const r of store.all('extension_record'))if(r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&r.value.packet?.packetId===turn.packet.packetId&&r.value.phase!=='complete'){
      commands.push({op:'put_extension_record',id:r.id,owner:r.owner,theory:r.theory,stateType:r.stateType,schemaVersion:r.schemaVersion,expectedRevision:r.revision,value:{...r.value,phase:'complete',closure:{turnId:turn.id,reason:resolution.reason??turn.error,evidenceHash}}});
    }
    const closed=store.execute({requestId:'operator-close:'+turn.id+':'+turn.revision,commands})[0];
    return {ok:true,status:closed.status,journalsClosed:commands.length-1,ledgerUnchanged:true,unknownReserveRetained:row?.status==='uncertain'};
  }
  function pendingEffects(){return {responses:[...store.all('response')].filter(r=>r.subject===subjectId&&['pending','dispatching','unknown'].includes(r.status)).map(r=>({kind:'respond',text:r.body,scene:r.scene,response:{id:r.id,revision:r.revision},status:r.status})),
    actions:[...store.all('action')].filter(a=>['proposed','dispatching','interrupted'].includes(a.status)).map(a=>({kind:'act',tool:a.tool,action:{id:a.id,revision:a.revision},status:a.status}))};}

  function stats(){const counts={};for(const type of ['event','note','entity','binding','personal_state','workspace','action','decision','link'])counts[type]=[...store.all(type)].length;return {ok:true,subjectId,counts,style:styles.status(),attention:policy.status(),context:cursor};}
  function recoveryStatus(){
    const own=[...store.all('affect_turn')].filter(t=>t.subject===subjectId&&!['committed','closed-incomplete','superseded'].includes(t.status));
    const activities=[...store.all('extension_record')].filter(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&r.value.phase!=='complete');
    const effects=pendingEffects();return {modelTurns:own.map(t=>({id:t.id,status:t.status,error:t.error??null})).slice(0,32),modelTurnCount:own.length,activities:activities.map(r=>({id:r.id,phase:r.value.phase})).slice(0,32),
      responses:{pending:effects.responses.filter(r=>r.status==='pending').length,unconfirmed:effects.responses.filter(r=>r.status!=='pending').length},actions:{pending:effects.actions.filter(r=>r.status==='proposed').length,unconfirmed:effects.actions.filter(r=>r.status!=='proposed').length},
      toolsUnconfirmed:listAgent().reduce((n,t)=>n+(agentRuntime?.pendingToolOperations(t).length??0),0)};
  }
  function health(){const theory=typeof theoryStatus==='function'?theoryStatus():null;return {ok:true,draining,recovery:recoveryStatus(),mode:decide===dryDecide?'dry-run':'custom',subjectId,global,cognitionBusy:agentBusy||reflectionBusy||scheduler.active()!==null||(agentRuntime?.pendingExecutions()??0)>0,externalWorkPending:agentRuntime?.pendingExecutions()??0,active:scheduler.active(),pending:scheduler.pending(),scenes:global?1:drivers.size,attention:policy.status(),...(runtimeInfo?{runtime:runtimeInfo}:{}),scheduling:{enabled:timer!==null,intervalMs:scheduleIntervalMs},...(theory?{theory}: {})};}
  function saveState(){if(!stateFile)return;try{writeFileSync(stateFile,JSON.stringify({scheduler:scheduler.snapshot()}),'utf8');}catch{}}
  function restoreState(){
    if(!stateFile||!existsSync(stateFile))return;
    try{
      const saved=JSON.parse(readFileSync(stateFile,'utf8')),snap=saved.scheduler;
      if(!snap||!Array.isArray(snap.scenes))return;
      for(const s of snap.scenes)for(const item of s.queue??[]){
        driverFor(global?'global':s.key);
        scheduler.enqueue(global?'global':s.key,item);
      }
    }catch(error){process.emitWarning(`scheduler restore skipped: ${error.message}`);}
  }
  restoreState();
  // Recover the exact persisted quota journal before accepting any new message.
  recoverSettledRejectedTurns();
  rehydrateInbox();
  function rehydrateInbox(){
    try{
      const queued=new Set();
      for(const scene of scheduler.snapshot().scenes)for(const item of scene.queue??[])queued.add(item.key);
      let afterSeq=0;for(;;){const rows=store.subjectInbox({subjectId,pendingOnly:true,afterSeq,limit:100}).items;if(!rows.length)break;afterSeq=rows.at(-1).seq;
      for(const row of rows){
        const event=store.read(row.eventId);if(!event)continue;
        const key=event.source?.key??event.id;
        if(queued.has(key))continue;
        const at=event.occurredAt??event.recordedAt;
        scheduler.enqueue(global?'global':event.scene,{key,body:event.body,scene:event.scene,actor:event.actor,at,threadId:event.threadId??null});
        queued.add(key);
      }}
    }catch(error){process.emitWarning(`inbox rehydrate skipped: ${error.message}`);}
  }
  // Keep the serial scheduler aligned with the durable inbox. A queue item whose
  // observation is already handled is stale; it must not consume a model turn or
  // block the live messages behind it. This only changes queue bookkeeping.
  function syncSchedulerInbox(){
    const valid=new Set(),queued=new Set();
    for(const scene of scheduler.snapshot().scenes)for(const item of scene.queue??[])queued.add(item.key);
    let added=0;
    try{
      let afterSeq=0;
      for(;;){
        const rows=store.subjectInbox({subjectId,pendingOnly:true,afterSeq,limit:100}).items;
        if(!rows.length)break;
        afterSeq=rows.at(-1).seq;
        for(const row of rows){
          const event=store.read(row.eventId);if(!event)continue;
          const key=event.source?.key??event.id;
          valid.add(key);valid.add(event.id);
          if(queued.has(key)||queued.has(event.id))continue;
          scheduler.enqueue(global?'global':event.scene,{key,body:event.body,scene:event.scene,actor:event.actor,at:event.occurredAt??event.recordedAt,threadId:event.threadId??null});
          queued.add(key);added++;
        }
      }
      const removed=scheduler.prune(valid);
      if(removed||added)saveState();
      return {added,removed,pending:scheduler.pending()};
    }catch(error){
      process.emitWarning(`scheduler inbox sync skipped: ${error.message}`);
      return {added,removed:0,pending:scheduler.pending()};
    }
  }
  syncSchedulerInbox();
  const cursorFile=stateDirectory?join(stateDirectory,'context-cursor.json'):null;
  let cursor={lastEventId:null,lastAt:null,eventsSince:0,lastMemoryAt:clock(),lastIdleAt:clock()};
  if(cursorFile&&existsSync(cursorFile)){
    try{const saved=JSON.parse(readFileSync(cursorFile,'utf8'));if(saved&&Number.isSafeInteger(saved.eventsSince)&&saved.eventsSince>=0)cursor={...cursor,...saved};}catch{}
  }
  function saveCursor(){if(!cursorFile)return;try{writeFileSync(cursorFile,JSON.stringify(cursor),'utf8');}catch{}}
  const memoryDue=()=>cursor.eventsSince>=50||clock()-cursor.lastMemoryAt>=2*60*60*1000;
  const idleDue=()=>clock()-cursor.lastIdleAt>=idleIntervalMs;
  async function idleReflect(){
    if(draining||!global||agentBusy||reflectionBusy||scheduler.active()!==null||scheduler.pending().length)return {skipped:true};
    const memory=memoryDue();
    if(!memory&&!idleDue())return {skipped:true};
    reflectionBusy=true;try{
    const driver=driverFor('global');
    const result=await driver.tick({now:clock(),memoryUpdate:memory,idleReflection:!memory});
    driver.persistState();
    if(result?.wake){
      const outbox=driver.takeOutbox();
      const delivery=outbox.length?await dispatch(outbox,{scene:'global',execute:true}):null;
      cursor={...cursor,eventsSince:memory?0:cursor.eventsSince,...(memory?{lastMemoryAt:clock()}:{}),...(!memory?{lastIdleAt:clock()}:{})};
      saveCursor();
      return {...result,outbox,delivery};
    }
    return result;
    }catch(error){recoverSettledRejectedTurns();throw error;}finally{reflectionBusy=false;}
  }
  async function recoverPendingEffects(){
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null)return {skipped:true};
    const pending=pendingEffects().responses.filter(r=>r.status==='pending');if(!pending.length||!adapter?.send)return {skipped:true};
    reflectionBusy=true;try{return await dispatch(pending,{scene:'global',execute:true});}finally{reflectionBusy=false;}
  }
  async function followupTick(){
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null||scheduler.pending().length)return {skipped:true};
    const frame=store.read(attentionId(subjectId));if(!frame)return {skipped:true};
    const due=(frame.followups??[]).filter(f=>f.status==='scheduled'&&f.dueAt<=clock()).sort((a,b)=>a.dueAt-b.dueAt)[0];
    if(!due)return {skipped:true};
    reflectionBusy=true;try{
    store.execute({requestId:`followup-claim:${due.id}:${frame.revision}`,commands:[{op:'update_followup',subjectId,id:due.id,status:'claimed',expectedRevision:frame.revision}]});
    const driver=driverFor(global?'global':due.targetScene);
    let status='failed',lastResponse=null;
    try{
      const result=await driver.tick({now:clock(),followup:due});
      const outbox=driver.takeOutbox();
      if(result?.wake&&outbox.some(o=>o.kind==='respond')){
        const target=outbox.find(o=>o.kind==='respond')?.scene??due.targetScene;
        const delivery=await dispatch(outbox,{scene:target,execute:true});
        lastResponse=delivery?.find?.(x=>x?.kind==='respond')??delivery?.[0]??null;
        status=lastResponse?.delivered===false?'failed':'sent';
      }else status='deferred';
      driver.persistState();
    }catch(error){recoverSettledRejectedTurns();status=error.code==='OUTPUT_SHAPE'?'unknown':'failed';lastResponse={error:error.code??'FOLLOWUP_ERROR'};}
    const current=store.read(attentionId(subjectId));
    store.execute({requestId:`followup-finish:${due.id}:${current.revision}`,commands:[{op:'update_followup',subjectId,id:due.id,status,expectedRevision:current.revision,lastResponse}]});
    return {ok:true,followup:due.id,status};
    }finally{reflectionBusy=false;}
  }
  let timer=null,scheduleIntervalMs=0,scheduleGeneration=0,closed=false;
  function stopScheduling(){scheduleGeneration++;if(timer)clearInterval(timer);timer=null;scheduleIntervalMs=0;}
  function startScheduling(intervalMs=heartbeatMs){
    ensure(!closed&&Number.isSafeInteger(intervalMs)&&intervalMs>=0&&intervalMs<=3600000,'SCHEDULER_CONFIG','bounded heartbeat required');
    stopScheduling();if(intervalMs===0)return;const generation=scheduleGeneration;scheduleIntervalMs=intervalMs;
    timer=setInterval(()=>{if(scheduler.active()!==null)return;
      syncSchedulerInbox();
      agentTick().catch(()=>{}).finally(()=>{if(generation!==scheduleGeneration)return;
        recoverPendingEffects().then(()=>followupTick()).catch(()=>{}).finally(()=>{if(generation!==scheduleGeneration)return;
          // A durable user observation outranks due reflection. The old order
          // chose idleReflect first, which then skipped forever because the queue
          // was non-empty. Drain the queue through the same turn/budget/mutex path.
          if(scheduler.pending().length)idleTurn().catch(()=>{});
          else if(global&&(memoryDue()||idleDue()))idleReflect().catch(()=>{});
          else idleTurn().catch(()=>{});
        });
      });
    },intervalMs);timer.unref?.();
  }
  async function runCognitionExclusive(callback){
    ensure(typeof callback==='function','COGNITION_CALLBACK','host callback required');
    if(closed||draining||agentBusy||reflectionBusy||scheduler.active()!==null||scheduler.pending().length)return {status:'busy',modelCalled:false};
    reflectionBusy=true;try{return await callback();}finally{reflectionBusy=false;}
  }
  startScheduling();
  function beginShutdown(){draining=true;stopScheduling();}
  function close(){if(closed)return;stopScheduling();saveState();store.close();closed=true;}
  const server=createServer(async (req,res)=>{
    const token=req.headers['x-brain-token'];
    if(service.token&&token!==service.token){res.writeHead(401,{'content-type':'application/json'});return res.end(JSON.stringify({error:'UNAUTHORIZED'}));}
    try{
      if(req.method==='GET'&&req.url==='/health')return json(res,200,health());
      if(req.method==='POST'&&req.url==='/v1/admin/shutdown'){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','local shutdown token required');beginShutdown();
        json(res,202,{ok:true,status:'draining'});setImmediate(()=>shutdownControl.stop().catch(e=>console.error(e.code??'SHUTDOWN_FAILED')));return;
      }
      ensure(!draining,'SERVICE_DRAINING','service is stopping; pending work remains in durable storage');
      if(req.url?.startsWith('/v1/recovery/turn/')){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','operator control required');
        return json(res,200,recoveryTurn(decodeURIComponent(req.url.slice('/v1/recovery/turn/'.length))));
      }
      if(req.method==='POST'&&req.url==='/v1/recovery/close-turn'){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','operator control required');return json(res,200,closeRecoveryTurn(await readBody(req)));
      }
      if(req.method==='GET'&&req.url==='/v1/outbox')return json(res,200,pendingEffects());
      if(req.method==='POST'&&req.url==='/v1/response/claim')return json(res,200,responseClaim(await readBody(req)));
      if(req.method==='POST'&&req.url==='/v1/action/claim')return json(res,200,actionClaim(await readBody(req)));
      if(req.method==='GET'&&req.url==='/v1/tasks')return json(res,200,{format:'agent-tasks-v1',items:listAgent().map(t=>({id:t.id,goal:t.goal,status:t.status,stepCount:t.stepCount,updatedAt:t.updatedAt,blockedReason:t.blockedReason,target:t.target}))});
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/reconcile')){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','operator control token required');
        return json(res,200,reconcileAgentTool(decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/reconcile'.length)),await readBody(req)));
      }
      if(req.method==='POST'&&req.url==='/v1/tasks')return json(res,200,await createAgentTask(await readBody(req)));
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/interrupt')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/interrupt'.length));const b=await readBody(req);return json(res,200,await interruptAgentTask(id,b.message));}
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/step')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/step'.length));return json(res,200,await stepAgentTask(id));}
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/stop')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/stop'.length));const b=await readBody(req);return json(res,200,await stopAgentTask(id,b.reason));}
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/redirect')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/redirect'.length));return json(res,200,await redirectAgentTask(id,await readBody(req)));}
      if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/pause')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/pause'.length));const b=await readBody(req);return json(res,200,await pauseAgentTask(id,b.reason));}
    if(req.method==='POST'&&req.url?.startsWith('/v1/tasks/')&&req.url.endsWith('/resume')){const id=decodeURIComponent(req.url.slice('/v1/tasks/'.length,-'/resume'.length));return json(res,200,await resumeAgentTask(id,await readBody(req)));}
      if(req.method==='POST'&&req.url==='/v1/tasks/stop-all'){const b=await readBody(req);return json(res,200,await stopAllAgentTasks(b.reason));}
      if(req.method==='POST'&&req.url==='/v1/observe')return json(res,200,observe(await readBody(req)));
      if(req.method==='POST'&&req.url==='/v1/turn'){const body=await readBody(req);return json(res,200,await turn({preferred:body.preferred??null,deliver:body.deliver===true}));}
      if(req.method==='POST'&&req.url==='/v1/blob'){const body=await readBody(req);ensure(typeof body?.bytes==='string'&&body.bytes.length<=12*1024*1024,'BLOB','base64 image required');const bytes=Buffer.from(body.bytes,'base64');return json(res,200,putBlob({directory:blobs,bytes,mediaType:body.mediaType??'application/octet-stream'}));}
  if(req.method==='POST'&&req.url==='/v1/reply'){const body=await readBody(req);ensure(body.protocol?body.protocol==='jingyang-brain-bridge-v1':true,'ADAPTER','unsupported protocol');return json(res,200,await reply(body));}
      if(req.method==='POST'&&req.url==='/v1/receipt'){return json(res,200,receipt(await readBody(req)));}
      if(req.method==='POST'&&req.url==='/v1/attention/mute'){const b=await readBody(req);return json(res,200,mute(b.prefix));}
      if(req.method==='POST'&&req.url==='/v1/attention/unmute'){const b=await readBody(req);return json(res,200,unmute(b.prefix,{load:b.load!==false}));}
      if(req.method==='POST'&&req.url==='/v1/attention/load'){const b=await readBody(req);return json(res,200,loadBacklog(b.prefix,b.limit??50));}
      if(req.method==='GET'&&req.url==='/v1/stats')return json(res,200,stats());
      if(req.method==='GET'&&req.url==='/v1/followups'){const f=store.read(attentionId(subjectId));return json(res,200,{format:'followups-v1',items:f?.followups??[]});}
      if(req.method==='POST'&&req.url==='/v1/response/delivered'){const b=await readBody(req);return json(res,200,responseDelivered(b));}
      if(req.method==='GET'&&req.url==='/v1/context')return json(res,200,{format:'context-cursor-v1',cursor});
      if(req.method==='GET'&&req.url==='/v1/style')return json(res,200,styles.status());
      if(req.method==='GET'&&req.url==='/v1/style/text')return json(res,200,{...styles.status(),text:styles.text()});
      if(req.method==='POST'&&req.url==='/v1/style'){const b=await readBody(req);const out=styles.update({text:b.text,label:b.label,source:b.source});for(const d of [globalDriver,...drivers.values()])d?.setStyle(styles.text());return json(res,200,out);}
      if(req.method==='POST'&&req.url==='/v1/style/delete'){const b=await readBody(req);const out=styles.remove(b.id);for(const d of [globalDriver,...drivers.values()])d?.setStyle(styles.text());return json(res,200,out);}
      if(req.method==='POST'&&req.url==='/v1/anchor/query'){const b=await readBody(req);return json(res,200,queryAnchor({store,subjectId,anchor:b.anchor,role:b.role??null,limit:b.limit??12}));}
      if(req.method==='GET'&&req.url==='/v1/attention')return json(res,200,policy.status());
      return json(res,404,{error:'NOT_FOUND'});
    }catch(error){return json(res,400,{error:error.code??'ERROR',message:error.message});}
  });
  async function idleTurn(){
    if(agentBusy||reflectionBusy||scheduler.active()!==null)return {ok:true,busy:true,skipped:true};
    syncSchedulerInbox();
    if(!global)return turn();
    const pending=store.subjectInbox({subjectId,pendingOnly:true,limit:1}).items;
    if(pending.length){
      const head=store.read(pending[0].eventId);
      if(head?.origin!=='tool_receipt')return turn({preferred:null,deliver:true,execute:true});
    }
    reflectionBusy=true;try{
    if(pending.length){
      const driver=driverFor('global'),result=await driver.tick({now:clock()});
      if(!result?.wake)return {ok:true,idle:true,result};
      const outbox=driver.takeOutbox();let targetScene='global';
      if(result.decision)targetScene=decisionReplyScene(result.decision,'global');
      for(const item of outbox)if(!item.scene)item.scene=targetScene;
      const delivery=outbox.length?await dispatch(outbox,{scene:targetScene,execute:true}):null;
      driver.persistState();saveState();
      return {ok:true,idle:true,result,outbox,delivery};
    }
    const driver=driverFor('global'),result=await driver.tick({now:clock()});
    if(!result?.wake)return {ok:true,idle:true,result};
    const outbox=driver.takeOutbox();
    const delivery=outbox.length?await dispatch(outbox,{scene:'global',execute:true}):null;
    driver.persistState();saveState();
    return {ok:true,idle:true,result,outbox,delivery};
    }catch(error){recoverSettledRejectedTurns();throw error;}finally{reflectionBusy=false;}
  }
  const service={server,observe,turn,reply,receipt,responseDelivered,health,stats,close,beginShutdown,startScheduling,stopScheduling,runCognitionExclusive,idleTurn,dispatch,executeAction,mute,unmute,loadBacklog,attention:()=>policy.status(),context:()=>cursor,style:()=>styles.status(),styleUpdate:(v)=>styles.update(v),styleDelete:(id)=>styles.remove(id),tick:()=>turn(),idleReflect,store,responseClaim,actionClaim,pendingEffects,recoverPendingEffects,reconcileAgentTool,recoveryTurn,closeRecoveryTurn,createAgentTask,stepAgentTask,interruptAgentTask,stopAgentTask,pauseAgentTask,redirectAgentTask,resumeAgentTask,stopAllAgentTasks,listAgent,agentTick,subjectContext,token:null};
  return service;
}

function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function readBody(req){return new Promise((resolve,reject)=>{let bytes=0;const parts=[];req.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY)reject(Object.assign(new Error('body too large'),{code:'BODY_LIMIT'}));else parts.push(chunk);});
  req.on('end',()=>{try{const text=Buffer.concat(parts).toString('utf8');resolve(text?JSON.parse(text):{});}catch{reject(Object.assign(new Error('invalid json'),{code:'INVALID_JSON'}));}});req.on('error',reject);});}

export async function startBrainService(options={}){
  const service=createBrainService(options);service.token=options.token??null;
  try{await new Promise((resolve,reject)=>{
    const onError=error=>reject(error);service.server.once('error',onError);
    service.server.listen(options.port??0,'127.0.0.1',()=>{service.server.removeListener('error',onError);resolve();});
  });}catch(error){service.close();throw error;}
  service.port=service.server.address().port;service.url=`http://127.0.0.1:${service.port}`;
  return service;
}

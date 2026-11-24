// 本机脑服务：串行队列 + 一个主体；默认 dry-run，不调模型、不联网。
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure,text,digest} from '../../src/contracts.mjs';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {subjectiveMemoryView,continuityInput} from '../../src/continuity.mjs';
import {TurnDriver} from '../../src/turn-driver.mjs';
import {rhythmConfig} from '../../src/rhythm.mjs';
import {SceneScheduler} from '../../src/scheduler.mjs';
import {keepAttention,attentionId,liveProcesses} from '../../src/attention.mjs';
import * as attentionApi from '../../src/attention.mjs';
// B-owned attention API is landing in Phase 0/1. These tiny adapters keep the server
// loadable while that file is absent and automatically use the real implementation
// once present; they never create a second policy.
const isAttentionCapacityError=code=>typeof attentionApi.isAttentionCapacityError==='function'
 ? attentionApi.isAttentionCapacityError(code)
 : ['FOREGROUND_CAPACITY','ATTENTION_CAPACITY'].includes(code);
const createAttentionCapacityPolicy=({resolver=null}={})=>{
 if(typeof attentionApi.createAttentionCapacityPolicy==='function')return attentionApi.createAttentionCapacityPolicy(resolver===null?{}:{resolver});
 return Object.freeze({format:'jingyang-attention-capacity-policy-v1',resolve:()=> 'reflection',allowsForegroundRecovery:()=>false,isCapacityError:isAttentionCapacityError});
};
const normalizeAttentionCapacityPolicy=value=>{
 if(typeof attentionApi.normalizeAttentionCapacityPolicy==='function')return attentionApi.normalizeAttentionCapacityPolicy(value);
 if(value===undefined||value===null)return createAttentionCapacityPolicy();
 return Object.isFrozen(value)?value:Object.freeze({...value});
};
import {AgentRuntime} from '../../src/agent-runtime.mjs';
import {taskProcessSource} from '../../src/task-threads.mjs';
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
import {sourceReplyRoute,concreteReplyScene} from '../../src/reply-route.mjs';import {recentContext} from '../../src/recent-context.mjs';
import {selectedModelOutput} from '../../src/model-output-recovery.mjs';
import {validateToolArguments} from '../../src/tool-contracts.mjs';
import {authorizeProactiveContact,PROACTIVE_DAILY_SOFT_LIMIT} from '../../src/proactive-contact.mjs';
import {assertProactiveHostSend,PROACTIVE_HOST_TOOL} from '../../src/proactive-contact-host.mjs';
import {selectGatedMaterials} from '../../src/memory-gating.mjs';
import {memoryAudience} from '../../src/memory-access.mjs';

const MAX_BODY=1024*1024;
export const READ_ONLY_HOST_TOOLS=Object.freeze(['qq_list_friends','qq_list_groups','qq_list_stickers','qq_get_group_history','qq_get_friend_history','qq_get_group_members','qq_get_forward_msg','anchor_recall','attention_status','web_search','web_fetch','style_status','office_status','office_list','office_read','office_search','office_audit','github_status','github_repo','github_issues','github_issue','github_pulls','github_branches']);
// Host default for a new AgentTask that did not name its own tools. An explicit
// empty list is a different statement and must stay empty.
const DEFAULT_TASK_TOOLS=Object.freeze(['qq_list_friends','qq_list_groups','qq_list_stickers','anchor_recall','attention_status','web_search']);
const ATTENTION=()=>({...keepAttention()});
// The scheduled tick is a timer boundary: without this its exceptions vanish.
// Record meaningful code/message through the existing diagnostic journal and
// suppress an unchanged repeat for a bounded cooldown instead of logging every tick.
export function createSchedulerFailureReporter({subjectId=null,recordDiagnostic,clock=Date.now,cooldownMs=3_600_000}={}){
 ensure(typeof recordDiagnostic==='function','SCHEDULER_DIAGNOSTIC','diagnostic sink required');
 ensure(Number.isSafeInteger(cooldownMs)&&cooldownMs>=0,'SCHEDULER_DIAGNOSTIC','bounded cooldown required');
 let last=new Map();
 return function report(error){
  const code=typeof error?.code==='string'&&error.code?error.code:'SCHEDULER_ERROR';
  const message=String(error?.message??error??'').slice(0,400);
  const at=clock(),prior=last.get(code);
  if(prior!==undefined&&at-prior<cooldownMs)return {recorded:false,duplicate:true,errorCode:code};
  last.set(code,at);
  if(last.size>16)last.delete(last.keys().next().value);
  let result;try{result=recordDiagnostic({stage:'scheduler.failed',status:'rejected',context:{subjectId},data:{errorCode:code,reason:message}});}catch{return {recorded:false,errorCode:code};}
  return {recorded:result?.logged===true,errorCode:code};
 };
}

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
  if(old)return old;
  return store.execute({requestId:`workspace:${id}`,commands:[{op:'set_workspace',id,expectedRevision:0,scene,focus:{id:'current',label:'当前'},
    workingRefs:[],continuityRefs:[],actionRefs:[]}]}).at(-1);
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

export function createBrainService({storePath=':memory:',subjectId='jingyang',identity='你是一个具有连续记忆的数字主体。',decide=dryDecide,rhythm={},clock=Date.now,capabilities=CAPABILITIES.map(c=>c.id),allowedActionTools=READ_ONLY_HOST_TOOLS,adapter=null,stateDirectory=null,styleDirectory=null,heartbeatMs=0,global=false,eventBypass=true,agentTools={},agentMaxSteps=24,subjectTask=false,blobDirectory=null,hostAllowedTools=null,rhythmReset=false,sessionFactory=null,theoryStatus=null,idleIntervalMs=2*60*60*1000,autonomy=false,cognition={},runtimeInfo=null,shutdownControl=null,lifePolicy=null,officialSpend=null,intentProtocol=false,timezoneMinutes=480,semanticMemory=null,storage={},inboundScenePolicy=null,attentionPolicy=null}={}){
  ensure(typeof storePath==='string'&&storePath.length>0,'BRAIN_SERVICE','store path required');
  const cognitiveKeys=['algorithmV011','apperceptionV1','subjectiveDomains','subjectiveMemory','subjectiveMemoryV2','taskThreads','anchorDirectory','memoryScopeV1','investigationContinuityV1','experienceLearningV1'];
  ensure(cognition&&Object.getPrototypeOf(cognition)===Object.prototype&&Object.entries(cognition).every(([key,value])=>cognitiveKeys.includes(key)&&typeof value==='boolean'),'COGNITION_CONFIG','explicit known boolean cognition flags required');
  cognition=Object.freeze({...cognition});
  // Quiet hours are a real host boundary for automatic background thought, not only
  // a rhythm interval hint: by default she is not woken at night for reflection or
  // autonomy. Explicit observations are still processed by the normal queue.
  const quietHours=rhythmConfig(rhythm);
  const inQuietHours=(now=clock())=>{
    const hour=new Date(now+timezoneMinutes*60_000).getUTCHours();
    return quietHours.quietFrom<=quietHours.quietTo
      ? hour>=quietHours.quietFrom&&hour<quietHours.quietTo
      : hour>=quietHours.quietFrom||hour<quietHours.quietTo;
  };
  const blobs=blobDirectory??join(stateDirectory??'.','blobs');
  const store=new ContinuityStore(storePath,storage);
  const reportSchedulerFailure=createSchedulerFailureReporter({subjectId,recordDiagnostic:value=>store.recordDiagnostic(value),clock});
  new ContinuitySession({store,subjectId,attention:true,maxForeground:16});
  if(intentProtocol)semanticMemory?.warm({store,subjectId});
  // Service-level attention capacity policy: one frozen object, created once, shared
  // by every production TurnDriver (global/scene/autonomy). No per-entry flags.
  const attentionCapacityPolicy=normalizeAttentionCapacityPolicy(attentionPolicy??createAttentionCapacityPolicy());
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
        {op:'admit_subject_event',subjectId,event,disposition:'handled'}
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
    if(['done','failed','cancelled'].includes(task.status))return task;task.revision=current.revision;task.interrupts=current.interrupts;task.status='blocked';
    // Phase 3.2 R2: a blocked task-source request is distinguishable from a model
    // output error so the operator surface can offer recover-capture/close only.
    const sourceBlockCodes=new Set(['SOURCE_REQUEST_BLOCKED','SOURCE_OUTPUT_REJECTED','AFFECT_CAPTURE_UNAVAILABLE']);
    if(error?.code==='RESIDENCE_UPSERT_CAPACITY'){
      // Per-commit output-shape limit, not a resumable capacity gate. The task must
      // stay typed blocked and may only move on new input/operator evidence.
      commitLimitMarker('task',task.id,error.code);
      task.blockedReason=String(`TASK_COMMIT_LIMIT:${error.code}`).slice(0,2000);
    }else if(isAttentionCapacityError(error?.code)){
      let rowId='unregistered';
      try{rowId=decide?.requestJournal?.sourceRequest({subject:subjectId,kind:'task',taskId:task.id,step:task.stepCount})?.id??'unregistered';}catch{}
      task.blockedReason=String(`TASK_CAPACITY_DEFERRED:${rowId}:${error.code}`).slice(0,2000);
    }else if(sourceBlockCodes.has(error?.code)){
      let rowId='unregistered';
      try{rowId=decide?.requestJournal?.sourceRequest({subject:subjectId,kind:'task',taskId:task.id,step:task.stepCount})?.id??'unregistered';}catch{}
      task.blockedReason=String(`TASK_MODEL_SOURCE_BLOCKED:${rowId}`).slice(0,2000);
    }else task.blockedReason=String(`MODEL_OUTPUT_INVALID:${error?.code??'TASK_STEP_ERROR'}`).slice(0,2000);
    task.updatedAt=clock();saveAgent(task);recordAgentResult(task);return task;}
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
        {op:'admit_subject_event',subjectId,event,...(current.status==='blocked'?{disposition:'handled'}:{})},
        {op:'put_agent_task',task:next,expectedRevision:current.revision}
      ]});return true;
    }catch(error){try{store.recordDiagnostic({stage:'agent.result-pending',status:'failed',context:{subjectId,taskId:current.id},data:{errorCode:error.code??'RESULT_PERSIST_FAILED'}});}catch{}return false;}
  }
  const conversationMaterials=args=>{
    const base=cognition.investigationContinuityV1?(focusedProcessMaterials(args)??[]):[];
    if(intentProtocol)return base;
    const event=store.read(args.event.id,args.event.revision);
    if(!event)return base;
    const allowed=memoryAudience({...args,event});
    const gated=selectGatedMaterials({...args,event,accept:allowed});
    const seen=new Set(base.map(material=>material.ref.id));
    return [...base,...gated.filter(material=>!seen.has(material.ref.id))];
  };
  const driverFor=scene=>{
    if(global){
      if(globalDriver)return globalDriver;
      const workspace=ensureWorkspace(store,'global');
      globalDriver=new TurnDriver({...cognition,intentProtocol,timezoneMinutes,semanticMemory,sessionFactory,store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,materialsFor:conversationMaterials,attentionPolicy:attentionCapacityPolicy});
      globalDriver.loadState();if(rhythmReset){globalDriver.restore({state:{lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null},outbox:[]});globalDriver.persistState();}return globalDriver;
    }
    if(drivers.has(scene))return drivers.get(scene);
    const workspace=ensureWorkspace(store,scene);
    const driver=new TurnDriver({...cognition,intentProtocol,timezoneMinutes,semanticMemory,sessionFactory,store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,materialsFor:conversationMaterials,attentionPolicy:attentionCapacityPolicy});
    driver.loadState();if(rhythmReset){driver.restore({state:{lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null},outbox:[]});driver.persistState();}
    drivers.set(scene,driver);return driver;
  };
  let autonomyDriverCache=null,autonomyBusy=false;
  function autonomyDriver(){
    if(autonomyDriverCache)return autonomyDriverCache;
    const workspace=ensureWorkspace(store,'agent/autonomy');
    autonomyDriverCache=new TurnDriver({...cognition,intentProtocol,timezoneMinutes,sessionFactory,store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass:false,decide,rhythm,capabilities,allowedActionTools,attentionPolicy:attentionCapacityPolicy});
    autonomyDriverCache.loadState();
    return autonomyDriverCache;
  }
  function dueContinuation(now){
    const active=new Set([...store.all('agent_task')].filter(t=>t.intentRef&&['running','waiting'].includes(t.status)).map(t=>t.intentRef.id));
    return [...store.all('intent')].find(i=>i.subject===subjectId&&['open','pursuing'].includes(i.status)&&Number.isSafeInteger(i.dueAt)&&i.dueAt<=now&&!active.has(i.id))??null;
  }
  // One terminal outcome per autonomy action. A preflight rejection proves the
  // transport was never invoked, so it is a known failure; every other outcome
  // keeps the existing unknown isolation and is never retried automatically.
  const autonomyFailureNotices=new Map();
  function settleAutonomyFailure(action,error){
    const current=store.read(action.id);
    if(current?.type!=='action'||current.status!=='proposed')return {settled:false,status:current?.status??null};
    const knownUnexecuted=error?.nativePreflight===true&&error?.transportInvoked===false;
    const status=knownUnexecuted?'failed':'interrupted';
    const eventId='host-action:'+action.id;
    const body=JSON.stringify({error:error?.code??'AUTONOMY_ACTION_ERROR',message:String(error?.message??'').slice(0,600),phase:knownUnexecuted?'preflight':'execution',transportInvoked:knownUnexecuted?false:null,...(knownUnexecuted?{}:{outcome:'unknown',warning:'no automatic retry'})});
    // Receipt and admission move in one transaction, matching a successful task
    // start; a crash cannot leave a terminal action whose failure she cannot see.
    try{store.execute({requestId:`autonomy-action-failure:${current.id}:${status}`,commands:[
      {op:'record_receipt',actionId:current.id,expectedRevision:current.revision,status,eventId,body,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()},
      {op:'admit_subject_event',subjectId,event:{id:eventId,revision:1}}
    ]});return {settled:true,status,eventId};}
    catch(settleError){return {settled:false,status,error:settleError.code??'SETTLE_ERROR'};}
  }
  function noteAutonomyFailure(entry){
    if(autonomyFailureNotices.has(entry.id))return;
    autonomyFailureNotices.set(entry.id,true);
    if(autonomyFailureNotices.size>64)autonomyFailureNotices.delete(autonomyFailureNotices.keys().next().value);
    try{store.recordDiagnostic({stage:'native-action.failed',status:'rejected',context:{subjectId,decisionId:String(entry.id).replace(/:action$/,'')},data:{errorCode:entry.error,reason:`${entry.settlement?.settled===true?'settled':'unsettled'}:${entry.settlement?.status??'unknown'}:${entry.message}`.slice(0,400)}});}catch{}
  }
  // Only the autonomously committed start_agent_task is ever retried. A failed
  // recovery now gets one terminal receipt and leaves the proposed scan for good.
  async function recoverAutonomyActions(){
    const recovered=[];
    for(const action of [...store.all('action')]){
      if(action.status!=='proposed'||action.tool!=='start_agent_task'||!String(action.id).startsWith('decision:autonomy:'))continue;
      try{recovered.push({id:action.id,result:await executeAction({id:action.id})});}
      catch(error){
        const entry={id:action.id,error:error.code??'AUTONOMY_ACTION_ERROR',message:String(error.message??'').slice(0,600),settlement:settleAutonomyFailure(action,error)};
        noteAutonomyFailure(entry);recovered.push(entry);
      }
    }
    return recovered;
  }
  async function autonomyTick({now=clock(),manual=false}={}){
    if(!autonomy)return {skipped:true,reason:'disabled'};
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null||autonomyBusy)return {skipped:true,reason:'busy'};
    if(officialSpend&&!officialSpend.gate().allow)return {skipped:true,reason:'budget'};
    if(scheduler.pending().length)return {skipped:true,reason:'pending'};
    if(!manual&&scheduleIntervalMs>0&&inQuietHours(now))return {skipped:true,reason:'quiet-hours'};
    autonomyBusy=true;
    try{
      await recoverAutonomyActions();
      // One autonomy decision per idle interval; the slot is the whole idempotency key.
      const slot=Math.max(1,Math.floor(now/(idleIntervalMs||3600000)));
      const failureId='extension:'+subjectId+':runtime:autonomy-failure:'+slot;
      const capGate=backgroundCapacityGate('autonomy',slot);
      if(capGate)return capGate;
      const priorActivity=[...store.all('extension_record')].find(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&r.value?.packet?.payload?.internal?.kind==='autonomy'&&r.value.packet.payload.internal.opportunity===slot);
      const priorFailure=priorActivity?.value?.phase==='complete'&&priorActivity.value.failure&&!isAttentionCapacityError(priorActivity.value.failure.code)&&!['uncertain'].includes(priorActivity.value.failure.outcome)&&!['unknown'].includes(priorActivity.value.failure.execution);
      if(priorFailure)return {skipped:true,reason:'terminal-failure',slot};
      const latest=Math.max(0,...[...store.all('decision')].map(d=>String(d.id).startsWith('decision:autonomy:')?Number(String(d.id).slice('decision:autonomy:'.length)):0).filter(Number.isSafeInteger));
      if(latest>=slot)return {skipped:true,reason:'cadence',slot};
      const focus=dueContinuation(now),kind=focus?'continuation':'idle';
      let result;
      try{result=await autonomyDriver().autonomyStep({now,opportunity:slot,kind,focus:focus?{id:focus.id,revision:focus.revision}:null});}
      catch(error){
        // A per-commit output-shape limit is not a preflightable capacity fact: the
        // slot is consumed as a typed failure and the next attempt needs a new explicit
        // opportunity. Mark it preflightable:false and never write capacity-deferred.
        if(error?.code==='RESIDENCE_UPSERT_CAPACITY'){
          commitLimitMarker('autonomy',slot,error.code);
          store.execute({requestId:'autonomy-failure:'+slot,commands:[{op:'put_extension_record',id:failureId,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value:{stage:'autonomy-slot',slot,error:error.code,message:String(error.message??'').slice(0,2000),terminal:true,preflightable:false,commitLimit:true,consumed:true}}]});
          throw error;
        }
        // Capacity is a host resource fact and must not consume the opportunity slot:
        // leave it available for the same cadence after capacity is released, and never
        // write a terminal autonomy-failure marker or pay again this heartbeat.
        if(isAttentionCapacityError(error.code)){
          const marker=capacityDeferredMarker('autonomy',slot,error.code);
          const host=hostCapacity();
          return {skipped:true,reason:'capacity-deferred',capacityDeferred:true,entry:'autonomy',slot,marker,capacity:host.capacity,error:error.code};
        }
        // Transport ambiguity is UNKNOWN, not a terminal slot failure: keep it
        // recoverable and never convert it into a paid retry.
        if(error?.code==='TURN_OUTCOME_UNKNOWN'||String(error?.code??'').startsWith('TRANSPORT_'))throw error;
        // Every captured deterministic failure consumes the slot; otherwise a
        // non-ContractError rejection would be re-paid every heartbeat.
        store.execute({requestId:'autonomy-failure:'+slot,commands:[{op:'put_extension_record',id:failureId,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value:{stage:'autonomy-slot',slot,error:error.code??error.name??'AUTONOMY_FAILURE',message:String(error.message??'').slice(0,2000),terminal:true}}]});
        throw error;
      }
      if(result.actionOut)await dispatch([{kind:'act',tool:result.actionOut.tool,args:result.actionOut.args,action:result.actionOut.action}],{scene:'agent/autonomy',execute:true});
      return {ok:true,slot,kind,decision:result.decision,choice:result.choice,focus:focus?{id:focus.id,revision:focus.revision}:null};
    } finally {autonomyBusy=false;}
  }
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
  function rebaseTaskIntent(task){
    if(!task.intentRef)return true;
    const intent=store.read(task.intentRef.id);
    if(!intent||intent.type!=='intent'||intent.subject!==subjectId||!['open','pursuing'].includes(intent.status))return false;
    if(task.intentRef.revision!==intent.revision)task.intentRef={id:intent.id,revision:intent.revision};
    return true;
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
  async function createAgentTask(input={},options={}){
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    ensure(input.subjectId==null||input.subjectId===subjectId,'SUBJECT_MISMATCH','Task belongs to the current service subject');
    const processId=input.processId??null;
    if(processId!==null){
      const source=taskProcessSource({store,subjectId,processId,originDecisionRef:input.originDecisionRef});
      ensure(source,'UNDELIVERED_PROCESS','Task processId must name a delivered own Process explicitly selected by its source Decision');
    }
    const sourceEvent=input.originEventRef?store.read(input.originEventRef.id,input.originEventRef.revision):null;
    const task=agentRuntime.createTask({goal:input.goal,plan:input.plan??'',target:input.target??null,threadId:input.threadId??sourceEvent?.threadId??null,processId,originEventRef:input.originEventRef??null,originDecisionRef:input.originDecisionRef??null,completionCriteria:input.completionCriteria??null,subjectId,intentRef:input.intentRef??null,budget:input.budget??null,metadata:input.metadata??null,id:input.id??null,context:input.context??subjectContext()});
    const result=saveAgent(task,{before:(input.guardRefs??[]).map(ref=>({op:'assert_current',ref})),after:options.after??[]});
    return options.returnResult?result:task;
  }
  async function interruptAgentTask(id,message){
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    const task=agentRuntime.restore(loadAgent(id));agentRuntime.interrupt(task,message);return {ok:true,id,count:task.interrupts.length};
  }
  async function runAgentStep(id,owner){
    if(officialSpend&&!officialSpend.gate().allow)return {ok:true,budgetPaused:true,id};
    ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null)return {ok:false,error:'AGENT_BUSY',skipped:true};
    agentBusy=true;let task,leaseToken,driver;
    try{
      const claimed=claimAgentLease(id,owner);if(!claimed.ok)return {ok:false,error:claimed.reason,status:claimed.status};
      task=claimed.task;leaseToken=task.lease?.token;
      driver=driverFor(global?'global':task.target??'agent/task');const recovered=driver.recoverTaskDecision(task),
        capturedAttempt=recovered?null:driver.capturedTaskAttempt(task),
        capture=recovered||capturedAttempt?.recoverable?null:driver.capturedTaskPacket(task);
      // Background capacity preflight: do not start a paid task step while the host
      // desk is full. A recoverable capture (0 model calls) is still allowed to finish.
      const commitBlocked=commitLimitBlocked('task',task.id);
      if(commitBlocked){
        try{markTaskCommitLimitBlocked(task,'marker');}catch{}
        return {ok:false,id:task.id,status:'blocked',error:'TASK_COMMIT_LIMIT',commitLimitBlocked:true,preflightable:false,autoRecoverable:false,marker:commitBlocked.id};
      }
      const host=hostCapacity();
      if(host.full===true&&!recovered&&!capturedAttempt?.recoverable&&!capture){
        const blocked=markTaskCapacityDeferred(task,'preflight');
        return {ok:false,id:task.id,status:blocked.status,error:'TASK_CAPACITY_DEFERRED',capacityDeferred:true,entry:'task',marker:capacityDeferredMarker('task',task.id),capacity:host.capacity};
      }
      const gate=recovered||capture||capturedAttempt?.recoverable?agentRuntime.budgetExceeded(task,clock(),{ignoreCalls:true}):budgetGate(task);if(gate)return typeof gate==='string'?{ok:false,status:task.status,error:gate}:gate;
      if(task.status==='waiting'&&!agentRuntime.resume(task,{at:clock()}))return {ok:true,skipped:true,id,status:'waiting'};
      driver=driverFor(global?'global':task.target??'agent/task');
      const decided=recovered??(capture?await driver.recoverTaskCapture(task,capture):null)??(capturedAttempt?.recoverable?await driver.recoverTaskAttempt(task,capturedAttempt):null)??await driver.decideTaskStep(task,{now:clock(),onDecisionReady:()=>assertTaskControl(task),maxModelCalls:agentRuntime.remainingCalls(task),onModelAttempt:()=>{
        assertTaskControl(task);task.callCount=(task.callCount??0)+1;persistTaskProgress(task);
      }});
      // A step may have settled this task in its own commit (Intent paused,
      // cancelled or expired). Never advance a task that is no longer running.
      const afterCommit=loadAgent(task.id);
      if(!['running','waiting'].includes(afterCommit.status))return {ok:true,skipped:true,id:task.id,status:afterCommit.status,decision:decided.decision?{id:decided.decision.id,revision:decided.decision.revision}:null};
      // Refresh only the host-owned fields the step commit may have changed. Keep the
      // in-memory progress (interruptCursor, observations) the driver just prepared.
      task.revision=afterCommit.revision;
      task.intentRef=afterCommit.intentRef??task.intentRef;
      task.controlRevision=Math.max(task.controlRevision??0,afterCommit.controlRevision??0);
      task.lease=afterCommit.lease??task.lease;
      task.interruptCursor=Math.max(task.interruptCursor??0,afterCommit.interruptCursor??0);
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
  async function redirectAgentTask(id,input){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(!['running','blocked','paused'].includes(task.status))return {ok:false,id,status:task.status};if(agentRuntime.pendingToolOperations(task).length)return {ok:false,id,status:task.status,error:'TOOL_OUTCOME_UNKNOWN'};
    if(String(task.blockedReason??'').startsWith('TASK_CAPACITY_DEFERRED:')){const host=hostCapacity();ensure(host.available===true&&host.released===true,'CAPACITY_NOT_RELEASED','host attention capacity is still full; redirect cannot bypass the capacity gate');}
    if(String(task.blockedReason??'').startsWith('TASK_COMMIT_LIMIT:')){
      const marker=commitLimitBlocked('task',task.id);const explicit=(typeof input?.goal==='string'&&input.goal.trim().length>0)||input?.evidence?.operator!=null||input?.evidence?.commitLimitAck===true;
      ensure(explicit,'TASK_COMMIT_LIMIT_REVIEW_REQUIRED','commit-limit task requires new input or explicit operator evidence');
      if(marker)clearCommitLimitMarker('task',task.id,String(input?.evidence?.operator??'operator-control'));
    }
    if(typeof input?.goal==='string'&&input.goal.trim())task.goal=input.goal.trim();if(typeof input?.plan==='string')task.plan=input.plan.slice(0,8000);if(input?.target!==undefined)task.target=input.target;rebaseTaskIntent(task);task.status='running';task.blockedReason=null;task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
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
  async function resumeAgentTask(id,input){ensure(agentRuntime,'AGENT_RUNTIME','agent runtime not configured');const task=agentRuntime.restore(loadAgent(id));if(!['blocked','paused','waiting'].includes(task.status))return {ok:false,id,status:task.status};if(agentRuntime.pendingToolOperations(task).length)return {ok:false,id,status:task.status,error:'TOOL_OUTCOME_UNKNOWN'};if(!taskIntentCurrent(task)&&!rebaseTaskIntent(task))return {ok:false,id,status:task.status,error:'INTENT_TASK_REVIEW_REQUIRED'};
    // A capacity-deferred task may only resume after the host snapshot proves the desk
    // was released; operator evidence alone cannot bypass the host resource gate.
    if(String(task.blockedReason??'').startsWith('TASK_CAPACITY_DEFERRED:')){const host=hostCapacity();ensure(host.available===true&&host.released===true,'CAPACITY_NOT_RELEASED','host attention capacity is still full; no operator bypass is allowed');}
    if(String(task.blockedReason??'').startsWith('TASK_COMMIT_LIMIT:')){
      const marker=commitLimitBlocked('task',task.id);const explicit=(typeof input?.message==='string'&&input.message.trim().length>0)||input?.evidence?.operator!=null||input?.evidence?.commitLimitAck===true;
      ensure(explicit,'TASK_COMMIT_LIMIT_REVIEW_REQUIRED','commit-limit task requires new input or explicit operator evidence');
      if(marker)clearCommitLimitMarker('task',task.id,String(input?.evidence?.operator??'operator-control'));
    }
    // Phase 3.2 R2/R3: a task blocked on an unresolved model source can only move
    // through the operator task-source surface. Do not auto-clear it into running;
    // no second paid retry is implemented here either.
    if(String(task.blockedReason??'').startsWith('TASK_MODEL_SOURCE_BLOCKED:'))ensure(input?.evidence?.operator&&input?.evidence?.approval==='operator-source-recovery','TASK_SOURCE_OPERATOR_REQUIRED','operator evidence required; use /v1/operator/effect type task-source');
    const replayCapture=task.status==='blocked'&&!input?.message&&[...store.all('affect_turn')].some(t=>t.subject===subjectId&&t.status==='captured'&&t.packet.payload.task?.id===task.id&&(t.packet.payload.task.controlRevision??0)===(task.controlRevision??0));if(typeof input?.message==='string'&&input.message.trim())task.interrupts.push({at:clock(),message:input.message.trim()});if(!repairAgentObservation(task))return {ok:false,id,status:'blocked',error:'OBSERVATION_REPAIR_FAILED'};task.status='running';task.blockedReason=null;task.controlRevision=(task.controlRevision??0)+(replayCapture?0:1);task.updatedAt=clock();saveAgent(task,{after:supersedeTaskCaptures(task)});return {ok:true,id,status:task.status};}
  async function agentTick(){
    if(officialSpend&&!officialSpend.gate().allow)return {skipped:true,reason:'official-spend-paused'};
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
        // A capacity-deferred task must not be auto-woken by an inbound interrupt:
        // released capacity plus an explicit resume are both required. Keep the
        // interrupt recorded for the operator and preserve the blocked marker.
        if(String(task.blockedReason??'').startsWith('TASK_CAPACITY_DEFERRED:')||String(task.blockedReason??'').startsWith('TASK_COMMIT_LIMIT:')){task.updatedAt=clock();saveAgent(task);continue;}
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
    if((inboundScenePolicy?.groupIngest==='off'||process.env.JY_GROUP_INGEST==='off')&&String(normalized.scene).startsWith('qq/group/')){
      const event=driver.ingest({key:normalized.key,body:normalized.body,message:normalized.message??null,actor,sender,scene:normalized.scene,at,threadId:normalized.threadId,admit:false});
      // Keep isolated group messages in the objective stream AND in the bounded
      // backlog so she can explicitly peek later without auto-entering cognition.
      policy.add({id:event.id,scene:normalized.scene,at});
      saveState();
      return {queued:false,muted:true,reason:'group-isolated',scene:normalized.scene,pending:scheduler.pending()};
    }
    const ev=driver.ingest({key:normalized.key,body:normalized.body,message:normalized.message??null,actor,sender,scene:normalized.scene,at,threadId:normalized.threadId});associateTaskInterrupt(normalized.scene,ev,normalized.body);
    cursor={...cursor,lastEventId:`obs:${normalized.key}`,lastAt:at,eventsSince:cursor.eventsSince+1};saveCursor();
    scheduler.enqueue(queueKey,{eventId:ev.id,key:normalized.key,body:normalized.body,scene:normalized.scene,actor,at,threadId:normalized.threadId});
    saveState();
    return {queued:true,scene:normalized.scene,pending:scheduler.pending(),eventId:ev.id};
  }
  function mute(prefix){return policy.mute(prefix);}
  function unmute(prefix,{load=false}={}){const next=policy.unmute(prefix);if(load)loadBacklog(prefix,50);return next;}
  const groupPeeked=new Set();
  function loadBacklog(prefix,limit=50){
    const entries=policy.take(prefix,limit);
    for(const entry of entries){
      const event=store.read(entry.id);if(!event)continue;
      store.execute({requestId:`attention:${entry.id}:admit`,commands:[{op:'admit_subject_event',subjectId,event:{id:event.id,revision:event.revision}}]});
      groupPeeked.add(event.id);if(groupPeeked.size>512)groupPeeked.delete(groupPeeked.values().next().value);
      scheduler.enqueue(global?'global':entry.scene,{eventId:event.id,key:event.id,body:event.body,scene:entry.scene,actor:event.actor,at:event.occurredAt??event.recordedAt,threadId:event.threadId??null});
    }
    saveState();
    return {loaded:entries.length,pending:scheduler.pending()};
  }
  async function executeAction(actionRef){
    const action=store.read(actionRef.id);
    ensure(action?.type==='action','ACTION','existing action required');
    if(action.status!=='proposed'){
      // Autonomy actions repair a receipt that was written before admission was atomic.
      if(action.receipt&&String(action.id).startsWith('decision:autonomy:')){
        const event=store.read(action.receipt.id,action.receipt.revision);
        if(event)store.execute({requestId:`autonomy-receipt-admit:${action.id}`,commands:[{op:'admit_subject_event',subjectId,event:action.receipt}]});
      }
      return {replayed:true,action:{id:action.id,revision:action.revision},status:action.status,receipt:action.receipt};
    }
    try{lifePolicy?.assertOperationCurrent(action);validateToolArguments(action.tool,action.args??{});}catch(error){error.nativePreflight=true;throw error;}
    if(action.tool==='start_agent_task'){
      const args=action.args??{};
      const parentDecision=[...store.all('decision')].find(d=>d.action?.id===action.id);const originDecisionRef=parentDecision?{id:parentDecision.id,revision:parentDecision.revision}:null;
      const eventInputs=(action.inputRefs??[]).filter(r=>store.read(r.id,r.revision)?.type==='event');
      const originEventRef=parentDecision?.currentEvent??(!parentDecision&&eventInputs.length===1?eventInputs[0]:null);
      const origin=originEventRef?store.read(originEventRef.id,originEventRef.revision):null;
      const target=args.target??sourceRoute({action:{id:action.id,revision:action.revision}}).scene;
      const threadId=args.threadId??origin?.threadId??null;
      const processId=args.processId??null;
      if(processId!==null)ensure(taskProcessSource({store,subjectId,processId,originDecisionRef}),'UNDELIVERED_PROCESS','Task Process must be explicitly selected from the delivered own directory');
      const plan=Array.isArray(args.plan)?args.plan.join('；'):String(args.plan??'');
      const tools=args.allowedTools===undefined?[...DEFAULT_TASK_TOOLS]:[...new Set(args.allowedTools)];
      const autonomyOrigin=String(action.id).startsWith('decision:autonomy:');
      // The shared autonomy desk can use authorized actions directly. Task
      // grants must also match the QQ adapter's autonomous-task boundary.
      const grantedTools=autonomyOrigin?tools.filter(tool=>!tool.startsWith('qq_')):tools;
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
      if(task)ensure((task.processId??null)===processId,'AGENT_PROCESS_CONFLICT','existing Intent task has a different Process binding; do not infer or overwrite it');
      if(!task)lifePolicy?.beforeTask({action,decision:parentDecision});
      const taskId='task:'+action.id;
      const eventId=`task-receipt:${action.id}`;
      const receipt={op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',eventId,body:`task started: ${taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()};
      // The receipt event and the subject's admission become visible in the same
      // transaction as the task; a crash can no longer leave an unadmitted receipt.
      const admitted={op:'admit_subject_event',subjectId,event:{id:eventId,revision:1}};
      if(!task)return createAgentTask({id:taskId,goal:args.goal,plan,target,threadId,processId,originEventRef,originDecisionRef,subjectId,intentRef,guardRefs:intentRef?[intentRef]:[],metadata:{allowedTools:grantedTools,...(autonomyOrigin?{origin:'autonomy'}:{})}},{after:[receipt,admitted],returnResult:true});
      return store.execute({requestId:`execute:${action.id}`,commands:[receipt,admitted]});
    }
    if(action.tool==='pause_agent_task'){const args=action.args??{};const out=await pauseAgentTask(args.taskId,args.reason);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task pause: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='stop_agent_task'){const args=action.args??{};const out=await stopAgentTask(args.taskId,args.reason);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task stop: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='redirect_agent_task'){const args=action.args??{};const out=await redirectAgentTask(args.taskId,args);const eventId=`task-receipt:${action.id}`;return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:out.ok?'succeeded':'failed',eventId,body:`task redirect: ${args.taskId}`,source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});}
    if(action.tool==='channel_control'){
      const args=action.args??{};ensure(['mute','unmute'].includes(args.op),'CHANNEL_OP','channel op required');const prefix=String(args.prefix??'').trim();ensure(prefix.length>0&&prefix.length<=200,'CHANNEL_PREFIX','channel prefix required');
      if(args.op==='mute')policy.mute(prefix);else policy.unmute(prefix);saveState();
      const eventId=`channel-control:${action.id}`;
      return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:store.read(action.id).revision,status:'succeeded',eventId,body:JSON.stringify({op:args.op,prefix}),source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});
    }
    if(action.tool==='group_peek'){
      const args=action.args??{};const prefix=String(args.prefix??'').trim();ensure(prefix.length>0&&prefix.length<=200,'CHANNEL_PREFIX','channel prefix required');const limit=Number.isSafeInteger(args.limit)?Math.max(1,Math.min(100,args.limit)):50;
      const loaded=loadBacklog(prefix,limit);const eventId=`group-peek:${action.id}`;
      return store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:store.read(action.id).revision,status:'succeeded',eventId,body:JSON.stringify({prefix,loaded:loaded.loaded}),source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]});
    }
    if(action.tool==='remember_note'){
      const args=action.args??{};
      const parent=[...store.all('decision')].find(d=>d.action?.id===action.id&&d.input?.payload?.continuity?.subject?.id===subjectId);
      const evidence=parent?[parent.currentEvent,...parent.output.used.map(x=>x.ref)].filter(ref=>ref&&
        ['event','note'].includes(store.read(ref.id,ref.revision)?.type)):[];
      rememberNote({store,id:`note:${randomUUID()}`,body:args.body,kind:args.kind??'fact_claim',scene:args.scene??null,anchor:args.anchor??null,evidence});
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
    syncSchedulerInbox();
    scheduleFollowupTick();
    return fixed;
  }
  // IR-03/D 主动联系 host 授权（M1/M2 仅私聊 initiation；群主动禁用）。
  // 只读既有持久事实（Decision/Action/Response）重建当日账本；不新增表/字段；
  // 失败一律 typed、transportInvoked=false、在任何 claim/send 之前抛出。
  const PROACTIVE_TIMEZONE_MINUTES=480;
  function proactiveLedgerEntries(now){
    const cutoff=now-72*60*60*1000;
    const decisions=[...store.all('decision')].filter(d=>{
      if(!Number.isSafeInteger(d.recordedAt)||d.recordedAt<cutoff)return false;
      const subject=d.input?.payload?.continuity?.subject?.id;
      return subject===undefined||subject===null||subject===subjectId;
    });
    if(decisions.length>512)throw Object.assign(new Error('bounded proactive decision window exceeded'),{code:'PROACTIVE_LEDGER_BOUND',transportInvoked:false});
    return decisions.sort((a,b)=>a.recordedAt-b.recordedAt).map(d=>{
      const action=d.action?store.read(d.action.id,d.action.revision):null;
      const response=store.read(d.id+':response');
      // A ledger with a dangling Action/Response reference is incomplete. Never
      // silently classify it as uncounted (that would let a proactive attempt
      // escape the daily budget); fail closed before any claim/send.
      if(d.action&&!action)throw Object.assign(new Error('proactive ledger action reference missing'),{code:'PROACTIVE_LEDGER_INCOMPLETE',transportInvoked:false});
      const selected=d.output?.options?.find(o=>o.id===d.output.selected);
      if(selected?.kind==='respond'&&!response)throw Object.assign(new Error('proactive ledger response reference missing'),{code:'PROACTIVE_LEDGER_INCOMPLETE',transportInvoked:false});
      return {decision:d,...(action?{action}:{}),...(response?{response}:{})};
    });
  }
  const PROACTIVE_COOLDOWN_MS=30*60*1000;
  const PROACTIVE_MAX_UNANSWERED=2;
  const PROACTIVE_UNANSWERED_WINDOW_MS=24*60*60*1000;
  const PROACTIVE_ACTIVE_EXEMPT_MS=15*60*1000;
  function authorizeProactiveAction(action,now=clock()){
    const args=action.args??{};
    const targetScene=String(args.targetScene??'');
    if(targetScene.startsWith('qq/group/'))throw Object.assign(new Error('proactive contact to qq/group is disabled; group peek is read-only'),{code:'PROACTIVE_GROUP_DISABLED',transportInvoked:false,nativePreflight:true});
    try{validateToolArguments(PROACTIVE_HOST_TOOL,args);}catch(error){error.transportInvoked=false;error.nativePreflight=true;throw error;}
    const entries=proactiveLedgerEntries(now);
    const host=assertProactiveHostSend({subjectId,entries,action,timezoneMinutes:PROACTIVE_TIMEZONE_MINUTES});
    // 1. Separated recipient quiet hours (23:00-07:00): allow internal thinking/autonomy,
    //    but block outbound proactive messages unless recipient was active in last 15 min.
    const inboundEvents=[...store.all('event')].filter(e=>e.scene===targetScene&&['observed','reported'].includes(e.origin)&&e.actor!=='host'&&e.actor!==subjectId);
    const lastInboundAt=inboundEvents.reduce((max,e)=>Math.max(max,Number(e.occurredAt??e.recordedAt??0)),0);
    if(inQuietHours(now)&&(!lastInboundAt||(now-lastInboundAt)>PROACTIVE_ACTIVE_EXEMPT_MS)){
      throw Object.assign(new Error('收件人处于夜间勿扰时段（23:00–07:00），暂不主动外发；内部思考与记忆整理不受影响'),{code:'POLICY_QUIET_HOURS',transportInvoked:false,nativePreflight:true,quietFrom:quietHours.quietFrom,quietTo:quietHours.quietTo});
    }
    // 2. Cross-entry target cooldown, unanswered backoff cap, and inputRefs dedup.
    const priorProactive=[...store.all('action')]
      .filter(a=>a.id!==action.id&&a.tool===PROACTIVE_HOST_TOOL&&a.args?.targetScene===targetScene&&a.status!=='failed')
      .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0));
    const latestPrior=priorProactive[0]??null;
    if(latestPrior&&Number.isSafeInteger(latestPrior.recordedAt)&&(now-latestPrior.recordedAt)<PROACTIVE_COOLDOWN_MS){
      const retryAfterMs=PROACTIVE_COOLDOWN_MS-(now-latestPrior.recordedAt);
      throw Object.assign(new Error(`同一对象主动联系冷却中，约 ${Math.ceil(retryAfterMs/60000)} 分钟后再试`),{code:'POLICY_COOLDOWN',retryAfterMs,transportInvoked:false,nativePreflight:true});
    }
    const unansweredSince=Math.max(lastInboundAt,now-PROACTIVE_UNANSWERED_WINDOW_MS);
    const unansweredCount=priorProactive.filter(a=>Number.isSafeInteger(a.recordedAt)&&a.recordedAt>unansweredSince).length;
    if(unansweredCount>=PROACTIVE_MAX_UNANSWERED){
      throw Object.assign(new Error(`对方尚未回复前最多主动联系 ${PROACTIVE_MAX_UNANSWERED} 次，已触发未回复退避保护`),{code:'POLICY_UNANSWERED_CAP',unansweredCount,limit:PROACTIVE_MAX_UNANSWERED,transportInvoked:false,nativePreflight:true});
    }
    const basisSig=JSON.stringify((action.inputRefs??[]).map(r=>`${r.id}@${r.revision}`).sort());
    const dupBasis=priorProactive.find(a=>Number.isSafeInteger(a.recordedAt)&&(now-a.recordedAt)<PROACTIVE_UNANSWERED_WINDOW_MS&&JSON.stringify((a.inputRefs??[]).map(r=>`${r.id}@${r.revision}`).sort())===basisSig);
    if(dupBasis){
      throw Object.assign(new Error('24 小时内已基于同一组记忆依据发起过主动联系，跳过重复打扰'),{code:'POLICY_DUPLICATE_BASIS',priorActionId:dupBasis.id,transportInvoked:false,nativePreflight:true});
    }
    const used=host.moduleInput.attempts.length;
    const confirmation=used>=PROACTIVE_DAILY_SOFT_LIMIT
      ?Object.freeze({approved:true,evidence:`host-auto-confirm:v1:${host.dayKey}:${used}`})
      :null;
    return authorizeProactiveContact({...host.moduleInput,confirmation});
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
          try{result=await adapter.send({scene:sendScene,text:current.body,response:claimed.response});outcome=result?.delivered===false?'failed':'sent';}
          catch(error){result={error:error.code??'SEND_ERROR'};outcome=error?.transportInvoked===false?'failed':'unknown';}
          responseDelivered({response:claimed.response,claimId:claimed.claimId,outcome,body:JSON.stringify({...(result??{outcome}),scene:sendScene})});
          item.delivery={status:outcome};sent.push({...result,delivered:outcome==='sent',status:outcome});
        }else sent.push({kind:'respond',text:item.text,delivered:false});
      }else if(item.kind==='act'){
        if(item.action&&['remember-binding','remember_note','channel_control','group_peek','start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task'].includes(item.tool)){
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
          ensure(item.action,'ACTION','durable action identity required');
          const persisted=store.read(item.action.id,item.action.revision)??store.read(item.action.id);
          ensure(persisted?.type==='action','ACTION','persisted action required before external delivery');
          if(persisted.tool===PROACTIVE_HOST_TOOL){
            try{authorizeProactiveAction(persisted);}
            catch(error){
              if(error?.transportInvoked!==false)error.transportInvoked=false;
              const current=store.read(persisted.id);let receiptRecording='not-needed';
              if(current?.status==='proposed'){
                const eventId='host-action:'+current.id;
                try{receipt({scene,action:{id:current.id,revision:current.revision},status:'failed',
                  body:JSON.stringify({error:error.code??'PROACTIVE_AUTH_ERROR',message:String(error.message??'').slice(0,600),transportInvoked:false}),
                  eventId});receiptRecording='failed';}catch(e){receiptRecording='record-failed:'+(e.code??e.name);}
              }
              item.execution={status:current?.status??'failed',error:error.code??'PROACTIVE_AUTH_ERROR',receiptRecording};
              try{store.recordDiagnostic({stage:'proactive-contact.blocked',status:'rejected',context:{subjectId},data:{actionId:persisted.id,errorCode:error.code??'PROACTIVE_AUTH_ERROR',message:String(error.message??'').slice(0,600)}});}catch{}
              sent.push({kind:'act',tool:item.tool,action:item.action,delivered:false,error:{code:error.code??'PROACTIVE_AUTH_ERROR',message:error.message}});
              continue;
            }
          }
          const claim=actionClaim({action:item.action,worker:'brain-host'});let status='interrupted',body;
          try{body=JSON.stringify(await adapter.act({scene,tool:item.tool,args:item.args,action:claim.action}));status='succeeded';}catch(error){if(error.transportInvoked===false){status='failed';body=JSON.stringify({error:error.code,message:error.message,transportInvoked:false});}else body=error.message;}
          receipt({scene,action:claim.action,claimId:claim.claimId,status,body:body??'',eventId:'host-action:'+item.action.id});item.execution={status};sent.push({kind:'act',status});
        }
        else {
          if(execute&&item.action){
            const current=store.read(item.action.id);
            if(current?.status==='proposed'){
              try{receipt({scene,action:{id:current.id,revision:current.revision},status:'failed',body:JSON.stringify({error:'ENV_TOOL_UNAVAILABLE',message:'外部通道未连接或当前环境未提供该工具，未发起发送',transportInvoked:false}),eventId:'host-action:'+current.id});}catch{}
            }
          }
          sent.push({kind:'act',tool:item.tool,delivered:false,error:{code:'ENV_TOOL_UNAVAILABLE',message:'外部通道未连接或当前环境未提供该工具'}});
        }
      }
    }
    return sent;
  }
  function recoverSettledRejectedTurns(){
    const closed=[];if(!runtimeInfo?.ledgerPath)return closed;
    try{const bytes=readFileSync(runtimeInfo.ledgerPath),ledger=JSON.parse(bytes);
      for(const t of store.all('affect_turn'))if(t.subject===subjectId&&['failed','uncertain'].includes(t.status)&&!isAttentionCapacityError(t.error)){
        const row=ledger.requests?.find(r=>r.id==='turn:'+t.packet.packetId);
        // Quota refusal is terminal for this source, not an interrupted provider
        // request. Require both durable no-transport proof and no budget row;
        // genuine UNKNOWN reservations must remain blocked and fully retained.
        const unsentQuota=t.status==='failed'&&['DAILY_BUDGET_LIMIT','NETWORK_PREFLIGHT_FAILED','OFFICIAL_BUDGET_LIMIT','OFFICIAL_USAGE_UNAVAILABLE'].includes(t.error)&&t.transportInvoked===false&&!row;
        if(row?.status==='settled'||unsentQuota){
          closeRecoveryTurn({turnId:t.id,expectedRevision:t.revision,ledgerHash:createHash('sha256').update(bytes).digest('hex')});
          const done=store.read(t.id);if(done.status==='closed-incomplete')closed.push({format:'host-processing-outcome-v1',status:'failed-not-adopted',packetId:t.packet.packetId,sourceEvent:t.packet.payload.current?.id??null,adopted:false,execution:'not-started',accounting:unsentQuota?'not-dispatched':'settled',closure:{id:done.id,revision:done.revision},error:t.error});
        }
      }
    }catch(error){try{store.recordDiagnostic({stage:'recovery.deferred',status:'rejected',data:{error:error.code??'RECOVERY_ERROR'}});}catch{}}
    return closed;
  }
  async function turn({preferred=null,deliver=false,execute=false}={}){
    if(officialSpend&&!officialSpend.gate().allow)return {ok:true,budgetPaused:true,pending:scheduler.pending()};
    if(draining||agentBusy||reflectionBusy)return {ok:true,busy:true,pending:scheduler.pending()};
    syncSchedulerInbox();
    const queueKey=scheduler.next({preferred:global?null:preferred});
    if(queueKey===null)return {ok:true,busy:true,pending:scheduler.pending()};
    scheduler.activate(queueKey);
    try{
      const item=scheduler.shift(queueKey);
      const scene=item?.scene??queueKey;
      const driver=driverFor(global?'global':scene);
      const eventId=item?.eventId??(item?.key?.startsWith('obs:')?item.key:null);
      if(eventId&&process.env.JY_GROUP_INGEST==='off'&&String(scene).startsWith('qq/group/')&&!groupPeeked.has(eventId)){
        const event=store.read(eventId);
        if(event?.type==='event')try{store.execute({requestId:'isolate-group:'+eventId,commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:event.revision},reason:'GROUP_ISOLATED'}]});}catch{}
        return {ok:true,skipped:true,silent:true,reason:'group-isolated',pending:scheduler.pending()};
      }
      if(eventId){
        const inbox=store.subjectObservation(subjectId,eventId);
        const terminal=[...store.all('extension_record')].some(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='operation-feedback'&&r.value?.sourceEvent===eventId)||[...store.all('affect_turn')].some(t=>t.subject===subjectId&&t.status==='failed'&&t.transportInvoked===false&&['PACKET_CHANGED','PACKET_STAGE'].includes(t.error)&&t.packet.payload.current?.id===eventId);
        const subjectDeferred=inbox?.status==='deferred'&&store.read(inbox.decisionId)?.type==='decision';
        if(inbox&&inbox.status!=='received'&&!subjectDeferred||terminal){
          if(inbox&&inbox.status==='received')try{store.execute({requestId:'terminal-skip:'+eventId,commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:eventId,revision:store.read(eventId).revision},reason:'TERMINAL_SKIP'}]});}catch{}
          return {ok:true,skipped:true,silent:true,reason:'terminal-skip',pending:scheduler.pending()};
        }
      }
      // Agent-runtime tool_receipt decisions are a background entry. Never start a
      // paid model call while the host desk is full; record a deferred marker and
      // leave the event for the normal cadence after capacity is released.
      if(eventId){
        const sourceEvent=store.read(eventId);
        if(sourceEvent?.origin==='tool_receipt'&&sourceEvent?.source?.system==='agent-runtime'){
          const capGate=backgroundCapacityGate('agent',eventId);
          if(capGate)return {...capGate,ok:false,id:null,status:null};
        }
      }
      let result;
      try{result=await driver.tick({now:clock()});}
      catch(error){
        const closed=recoverSettledRejectedTurns();let processingOutcome=closed.find(c=>c.sourceEvent===item?.key||c.sourceEvent==='obs:'+item?.key);
        if(!processingOutcome&&[item?.key,'obs:'+item?.key].includes(error.processingOutcome?.sourceEvent))processingOutcome=error.processingOutcome;
        // A failed input has no packet/provider call. Quarantine only an exact
        // fresh source with no prior adopted decision and no in-flight journal.
        if(!processingOutcome&&(['INPUT_OVERFLOW','WORKBENCH_REQUIRED_OVERFLOW'].includes(error.code)||error.transportInvoked===false&&['PACKET_CHANGED','PACKET_STAGE'].includes(error.code))){
          const id=item?.eventId??(item?.key?.startsWith('obs:')?item.key:'obs:'+item?.key),event=store.read(id);
          const adopted=[...store.all('decision')].some(d=>d.input?.payload?.continuity?.subject?.id===subjectId&&d.currentEvent?.id===id);
          const pending=[...store.all('extension_record')].some(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&!['complete','ready'].includes(r.value.phase));
          if(event?.type==='event'&&!adopted&&!pending){
            const fid='extension:'+subjectId+':runtime:input-failure:'+digest({id,error:error.code}),value={stage:'input',sourceEvent:id,eventId:id,error:error.code,message:error.message,details:error.details??{},adopted:false,execution:'not-started',accounting:'not-dispatched'};
            let record=store.read(fid);if(!record)record=store.execute({requestId:fid,commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:event.revision},reason:error.code},{op:'put_extension_record',id:fid,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value}]}).at(-1);
            processingOutcome={format:'host-processing-outcome-v1',status:'failed-not-adopted',sourceEvent:id,packetId:'input:'+id,packetPrepared:false,adopted:false,execution:'not-started',accounting:'not-dispatched',closure:{id:record.id,revision:record.revision},error:error.code};
          }
        }
        // A message whose model request outcome is unknown must release the
        // activity slot. The ledger remains uncertain and is never retried;
        // the source is deferred so the next message can be processed.
        if(!processingOutcome&&['UNCERTAIN_REQUEST','PROVIDER_HTTP','MODEL_INCOMPLETE','TURN_OUTCOME_UNKNOWN'].includes(error.code)){
          const id=item?.key?.startsWith('obs:')?item.key:'obs:'+item?.key,event=store.read(id);
          const adopted=[...store.all('decision')].some(d=>d.input?.payload?.continuity?.subject?.id===subjectId&&d.currentEvent?.id===id);
          const pending=[...store.all('extension_record')].some(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&!['complete','ready'].includes(r.value.phase));
          if(event?.type==='event'&&!adopted&&!pending){
            const fid='extension:'+subjectId+':runtime:unknown-outcome:'+digest({id,error:error.code}),value={stage:'model',sourceEvent:id,eventId:id,error:error.code,message:error.message,details:error.details??{},adopted:false,execution:'unknown',accounting:'uncertain'};
            let record=store.read(fid);if(!record)record=store.execute({requestId:fid,commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:event.revision},reason:error.code},{op:'put_extension_record',id:fid,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value}]}).at(-1);
            processingOutcome={format:'host-processing-outcome-v1',status:'unknown-not-adopted',sourceEvent:id,packetId:'model:'+id,packetPrepared:false,adopted:false,execution:'unknown',accounting:'uncertain',closure:{id:record.id,revision:record.revision},error:error.code};
          }
        }
        // A capacity refusal is a host resource fact, not a semantic rejection. Keep
        // the source deferred and never auto-close/quarantine its affect turn; the
        // existing requeue-event path may re-enter after operator releases capacity.
        // Per-commit output-shape limit: typed failure, no capacity marker, no auto
        // retry. Agent-runtime receipts become agent telemetry; foreground stays typed.
        if(!processingOutcome&&error.code==='RESIDENCE_UPSERT_CAPACITY'){
          const sourceEvent=eventId?store.read(eventId):null,entry=sourceEvent?.source?.system==='agent-runtime'?'agent':'foreground';
          const marker=commitLimitMarker(entry,item?.eventId??item?.key??null,error.code);
          return {ok:false,error:error.code,message:error.message,retryable:false,commitLimit:true,entry,marker,pending:scheduler.pending()};
        }
        if(!processingOutcome&&isAttentionCapacityError(error.code)){
          try{store.recordDiagnostic({stage:'capacity.deferred',status:'deferred',context:{subjectId,eventId:item?.eventId??null},
            data:{errorCode:error.code,capacity:capacitySnapshot(),meaning:'host attention capacity; source retained as deferred, no journal rejection/quarantine'}});}catch{}
          return {ok:false,error:error.code,message:error.message,retryable:false,capacityDeferred:true,deferred:true,pending:scheduler.pending()};
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
  function authorizeInboundScene(body,serviceToken){
    const policy=inboundScenePolicy;
    if(!policy)return;
    ensure(body?.protocol==='jingyang-brain-bridge-v1','INBOUND_PROTOCOL','bridge protocol required');
    if(policy.requireToken&&!serviceToken)ensure(false,'UNAUTHORIZED','brain token required for inbound bridge');
    const scene=String(body?.scene??'');
    const match=/^qq\/(private|group)\/([0-9]+)$/.exec(scene);
    ensure(match,'INBOUND_SCENE_FORMAT','unrecognized inbound qq scene');
    const kind=match[1],id=match[2];
    ensure(String(body?.key??'')===kind+':'+id,'INBOUND_SCENE_KEY','bridge key must match scene');
    if(kind==='private'){
      ensure((policy.ownerQQ&&id===String(policy.ownerQQ))||policy.allowAllPrivate===true,'INBOUND_SCENE_NOT_AUTHORIZED','private scene is not authorized');
    }else{
      ensure((policy.allowedGroups??[]).map(String).includes(id),'INBOUND_SCENE_NOT_AUTHORIZED','group scene is not whitelisted');
    }
  }
  async function reply(input,{includeEvent=false}={}){
    const execute=input.execute!==false;
    const scene=String(input.scene??input.key??'');
    ensure(scene,'ADAPTER','scene required');
    const source=String(input.source??(scene.split('/')[0]||'qq'));
    const messageValue=input.message??null;
    let body=messageValue?projectText(normalizeMessage(messageValue)):firstText(input.messages??[{role:'user',content:input.text??''}]);
    ensure(body,'ADAPTER','reply needs message text');
    const chatKey=keyFor(scene,input.key);
    const sourceKey=`${chatKey}:${input.message_id??`${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const observed=observe({source,key:chatKey,sourceKey,text:body,message:messageValue,scene,sender:input.sender??null,threadId:input.threadId??null,occurredAt:input.occurredAt??input.message_time??null});
    // Silence means this message was only recorded (muted or group-isolated).
    // Never fall through to turn(): a preferred miss could otherwise pick up
    // another scene's queued work.
    if(observed?.queued!==true)return {ok:true,scene,text:'',outbox:[],silent:true,busy:false,deferred:false,queued:false,muted:observed?.muted===true,reason:observed?.reason??null};
    let result;
    for(let attempt=0;attempt<6;attempt++){
      result=await turn({preferred:global?null:scene,deliver:true,execute});
      if(result?.error)break;
      if(!result.busy&&!result.deferred)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(result?.error)return {ok:false,error:result.error,message:result.message,retryable:false,scene,outbox:[],silent:true,busy:false,...(result.processingOutcome?{processingOutcome:result.processingOutcome}: {})};
    const text=result.outbox?.find(o=>o.kind==='respond')?.text??'';
    return {ok:true,scene,text,outbox:result.outbox??[],silent:result.silent??true,busy:result.busy??false,deferred:result.deferred??false,
      ...(includeEvent?{eventId:observed.eventId}:{})};
  }
  function receipt({scene,action,status,body,eventId,claimId=null,actor='host',occurredAt=clock()}){
    ensure(scene&&action,'ADAPTER','receipt needs scene/action');
    const driver=driverFor(global?'global':scene);
    const result=driver.applyReceipt({action,status,body,eventId,claimId,actor,occurredAt});
    syncSchedulerInbox();
    scheduleFollowupTick();
    return result;
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
  function capacitySnapshot(){
    const subject=store.read(subjectId),frame=store.read(attentionId(subjectId));
    ensure(subject&&frame,'ATTENTION_REQUIRED','subject/frame required');
    // Host-only projection: prefer the B-owned policy snapshot; preserve the existing
    // host shape expected by health/requeue. Never expose this through model input.
    let measured=null;
    if(attentionCapacityPolicy&&typeof attentionCapacityPolicy.snapshot==='function')measured=attentionCapacityPolicy.snapshot(frame,subject);
    else if(attentionCapacityPolicy&&typeof attentionCapacityPolicy.measure==='function')measured=attentionCapacityPolicy.measure(frame,subject);
    const activeDeferrals=()=>Array.isArray(frame.deferrals)?frame.deferrals.filter(d=>!['restored','cancelled'].includes(d.status)).length:0;
    if(measured?.slots?.foreground){
      const slots=measured.slots;
      const used={foreground:(subject.foreground??[]).length,residences:slots.foreground.used??measured.used,processes:slots.processes?.used??0,relations:slots.relations?.used??0,questions:slots.questions?.used??0,followups:slots.followups?.used??0,deferrals:slots.deferrals?.used??activeDeferrals()};
      const max={foreground:slots.foreground.max??measured.max,residences:slots.foreground.max??measured.max,processes:slots.processes?.max??128,relations:slots.relations?.max??256,questions:slots.questions?.max??64,followups:slots.followups?.max??32,deferrals:slots.deferrals?.max??32};
      return {used,max,released:Object.keys(used).every(k=>used[k]<max[k]),full:measured.full===true,slots,counts:measured,
        snapshot:digest({used,max,subject:{id:subject.id,revision:subject.revision},frame:{id:frame.id,revision:frame.revision}})};
    }
    const used={foreground:(subject.foreground??[]).length,residences:(frame.residences??[]).length,processes:liveProcesses(frame.processes??[]).length,relations:(frame.relations??[]).length,questions:(frame.questions??[]).length,followups:(frame.followups??[]).length,deferrals:activeDeferrals()};
    const max={foreground:subject.maxForeground,residences:subject.maxForeground,processes:128,relations:256,questions:64,followups:32,deferrals:32};
    return {used,max,released:Object.keys(used).every(k=>used[k]<max[k]),snapshot:digest({used,max,subject:{id:subject.id,revision:subject.revision},frame:{id:frame.id,revision:frame.revision}})};
  }
  // Background entries (autonomy/reflection/task/agent) must not pay a model call when
  // the host attention desk is already full; only foreground may reclaim under policy.
  // Markers reuse the existing operation-feedback extension record, never a new state.
  function hostCapacity(){
    const subject=store.read(subjectId),frame=store.read(attentionId(subjectId));
    if(!subject||!frame)return {available:false,full:false,released:true,capacity:null};
    try{
      // All-dimension gate: attention capacity is not only foreground residences.
      // Reuse capacitySnapshot().released plus every measured slot (graph/questions/
      // followups/deferrals/...), so a full non-foreground slot cannot let a
      // background entry start a paid model call.
      const snapshot=capacitySnapshot();
      const measured=attentionCapacityPolicy&&typeof attentionCapacityPolicy.snapshot==='function'?attentionCapacityPolicy.snapshot(frame,subject):null;
      const dims={};
      for(const [name,value] of Object.entries(snapshot.used??{}))if(Number.isSafeInteger(value)&&Number.isSafeInteger(snapshot.max?.[name]))dims[name]={used:value,max:snapshot.max[name]};
      for(const [name,slot] of Object.entries(measured?.slots??{}))if(slot&&Number.isSafeInteger(slot.used)&&Number.isSafeInteger(slot.max))dims[name]={used:slot.used,max:slot.max};
      // RESIDENCE_UPSERT_CAPACITY is an output-shape/commit limit, not a persistent
      // capacity dimension: it must not gate background entries or produce a
      // capacity-deferred marker. It is handled as a semantic failure by the entry.
      const full=snapshot.released!==true||Object.values(dims).some(slot=>slot.max>0&&slot.used>=slot.max);
      const used=Object.fromEntries(Object.entries(dims).map(([name,slot])=>[name,slot.used]));
      const max=Object.fromEntries(Object.entries(dims).map(([name,slot])=>[name,slot.max]));
      return {available:true,full,released:!full,capacity:{used,max,full,released:!full,slots:measured?.slots??null}};
    }catch{return {available:false,full:false,released:true,capacity:null};}
  }
  function capacityDeferredMarker(entry,key=null,reason='FOREGROUND_CAPACITY'){
    const identity=digest({entry,key:key??null,subject:subjectId});
    const id='extension:'+subjectId+':runtime:capacity-deferred:'+entry+':'+identity;
    try{
      if(!store.read(id))store.execute({requestId:'capacity-deferred-marker:'+entry+':'+identity,commands:[{op:'put_extension_record',id,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value:{stage:'capacity-deferred',entry,key:key??null,reason,recordedAt:clock()}}]});
    }catch{}
    try{store.recordDiagnostic({stage:'capacity.deferred',status:'deferred',context:{subjectId,eventId:String(key??'').startsWith('obs:')?key:null},data:{entry,key:key??null,reason,capacity:hostCapacity().capacity}});}catch{}
    return id;
  }
  function backgroundCapacityGate(entry,key=null){
    const blocked=commitLimitBlocked(entry,key);
    if(blocked)return {skipped:true,reason:'commit-limit-blocked',commitLimitBlocked:true,preflightable:false,autoRecoverable:false,entry,marker:blocked.id};
    const host=hostCapacity();
    if(!host.available||host.full!==true)return null;
    return {skipped:true,reason:'capacity-deferred',capacityDeferred:true,entry,marker:capacityDeferredMarker(entry,key),capacity:host.capacity};
  }
  function markTaskCapacityDeferred(task,key='preflight'){
    const current=loadAgent(task.id);
    if(['done','failed','cancelled'].includes(current.status))return current;
    const next=agentRuntime.restore(current);
    next.status='blocked';
    next.blockedReason=String(`TASK_CAPACITY_DEFERRED:${key}:FOREGROUND_CAPACITY`).slice(0,2000);
    next.updatedAt=clock();
    saveAgent(next);
    try{recordAgentResult(loadAgent(task.id));}catch{}
    return loadAgent(task.id);
  }
  // RESIDENCE_UPSERT_CAPACITY is a per-commit output-shape limit, not a persistent
  // capacity dimension. It consumes the opportunity/typed failure slot and is never a
  // preflightable capacity-deferred gate.
  function commitLimitMarker(entry,key=null,code='RESIDENCE_UPSERT_CAPACITY'){
    const identity=digest({entry,key:key??null,subject:subjectId,code});
    const id='extension:'+subjectId+':runtime:commit-limit:'+entry+':'+identity;
    try{
      if(!store.read(id))store.execute({requestId:'commit-limit-marker:'+entry+':'+identity,commands:[{op:'put_extension_record',id,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value:{stage:'commit-limit-blocked',entry,key:key??null,reason:code,code,preflightable:false,autoRecoverable:false,recordedAt:clock()}}]});
    }catch{}
    try{store.recordDiagnostic({stage:'commit.limit',status:'typed-failure',context:{subjectId},data:{entry,key:key??null,code,preflightable:false,autoRecoverable:false}});}catch{}
    return id;
  }
  function commitLimitBlocked(entry,key=null){
    return [...store.all('extension_record')].find(record=>{
      if(record.owner!==subjectId||record.stateType!=='operation-feedback'||record.value?.stage!=='commit-limit-blocked'||record.value?.entry!==entry)return false;
      // autonomy/reflection/agent have no per-source identity for this typed failure:
      // one marker blocks the next automatic opportunity until an explicit operator
      // clear. task is keyed by its own task id so unrelated tasks are unaffected.
      return (entry==='autonomy'||entry==='reflection'||entry==='agent')||record.value?.key===key;
    })??null;
  }
  function clearCommitLimitMarker(entry,key=null,operator='operator-control'){
    let cleared=0;
    for(const record of [...store.all('extension_record')]){
      if(record.owner!==subjectId||record.stateType!=='operation-feedback'||record.value?.stage!=='commit-limit-blocked'||record.value?.entry!==entry)continue;
      if(!((entry==='autonomy'||entry==='reflection'||entry==='agent')||record.value?.key===key))continue;
      try{store.execute({requestId:'commit-limit-clear:'+record.id+':'+record.revision,commands:[{op:'put_extension_record',id:record.id,owner:subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:record.revision,value:{...record.value,stage:'commit-limit-cleared',clearedAt:clock(),operator:String(operator??'operator-control')}}]});cleared++;}catch{}
    }
    return cleared;
  }
  function markTaskCommitLimitBlocked(task,key='marker'){
    const current=loadAgent(task.id);if(['done','failed','cancelled'].includes(current.status))return current;
    const next=agentRuntime.restore(current);next.status='blocked';next.blockedReason=String(`TASK_COMMIT_LIMIT:RESIDENCE_UPSERT_CAPACITY`).slice(0,2000);next.updatedAt=clock();
    saveAgent(next);try{recordAgentResult(loadAgent(task.id));}catch{}return loadAgent(task.id);
  }
  function commitLimitEffects(){
    const items=[];
    for(const record of store.all('extension_record')){
      if(record.owner!==subjectId||record.stateType!=='operation-feedback'||record.value?.stage!=='commit-limit-blocked')continue;
      items.push({entry:record.value.entry??'background',id:record.id,key:record.value.key??null,reason:record.value.reason??record.value.code??'RESIDENCE_UPSERT_CAPACITY',code:record.value.code??'RESIDENCE_UPSERT_CAPACITY',preflightable:false,autoRecoverable:false,blocked:true,consumed:record.value.consumed!==false,marker:record.id});
    }
    for(const task of listAgent())if(String(task.blockedReason??'').startsWith('TASK_COMMIT_LIMIT:'))items.push({entry:'task',id:task.id,key:null,reason:String(task.blockedReason).slice('TASK_COMMIT_LIMIT:'.length),code:'RESIDENCE_UPSERT_CAPACITY',preflightable:false,autoRecoverable:false,blocked:true,consumed:false});
    return items;
  }
  async function operatorEffect(input={}){
    const type=input.type,id=input.id,transition=input.transition,evidence=input.evidence??{};
    ensure(['response','action','turn-activity','maintenance','journal','task-source','commit-limit'].includes(type),'OPERATOR_TYPE','known operator effect type required');
    ensure(typeof id==='string'&&typeof transition==='string','OPERATOR_INPUT','object id and transition required');
    if(type==='response'){
      const current=store.read(id);ensure(current?.type==='response','OPERATOR_OBJECT','response required');
      if(current.status==='unknown')return {ok:true,type,id,status:'unknown',retained:true,reason:'unknown-not-safe-to-correct'};
      if(!['failed','unknown'].includes(transition))throw Object.assign(Error('only failed/unknown closure is operator-supported'),{code:'OPERATOR_TRANSITION',transportInvoked:false});
      let claimId=current.claimId??null,response={id:current.id,revision:current.revision};
      if(current.status==='pending'){const claimed=responseClaim({response});claimId=claimed.claimId;response=claimed.response;}
      else ensure(current.status==='dispatching'&&claimId,'OPERATOR_TRANSITION','claimed dispatching response required');
      const evId='operator-response:'+id+':'+transition;
      const written=store.execute({requestId:evId,commands:[{op:'record_response_delivery',response,claimId,outcome:transition,eventId:evId,body:JSON.stringify({reason:'OPERATOR_EVIDENCE',operator:String(evidence.operator??'operator-control'),transportInvoked:transition==='failed'?false:null,evidenceHash:digest(evidence)}),source:{system:'host-operator',key:evId},actor:'host-operator',occurredAt:clock(),admit:false}]}).at(-1);
      return {ok:true,type,id,status:written.status,receipt:written.receipts?.at(-1)??null};
    }
    if(type==='action'){
      const current=store.read(id);ensure(current?.type==='action','OPERATOR_OBJECT','action required');
      if(!['failed','interrupted','cancelled'].includes(transition))throw Object.assign(Error('operator cannot declare success without a real receipt'),{code:'OPERATOR_TRANSITION',transportInvoked:false});
      const claimId=current.status==='dispatching'?current.claimId:null;
      ensure(current.status==='proposed'||current.status==='dispatching','OPERATOR_TRANSITION','proposed or claimed dispatching action required');
      const evId='operator-action:'+id+':'+transition;
      const written=store.execute({requestId:evId,commands:[{op:'record_receipt',actionId:current.id,expectedRevision:current.revision,claimId,status:transition,eventId:evId,body:JSON.stringify({reason:'OPERATOR_EVIDENCE',operator:String(evidence.operator??'operator-control'),transportInvoked:false,evidenceHash:digest(evidence)}),source:{system:'host-operator',key:evId},actor:'host-operator',occurredAt:clock()}]}).at(-1);
      return {ok:true,type,id,status:store.read(id).status,receipt:written.receipt??null};
    }
    if(type==='turn-activity'){
      const activity=store.read(id);ensure(activity?.type==='extension_record'&&activity.stateType==='turn-activity','OPERATOR_OBJECT','turn-activity required');
      ensure(['succeeded','failed','not-executed'].includes(transition),'OPERATOR_TRANSITION','known turn outcome required');
      const packetId=activity.value?.packet?.packetId;ensure(packetId,'OPERATOR_OBJECT','activity packet required');
      const eventId='operator-verification:'+packetId,body=JSON.stringify({packetId,outcome:transition,operator:String(evidence.operator??'operator-control'),evidenceHash:digest(evidence)});
      const existing=store.read(eventId);
      const verification=existing??store.execute({requestId:'operator-verification:'+packetId,commands:[{op:'append_event',id:eventId,body,origin:'reported',actor:'host',source:{system:'host-verification',key:packetId},scene:store.read(activity.value.packet.payload.workspace.id)?.scene??'operator',occurredAt:clock()}]}).at(-1);
      const workspace=activity.value.packet.payload.workspace;
      const scene=workspace.scene??store.read(workspace.id)?.scene??'operator';
      const resolved=driverFor(scene).resolveUnknown({activity:{id:activity.id,revision:activity.revision},evidence:{id:verification.id,revision:verification.revision},outcome:transition});
      const after=store.read(activity.id);
      ensure(after?.value?.phase==='complete','OPERATOR_ACTIVITY_CLOSURE','activity must be complete after verification');
      return {ok:true,type,id,status:'complete',resolution:resolved};
    }
    if(type==='maintenance'){
      const job=store.read(id);ensure(job?.type==='maintenance_job','OPERATOR_OBJECT','maintenance job required');
      ensure(['failed','uncertain','stale'].includes(transition),'OPERATOR_TRANSITION','maintenance failure/uncertain/stale required');
      const out=store.execute({requestId:'operator-maintenance:'+id+':'+transition,commands:[{op:'finish_maintenance',job:{id:job.id,revision:job.revision},status:transition,code:String(evidence.code??'OPERATOR_CLOSURE')}]}).at(-1);
      return {ok:true,type,id,status:out.status};
    }
    if(type==='task-source'){
      const task=loadAgent(id),journal=decide?.requestJournal;
      ensure(journal&&typeof journal.taskSource==='function'&&typeof journal.taskSourceEvidence==='function','REQUEST_JOURNAL','task-source journal primitives unavailable');
      const source=journal.taskSource({subject:subjectId,taskId:task.id,step:task.stepCount}),evidenceHash=digest(evidence);
      const reviewRecords=()=>[...store.all('extension_record')].filter(r=>r.stateType==='task-source-review'&&r.value?.taskId===task.id&&r.value?.step===task.stepCount);
      const artifactFor=name=>{
        const id='extension:'+subjectId+':runtime:task-source-review:'+digest({taskId:task.id,step:task.stepCount,transition:name,evidenceHash});
        return {id,value:{format:'jingyang-task-source-review-v1',taskId:task.id,step:task.stepCount,transition:name,source,
          evidence:{operator:String(evidence.operator??'operator-control'),reason:String(evidence.reason??''),hash:evidenceHash},
          task:{id:task.id,revision:task.revision,controlRevision:task.controlRevision??0,stepCount:task.stepCount,status:task.status},recordedAt:clock()}};
      };
      if(transition==='preview'){
        const capture=driverFor(global?'global':task.target??'agent/task').capturedTaskAttempt(task);
        const journalView=journal.inspectTaskSource(source,{packetId:capture.recoverable?capture.packet.packetId:null});
        return {ok:true,type,id,transition,task:{id:task.id,status:task.status,stepCount:task.stepCount,controlRevision:task.controlRevision??0,blockedReason:task.blockedReason??null},source,journal:journalView,
          capture:capture.recoverable?{recoverable:true,decisionId:capture.decisionId,attemptId:capture.attempt.id}:{recoverable:false,reason:capture.reason},
          transitions:['preview','recover-capture','close'],retry:{blocked:true,reason:'task-source retry is not implemented (R3 blocked)'},
          evidenceHash:journal.taskSourceEvidence(source,{packetId:capture.recoverable?capture.packet.packetId:null,reason:'task-source-preview'}).evidenceHash};
      }
      if(transition==='retry')throw Object.assign(Error('task-source retry is blocked (R3 not implemented)'),{code:'OPERATOR_TRANSITION',transportInvoked:false});
      if(transition==='recover-capture'){
        const existingReview=reviewRecords().find(r=>r.value?.transition==='recover-capture'&&['done','failed','cancelled'].includes(task.status));
        if(existingReview)return {ok:true,type,id,transition,status:task.status,replayed:true,artifact:existingReview.id};
        ensure(['blocked','running','waiting','paused'].includes(task.status),'OPERATOR_STATE','capturable task state required');
        const driver=driverFor(global?'global':task.target??'agent/task'),capture=driver.capturedTaskAttempt(task);
        ensure(capture.recoverable,'TASK_CAPTURE_UNAVAILABLE',capture.reason??'no recoverable captured attempt');
        const artifact=artifactFor('recover-capture');
        artifact.value.capture={packetId:capture.packet.packetId,decisionId:capture.decisionId,attemptId:capture.attempt.id};
        artifact.value.journal=journal.inspectTaskSource(source,{packetId:capture.packet.packetId});
        // Stay on the same controlRevision: the captured taskGuard was built for it.
        const next={...task,status:'running',blockedReason:null,updatedAt:clock()};
        const commands=[{op:'put_agent_task',task:next,expectedRevision:task.revision}];
        if(!store.read(artifact.id))commands.push({op:'put_extension_record',id:artifact.id,owner:subjectId,theory:'runtime',stateType:'task-source-review',schemaVersion:'1',expectedRevision:0,value:artifact.value});
        store.execute({requestId:'operator-task-source:'+task.id+':'+artifact.id.slice(-64),commands});
        const stepped=await runAgentStep(task.id,'operator-recover-capture');
        const adopted=store.read(capture.decisionId);
        return {ok:true,type,id,transition,status:loadAgent(task.id)?.status??null,recovered:Boolean(adopted),decision:adopted?{id:adopted.id,revision:adopted.revision}:null,modelCalls:0,artifact:artifact.id,evidenceHash:artifact.value.evidence.hash,result:stepped};
      }
      if(transition==='close'){
        const closeResult=(typeof evidence.reason==='string'&&evidence.reason.trim()?evidence.reason.trim():'operator-close').slice(0,2000);
        const prior=reviewRecords().find(r=>r.value?.transition==='close');
        if(['failed','cancelled'].includes(task.status))return {ok:true,type,id,transition,status:task.status,replayed:true,artifact:prior?.id??null};
        ensure(!['done'].includes(task.status),'OPERATOR_STATE','task already terminal');
        ensure(['blocked','running','waiting','paused'].includes(task.status),'OPERATOR_STATE','open task required for operator close');
        const artifact=artifactFor('close');
        const next={...task,status:'failed',blockedReason:null,result:{outcome:'operator-closed',reason:closeResult},controlRevision:(task.controlRevision??0)+1,lease:null,wakeAt:null,updatedAt:clock()};
        const commands=[{op:'put_agent_task',task:next,expectedRevision:task.revision}];
        if(!store.read(artifact.id))commands.push({op:'put_extension_record',id:artifact.id,owner:subjectId,theory:'runtime',stateType:'task-source-review',schemaVersion:'1',expectedRevision:0,value:artifact.value});
        store.execute({requestId:'operator-task-source-close:'+task.id+':'+artifact.id.slice(-64),commands});
        return {ok:true,type,id,transition,status:'failed',result:next.result,modelCalls:0,artifact:artifact.id,evidenceHash:artifact.value.evidence.hash};
      }
      throw Object.assign(Error('unknown task-source transition'),{code:'OPERATOR_TRANSITION'});
    }
    if(type==='commit-limit'){
      ensure(transition==='clear','OPERATOR_TRANSITION','commit-limit clear transition required');
      ensure(evidence?.operator!=null,'OPERATOR_EVIDENCE','explicit operator evidence required to clear commit-limit');
      const record=store.read(id);
      ensure(record?.type==='extension_record'&&record.owner===subjectId&&record.stateType==='operation-feedback'&&record.value?.stage==='commit-limit-blocked','OPERATOR_OBJECT','blocked commit-limit marker required');
      const cleared=clearCommitLimitMarker(record.value.entry,record.value.key??null,String(evidence.operator));
      return {ok:true,type,id,status:'cleared',cleared};
    }
    const journal=decide?.requestJournal;ensure(journal&&typeof journal.find==='function','REQUEST_JOURNAL','journal unavailable');
    const row=journal.find(id);
    if(transition==='readmit'){
      ensure(row.status==='released'&&row.transportInvoked===false,'OPERATOR_STATE','released unsent event-source request required');
      ensure(evidence.fingerprint===row.fingerprint,'OPERATOR_EVIDENCE','fingerprint must bind the original request');
      ensure(row.source?.kind==='event'&&row.source?.event?.id,'OPERATOR_STATE','event-source request required');
      const eventId=row.source.event.id;
      ensure(evidence.eventId==null||evidence.eventId===eventId,'OPERATOR_EVIDENCE','eventId must equal the original source event');
      const sourceEvent={id:eventId,revision:store.read(eventId)?.revision??row.source.event.revision};
      ensure(store.subjectObservation(subjectId,eventId),'REQUEUE_NOT_ADMITTED','source event must already be admitted');
      const ledgerHash=createHash('sha256').update(readFileSync(runtimeInfo?.ledgerPath??'')).digest('hex');
      ensure(evidence.ledgerHash===ledgerHash,'OPERATOR_EVIDENCE','ledger hash mismatch');
      // Make the source pending first. If the journal readmit fails, the
      // released journal still blocks dispatch, so a retry is safe and no
      // permanently reserved row can be stranded.
      store.execute({requestId:'operator-readmit-source:'+id,commands:[{op:'requeue_subject_event',subjectId,event:sourceEvent,reason:String(evidence.reason??'OPERATOR_READMIT')}]});
      const read=journal.readmit(id,{evidence:{...evidence,requestId:id,transportInvoked:false,eventId},verify:(ev,r)=>ev.requestId===id&&ev.fingerprint===r.fingerprint&&ev.ledgerHash===ledgerHash});
      syncSchedulerInbox();return {ok:true,type,id,status:read.status,readmitted:true,eventId};
    }
    ensure(row.status==='uncertain','OPERATOR_STATE','only a recovered uncertain journal may be reconciled');
    ensure(['not-sent','settled'].includes(transition),'OPERATOR_TRANSITION','known journal outcome required');
    ensure(evidence.fingerprint===row.fingerprint,'OPERATOR_EVIDENCE','fingerprint mismatch');
    const ledgerHash=createHash('sha256').update(readFileSync(runtimeInfo?.ledgerPath??'')).digest('hex');
    ensure(evidence.ledgerHash===ledgerHash,'OPERATOR_EVIDENCE','ledger hash mismatch');
    if(transition==='not-sent')ensure(evidence.transportInvoked===false&&evidence.noProviderCall===true,'OPERATOR_EVIDENCE','explicit no-transport evidence required');
    if(transition==='settled')ensure(Number.isSafeInteger(evidence.usage?.upperMicros)&&evidence.usage.upperMicros>=0,'OPERATOR_EVIDENCE','usage evidence required');
    const verified=journal.reconcile(id,{evidence:{...evidence,requestId:id,outcome:transition},verify:(ev,r)=>ev.requestId===id&&ev.fingerprint===r.fingerprint&&ev.ledgerHash===ledgerHash});
    return {ok:true,type,id,status:verified.status};
  }
  function recoveryTurn(id){
    const turn=store.read(id);ensure(turn?.type==='affect_turn'&&turn.subject===subjectId,'AFFECT_TURN','own model turn required');
    return {id:turn.id,revision:turn.revision,status:turn.status,error:turn.error??null,transportInvoked:turn.transportInvoked??null,packetId:turn.packet.packetId,outputHash:typeof turn.rawOutput==='string'?digest(turn.rawOutput):null};
  }
  function closeRecoveryTurn(input){
    const turn=store.read(input.turnId);recoveryTurn(input.turnId);ensure(turn.revision===input.expectedRevision,'AFFECT_TURN_VERSION','turn changed since review');
    ensure(typeof runtimeInfo?.ledgerPath==='string','AFFECT_RESOLUTION','configured accounting ledger required');
    const bytes=readFileSync(runtimeInfo.ledgerPath);const evidenceHash=createHash('sha256').update(bytes).digest('hex');ensure(evidenceHash===input.ledgerHash,'AFFECT_RESOLUTION','accounting file changed since review');
    const data=JSON.parse(bytes);ensure(['jingyang-daily-brain-budget-v1','jingyang-request-journal-v1'].includes(data.format)&&Array.isArray(data.requests),'AFFECT_RESOLUTION','configured daily ledger format required');if(data.format==='jingyang-daily-brain-budget-v1')validateBudgetRows(data.requests);else ensure(new Set(data.requests.map(r=>r.id)).size===data.requests.length&&data.requests.every(r=>typeof r.id==='string'&&['reserved','dispatched','settled','uncertain','released'].includes(r.status)),'AFFECT_RESOLUTION','invalid request journal');const row=data.requests.find(r=>r.id==='turn:'+turn.packet.packetId);let resolution;
    if(turn.status==='failed'&&turn.transportInvoked===false&&!row)resolution={reason:turn.error,requestId:null,noProviderCall:true};
    else if(row?.status==='settled'&&Number.isSafeInteger(row.actualMicros)&&row.actualMicros>=0){
      const selected=row.proposalRecovery?selectedModelOutput(data.requests,row):null;
      const raw=selected?.output??row.output??row.providerResult?.output;
      if(turn.status==='failed'&&typeof turn.rawOutput==='string'&&raw===turn.rawOutput)resolution={reason:'OUTPUT_REJECTED',outputHash:digest(turn.rawOutput)};
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

  // Read-only diagnostic join over existing records. Capacity refusals keep the
  // input-failure decision_attempt marked deferred; this exposes them without
  // adding a table/status or changing the journal.
  function capacityDeferredEffects(){
    const items=[],host=hostCapacity();
    const seen=new Set(),push=item=>{const key=item.entry+':'+item.id;if(seen.has(key))return;seen.add(key);items.push({...item,releaseReady:host.released===true,capacity:host.capacity});};
    for(const attempt of store.all('decision_attempt')){
      if(attempt.status!=='deferred'||!String(attempt.requestKey??'').startsWith('input-failure:'))continue;
      if(!isAttentionCapacityError(attempt.failure?.reason))continue;
      const event=attempt.input?.currentEvent??null;
      let row=null,inbox=null;
      if(event){
        try{row=decide?.requestJournal?.sourceRequest({subject:subjectId,kind:'event',event:{id:event.id,revision:event.revision}})??null;}catch{}
        try{inbox=store.subjectObservation(subjectId,event.id);}catch{}
      }
      push({entry:'foreground',id:attempt.id,eventId:event?.id??null,reason:attempt.failure.reason,packetId:row?.packetId??null,
        journalStatus:row?.status??null,validation:row?.validation?.status??null,retryAuthorized:Boolean(row?.retryAuthorization),
        inboxStatus:inbox?.status??null,requeueCandidate:Boolean(row?.status==='settled'&&!row?.validation&&inbox&&['received','deferred'].includes(inbox.status))});
    }
    for(const turn of store.all('affect_turn')){
      if(turn.subject!==subjectId||!isAttentionCapacityError(turn.error))continue;
      push({entry:'affect-turn',id:turn.id,eventId:turn.packet?.payload?.current?.id??null,reason:turn.error,packetId:turn.packet?.packetId??null,status:turn.status??null});
    }
    for(const record of store.all('extension_record')){
      if(record.owner!==subjectId||record.stateType!=='operation-feedback'||record.value?.stage!=='capacity-deferred')continue;
      push({entry:record.value.entry??'background',id:record.id,key:record.value.key??null,reason:record.value.reason??'FOREGROUND_CAPACITY',marker:record.id});
    }
    for(const task of listAgent()){
      if(!String(task.blockedReason??'').startsWith('TASK_CAPACITY_DEFERRED:'))continue;
      push({entry:'task',id:task.id,key:null,reason:task.blockedReason,taskStatus:task.status});
    }
    return items;
  }
  function stats(){const counts={};for(const type of ['event','note','entity','binding','personal_state','workspace','action','decision','link'])counts[type]=[...store.all(type)].length;
   const subjects=[...store.all('subject')],frames=[...store.all('attention_frame')],extensions=[...store.all('extension_record')];
   const received=store.subjectInbox({subjectId,pendingOnly:true,excludeDeferred:true,limit:1});
   const deferred=store.subjectInbox({subjectId,pendingOnly:true,limit:1});
   const capacityDeferred=capacityDeferredEffects();const commitLimits=commitLimitEffects();
   const metrics={subjectVersions:subjects.map(x=>({id:x.id,revision:x.revision})),attentionFrameVersions:frames.map(x=>({id:x.id,revision:x.revision})),extensionRecords:extensions.length,
     inbox:{pendingReceived:received.total,deferredAudit:Math.max(0,deferred.total-received.total),capacityDeferred:{count:capacityDeferred.length,items:capacityDeferred}},
     commitLimits:{count:commitLimits.length,items:commitLimits},operations:extensions.filter(x=>x.stateType==='operation-feedback').length};
   return {ok:true,subjectId,counts,metrics,style:styles.status(),attention:policy.status(),context:cursor};}
  function recoveryStatus(){
    const own=[...store.all('affect_turn')].filter(t=>t.subject===subjectId&&!['committed','closed-incomplete','superseded'].includes(t.status));
    const activities=[...store.all('extension_record')].filter(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&r.value.phase!=='complete');
    const effects=pendingEffects();const capacityDeferred=capacityDeferredEffects();const commitLimits=commitLimitEffects();
    return {modelTurns:own.map(t=>({id:t.id,status:t.status,error:t.error??null})).slice(0,32),modelTurnCount:own.length,activities:activities.map(r=>({id:r.id,phase:r.value.phase})).slice(0,32),
      responses:{pending:effects.responses.filter(r=>r.status==='pending').length,unconfirmed:effects.responses.filter(r=>r.status!=='pending').length},actions:{pending:effects.actions.filter(r=>r.status==='proposed').length,unconfirmed:effects.actions.filter(r=>r.status!=='proposed').length},
      capacityDeferred:{count:capacityDeferred.length,items:capacityDeferred.slice(0,32)},
      commitLimits:{count:commitLimits.length,items:commitLimits.slice(0,32)},
      toolsUnconfirmed:listAgent().reduce((n,t)=>n+(agentRuntime?.pendingToolOperations(t).length??0),0)};
  }
  function health(){const theory=typeof theoryStatus==='function'?theoryStatus():null;return {ok:true,draining,recovery:recoveryStatus(),mode:decide===dryDecide?'dry-run':'custom',subjectId,global,cognitionBusy:agentBusy||reflectionBusy||scheduler.active()!==null||(agentRuntime?.pendingExecutions()??0)>0,externalWorkPending:agentRuntime?.pendingExecutions()??0,active:scheduler.active(),pending:scheduler.pending(),scenes:global?1:drivers.size,attention:policy.status(),...(runtimeInfo?{runtime:runtimeInfo}:{}),scheduling:{enabled:timer!==null,intervalMs:scheduleIntervalMs},...(theory?{theory}: {})};}
  function saveState(){if(!stateFile)return;try{writeFileSync(stateFile,JSON.stringify({scheduler:scheduler.snapshot()}),'utf8');}catch{}}
  function withEventIdentity(item){
    if(item?.eventId&&store.read(item.eventId))return item;
    const keys=[item?.eventId,item?.key,...(item?.key&&!String(item.key).startsWith('obs:')?['obs:'+item.key]:[])].filter(Boolean);
    for(const key of keys){const event=store.read(key);if(event?.type==='event')return {...item,eventId:event.id};}
    const event=[...store.all('event')].find(e=>e.source?.key===item?.key);
    return event?{...item,eventId:event.id}:item;
  }
  function restoreState(){
    if(!stateFile||!existsSync(stateFile))return;
    try{
      const saved=JSON.parse(readFileSync(stateFile,'utf8')),snap=saved.scheduler;
      if(!snap||!Array.isArray(snap.scenes))return;
      for(const s of snap.scenes)for(const raw of s.queue??[]){
        const item=withEventIdentity(raw);
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
        scheduler.enqueue(global?'global':event.scene,{eventId:event.id,key,body:event.body,scene:event.scene,actor:event.actor,at,threadId:event.threadId??null});
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
        const rows=store.subjectInbox({subjectId,pendingOnly:true,excludeDeferred:true,afterSeq,limit:100}).items;
        if(!rows.length)break;
        afterSeq=rows.at(-1).seq;
        for(const row of rows){
          const event=store.read(row.eventId);if(!event)continue;
          const key=event.source?.key??event.id;
          valid.add(key);valid.add(event.id);
          if(queued.has(key)||queued.has(event.id))continue;
          scheduler.enqueue(global?'global':event.scene,{eventId:event.id,key,body:event.body,scene:event.scene,actor:event.actor,at:event.occurredAt??event.recordedAt,threadId:event.threadId??null});
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
  async function idleReflect({manual=false}={}){
    if(officialSpend&&!officialSpend.gate().allow)return {skipped:true,reason:'official-spend-paused'};
    if(draining||!global||agentBusy||reflectionBusy||scheduler.active()!==null||scheduler.pending().length)return {skipped:true};
    if(!manual&&scheduleIntervalMs>0&&inQuietHours())return {skipped:true,reason:'quiet-hours'};
    const memory=memoryDue();
    if(lifePolicy&&!lifePolicy.canReflect(clock()))return {skipped:true,reason:'open-life-reflection-cooldown'};
    if(!memory&&!idleDue())return {skipped:true};
    reflectionBusy=true;try{
    const capGate=backgroundCapacityGate('reflection',memory?'memory-update':'idle');
    if(capGate)return capGate;
    const driver=driverFor('global');
    lifePolicy?.recordReflection(clock());
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
    }catch(error){
      recoverSettledRejectedTurns();
      // Per-commit output-shape limit: consume the due window/cursor as a typed failure
      // and do not treat it as a preflightable capacity wait.
      if(error?.code==='RESIDENCE_UPSERT_CAPACITY'){
        commitLimitMarker('reflection',memory?'memory-update':'idle',error.code);
        cursor={...cursor,...(memory?{eventsSince:0,lastMemoryAt:clock()}:{lastIdleAt:clock()})};
        saveCursor();
        throw error;
      }
      // Capacity is a host resource fact: do not consume the due cursor, do not
      // terminalize the opportunity, and do not pay again until the preflight gate
      // observes released capacity on a later cadence.
      if(isAttentionCapacityError(error.code)){
        const marker=capacityDeferredMarker('reflection',memory?'memory-update':'idle',error.code);
        return {skipped:true,reason:'capacity-deferred',capacityDeferred:true,entry:'reflection',marker,capacity:hostCapacity().capacity,error:error.code};
      }
      // A deterministic reflection failure consumes the existing due window.
      // Activity is the evidence; the existing cursor is the due-gate, so no
      // second failure-state system is introduced.
      const activity=[...store.all('extension_record')].find(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='turn-activity'&&r.value?.context?.kind==='reflection');
      const failure=activity?.value?.failure;
      const deterministic=failure&&typeof failure.outcome==='string'&&!['uncertain'].includes(failure.outcome)&&!['unknown'].includes(failure.execution);
      if(deterministic){
        cursor={...cursor,...(memory?{eventsSince:0,lastMemoryAt:clock()}:{lastIdleAt:clock()})};
        saveCursor();
        // Surface the first deterministic failure to the caller, but the due
        // window is consumed so the next heartbeat cannot repackage/pay again.
        throw error;
      }
      throw error;
    }finally{reflectionBusy=false;}
  }
  async function recoverPendingEffects(){
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null)return {skipped:true};
    const pending=pendingEffects().responses.filter(r=>r.status==='pending').filter(r=>{
      const response=r.response?store.read(r.response.id,r.response.revision):null;
      const decision=response?.decision?store.read(response.decision.id,response.decision.revision):null;
      // Autonomy has no external reply opportunity. Historical orphan responses
      // are retained for audit but must never become a QQ send during recovery.
      if(String(decision?.id??'').startsWith('decision:autonomy:')||decision?.input?.payload?.internal?.kind==='autonomy'){
        try{
          const current=store.read(response.id);
          if(current?.status==='pending'){
            const claimed=responseClaim({response:{id:current.id,revision:current.revision}});
            responseDelivered({response:claimed.response,claimId:claimed.claimId,outcome:'failed',eventId:'orphan-response:'+current.id,body:JSON.stringify({reason:'AUTONOMY_RESPONSE_ORPHAN',transportInvoked:false,automaticRetry:false}),source:{system:'host-operator',key:'orphan-response:'+current.id}});
          }
          store.recordDiagnostic({stage:'response.autonomy-orphan',status:'closed',context:{subjectId,decisionId:decision?.id??null},data:{responseId:response?.id??null,reason:'autonomy-response-failed-not-sent'}});
        }catch(error){try{store.recordDiagnostic({stage:'response.autonomy-orphan',status:'failed',context:{subjectId,decisionId:decision?.id??null},data:{responseId:response?.id??null,error:error.code??'CLOSE_FAILED'}});}catch{}}
        return false;
      }
      return true;
    });if(!pending.length||!adapter?.send)return {skipped:true};
    reflectionBusy=true;try{return await dispatch(pending,{scene:'global',execute:true});}finally{reflectionBusy=false;}
  }
  async function followupTick(){
    if(officialSpend&&!officialSpend.gate().allow)return {skipped:true,reason:'official-spend-paused'};
    if(draining||agentBusy||reflectionBusy||scheduler.active()!==null||scheduler.pending().length)return {skipped:true};
    const frame=store.read(attentionId(subjectId));if(!frame)return {skipped:true};
    // A claimed followup has no live in-memory owner after restart. It must be
    // settled as unknown, not silently left claimed or automatically resent.
    const stale=(frame.followups??[]).filter(f=>f.status==='claimed');
    if(stale.length){
      for(const f of stale){
        const current=store.read(attentionId(subjectId));
        store.execute({requestId:`followup-claimed-recovery:${f.id}:${current.revision}`,commands:[{op:'update_followup',subjectId,id:f.id,status:'unknown',expectedRevision:current.revision,lastResponse:{error:'FOLLOWUP_CLAIM_INTERRUPTED',outcome:'unknown',automaticRetry:false}}]});
      }
      return {ok:true,recovered:stale.length,status:'unknown'};
    }
    const due=(frame.followups??[]).filter(f=>f.status==='scheduled'&&f.dueAt<=clock()).sort((a,b)=>a.dueAt-b.dueAt)[0];
    if(!due)return {skipped:true};
    const authorized=(()=>{try{
      const entry=(store.read(attentionId(subjectId))?.followups??[]).find(f=>f.id===due.id);
      if(!entry||entry.status!=='scheduled'||entry.targetScene!==due.targetScene)return false;
      for(const r of entry.basis??[]){const ev=store.read(r.id,r.revision);if(ev?.type==='event'&&['observed','reported'].includes(ev.origin)&&ev.scene===entry.targetScene)return true;}
      return false;
    }catch{return false;}})();
    if(!authorized){
      const current=store.read(attentionId(subjectId));
      store.execute({requestId:`followup-auth-fail:${due.id}:${current.revision}`,commands:[{op:'update_followup',subjectId,id:due.id,status:'failed',expectedRevision:current.revision,lastResponse:{error:'FOLLOWUP_AUTHORIZATION',automaticRetry:false}}]});
      return {ok:true,followup:due.id,status:'failed',reason:'FOLLOWUP_AUTHORIZATION'};
    }
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
  let timer=null,followupTimer=null,scheduleIntervalMs=0,scheduleGeneration=0,closed=false;
  function stopScheduling(){scheduleGeneration++;if(timer)clearInterval(timer);timer=null;if(followupTimer)clearTimeout(followupTimer);followupTimer=null;scheduleIntervalMs=0;}
  async function runScheduledTick(generation=scheduleGeneration){
    if(closed||draining||scheduler.active()!==null)return;
    syncSchedulerInbox();
    try{
      const taskResult=await agentTick();
      await recoverPendingEffects();
      const followed=await followupTick();
      if(generation!==scheduleGeneration)return;
      const worked=!!(taskResult&&!taskResult.skipped&&taskResult.decision||followed?.decision);
      // A durable user observation outranks due reflection. The old order
      // chose idleReflect first, which then skipped forever because the queue
      // was non-empty. Drain the queue through the same turn/budget/mutex path.
      if(scheduler.pending().length)return await idleTurn();
      if(global&&(memoryDue()||idleDue()))return await idleReflect();
      if(autonomy&&!worked){const result=await autonomyTick();if(result&&!result.skipped)return result;}
      return await idleTurn();
    }catch(error){reportSchedulerFailure(error);}
  }
  function scheduleFollowupTick(){
    if(closed||draining||scheduleIntervalMs<=0||followupTimer)return;
    const generation=scheduleGeneration;
    followupTimer=setTimeout(()=>{followupTimer=null;if(generation===scheduleGeneration)runScheduledTick(generation);},25);
    followupTimer.unref?.();
  }
  function startScheduling(intervalMs=heartbeatMs){
    ensure(!closed&&Number.isSafeInteger(intervalMs)&&intervalMs>=0&&intervalMs<=3600000,'SCHEDULER_CONFIG','bounded heartbeat required');
    stopScheduling();if(intervalMs===0)return;const generation=scheduleGeneration;scheduleIntervalMs=intervalMs;
    timer=setInterval(()=>runScheduledTick(generation),intervalMs);timer.unref?.();
  }
  async function runCognitionExclusive(callback){
    if(officialSpend&&!officialSpend.gate().allow)return {status:'busy',reason:'official-spend-paused',modelCalled:false};
    ensure(typeof callback==='function','COGNITION_CALLBACK','host callback required');
    syncSchedulerInbox();
    if(closed||draining||agentBusy||reflectionBusy||autonomyBusy||(agentRuntime?.pendingExecutions()??0)>0
      ||scheduler.active()!==null||scheduler.pending().length)return {status:'busy',modelCalled:false};
    reflectionBusy=true;try{return await callback();}finally{reflectionBusy=false;}
  }
  startScheduling();
  function beginShutdown(){draining=true;stopScheduling();}
  function close(){if(closed)return;stopScheduling();semanticMemory?.stop();saveState();store.close();closed=true;}
  const server=createServer(async (req,res)=>{
    if(req.method==='POST'&&req.url==='/v1/official-usage'&&officialSpend){try{return json(res,200,officialSpend.accept(await readBody(req),req.headers['x-usage-token']));}catch(error){return json(res,400,{error:error.code??'OFFICIAL_USAGE_INVALID'});}}
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
      if(req.method==='POST'&&req.url==='/v1/operator/effect'){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','operator control required');
        return json(res,200,await operatorEffect(await readBody(req)));
      }
      if(req.method==='POST'&&req.url==='/v1/recovery/requeue-event'){
        ensure(shutdownControl&&req.headers['x-jingyang-control']===shutdownControl.token,'UNAUTHORIZED','operator control required');
        const body=await readBody(req);
        ensure(typeof body?.eventId==='string'&&typeof body?.reason==='string','INVALID_INPUT','eventId and reason required');
        const event={id:body.eventId,revision:store.read(body.eventId)?.revision??1};
        const journal=decide?.requestJournal;
        ensure(journal&&typeof journal.sourceRequest==='function','REQUEST_JOURNAL','request journal unavailable');
        const subject=store.read(subjectId),frame=store.read(attentionId(subjectId));
        const capacity=capacitySnapshot();
        ensure(capacity.released,'CAPACITY_NOT_RELEASED','all attention dimensions must be below capacity before requeue; no model call made',{capacity});
        const row=journal.sourceRequest({subject:subjectId,kind:'event',event});
        ensure(row?.id&&row.status==='settled'&&row.validation==null,'REQUEUE_EVIDENCE','settled capacity-deferred request required');
        // IR-01: preflight the inbox before any durable retry authorization.
        // A handled/quarantined source would make requeue_subject_event throw
        // REQUEUE_STATE after authorizeRetry already unblocked the journal.
        const inbox=store.subjectObservation(subjectId,event.id);
        ensure(inbox&&['received','deferred'].includes(inbox.status),'REQUEUE_STATE','only received or deferred source can be requeued',{status:inbox?.status??null});
        // Requeue first; only a successful source transition earns retry
        // authorization. If authorization then fails, restore the inbox to
        // deferred via the existing failure marker so no stale half-open state
        // remains and no dispatch can happen. Each attempt needs a unique store
        // requestId: otherwise a compensation followed by an identical retry is
        // replayed by Store.execute and never actually requeues the source.
        const requeueRequestId='operator-requeue:'+event.id+':'+randomUUID();
        const out=store.execute({requestId:requeueRequestId,commands:[{op:'requeue_subject_event',subjectId,event,reason:body.reason}]});
        let authorized;
        try{
          authorized=journal.authorizeRetry(row.id,{evidence:{requestId:row.id,capacityReleased:true,capacity,operator:'operator-control',eventId:event.id,reason:body.reason}});
        }catch(error){
          try{store.execute({requestId:'operator-requeue-compensate:'+event.id+':'+randomUUID(),commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:store.read(event.id).revision},reason:'REQUEUE_COMPENSATION'}]});}catch(compensationError){error.compensation=compensationError.code??'REQUEUE_COMPENSATION_FAILED';try{store.recordDiagnostic({stage:'operator-requeue.compensation-failed',status:'rejected',context:{subjectId,eventId:event.id,requestId:row.id},data:{error:error.code??'REQUEUE_ERROR',compensation:error.compensation}});}catch{}}
          throw error;
        }
        // Scheduler sync is outside the authorize transaction. If it fails, the
        // durable authorization must be revoked before compensating the source,
        // otherwise the journal says retryable while the source is deferred.
        try{syncSchedulerInbox();}
        catch(error){
          try{journal.revokeRetry(row.id,{expectedEvidenceHash:authorized.evidenceHash,reason:'REQUEUE_SYNC_FAILED'});}catch(revokeError){error.revoked=false;error.revokeError=revokeError.code??'REVOKE_FAILED';}
          try{store.execute({requestId:'operator-requeue-compensate:'+event.id+':'+randomUUID(),commands:[{op:'fail_subject_event',subject:{id:subjectId,revision:store.read(subjectId).revision},event:{id:event.id,revision:store.read(event.id).revision},reason:'REQUEUE_COMPENSATION'}]});}catch(compensationError){error.compensation=compensationError.code??'REQUEUE_COMPENSATION_FAILED';}
          try{store.recordDiagnostic({stage:'operator-requeue.sync-failed',status:'rejected',context:{subjectId,eventId:event.id,requestId:row.id},data:{error:error.code??'REQUEUE_SYNC_ERROR',revoked:error.revoked!==false,compensation:error.compensation??null}});}catch{}
          throw error;
        }
        return json(res,200,{ok:true,event:body.eventId,requestId:row.id,evidenceHash:authorized.evidenceHash,capacity,observation:out.at(-1)});
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
  if(req.method==='POST'&&req.url==='/v1/reply'){const body=await readBody(req);try{authorizeInboundScene(body,service.token);ensure(body.protocol?body.protocol==='jingyang-brain-bridge-v1':true,'INBOUND_PROTOCOL','unsupported protocol');return json(res,200,await reply(body));}catch(error){const status=error.code==='INBOUND_SCENE_NOT_AUTHORIZED'?403:error.code==='UNAUTHORIZED'?401:400;return json(res,status,{error:error.code??'ERROR',message:error.message});}}
      if(req.method==='POST'&&req.url==='/v1/receipt'){return json(res,200,receipt(await readBody(req)));}
      if(req.method==='POST'&&req.url==='/v1/attention/mute'){const b=await readBody(req);return json(res,200,mute(b.prefix));}
      if(req.method==='POST'&&req.url==='/v1/attention/unmute'){const b=await readBody(req);return json(res,200,unmute(b.prefix,{load:b.load===true}));}
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
    if(officialSpend&&!officialSpend.gate().allow)return {ok:true,budgetPaused:true};
    if(agentBusy||reflectionBusy||scheduler.active()!==null)return {ok:true,busy:true,skipped:true};
    syncSchedulerInbox();
    if(!global)return turn();
    const pending=store.subjectInbox({subjectId,pendingOnly:true,limit:1}).items;
    if(pending.length){
      const head=store.read(pending[0].eventId);
      if(head?.origin!=='tool_receipt')return turn({preferred:null,deliver:true,execute:true});
    }
    if(!pending.length&&scheduleIntervalMs>0&&inQuietHours())return {skipped:true,reason:'quiet-hours'};
    reflectionBusy=true;try{
    if(pending.length){
      const head=store.read(pending[0].eventId);
      if(head?.origin!=='tool_receipt')return turn({preferred:null,deliver:true,execute:true});
      // A tool_receipt is background unless it is a normal foreground action receipt.
      const entry=head?.source?.system==='agent-runtime'?'agent':null;
      if(entry){const capGate=backgroundCapacityGate(entry,head.id);if(capGate)return capGate;}
      const driver=driverFor('global'),result=await driver.tick({now:clock()});
      if(!result?.wake)return {ok:true,idle:true,result};
      const outbox=driver.takeOutbox();let targetScene='global';
      if(result.decision)targetScene=decisionReplyScene(result.decision,'global');
      for(const item of outbox)if(!item.scene)item.scene=targetScene;
      const delivery=outbox.length?await dispatch(outbox,{scene:targetScene,execute:true}):null;
      driver.persistState();saveState();
      return {ok:true,idle:true,result,outbox,delivery};
    }
    const capGate=backgroundCapacityGate('reflection','idle-turn');
    if(capGate)return capGate;
    const driver=driverFor('global'),result=await driver.tick({now:clock()});
    if(!result?.wake)return {ok:true,idle:true,result};
    const outbox=driver.takeOutbox();
    const delivery=outbox.length?await dispatch(outbox,{scene:'global',execute:true}):null;
    driver.persistState();saveState();
    return {ok:true,idle:true,result,outbox,delivery};
    }catch(error){recoverSettledRejectedTurns();
      if(isAttentionCapacityError(error.code)){
        const marker=capacityDeferredMarker('reflection','idle-turn',error.code);
        return {skipped:true,reason:'capacity-deferred',capacityDeferred:true,entry:'reflection',marker,capacity:hostCapacity().capacity,error:error.code};
      }
      throw error;
    }finally{reflectionBusy=false;}
  }
  const service={server,observe,turn,reply,receipt,responseDelivered,health,stats,close,beginShutdown,startScheduling,stopScheduling,runCognitionExclusive,idleTurn,dispatch,executeAction,mute,unmute,loadBacklog,attention:()=>policy.status(),context:()=>cursor,style:()=>styles.status(),styleUpdate:(v)=>styles.update(v),styleDelete:(id)=>styles.remove(id),tick:()=>turn(),idleReflect,autonomyDriver,autonomyTick,agentTools,store,responseClaim,actionClaim,pendingEffects,recoverPendingEffects,reconcileAgentTool,recoveryTurn,closeRecoveryTurn,createAgentTask,stepAgentTask,interruptAgentTask,stopAgentTask,pauseAgentTask,redirectAgentTask,resumeAgentTask,stopAllAgentTasks,listAgent,agentTick,subjectContext,semanticMemory,token:null};
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

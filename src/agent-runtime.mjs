import {createHash} from 'node:crypto';
import {ensure} from './contracts.mjs';
// 纯执行器：任务状态、工具、幂等、观察、检查点、预算与恢复。
// 任务步进必须接收主体已提交的 Decision；Runtime 不持有模型、不规划、不选工具。
export const TASK_STATUS=Object.freeze(['running','waiting','paused','blocked','done','failed','cancelled']);
export const TASK_ACTIONS=Object.freeze(['tool','finish','blocked','help','pause','wait','replan','redirect','none']);
// Terminal Task states never execute again and never accept host controls. `blocked` is
// deliberately not terminal: it stays resumable only through an explicit host decision.
export const TASK_TERMINAL=Object.freeze(['done','failed','cancelled']);
// Intent lifecycle as seen from the Task layer. Values mirror the snapshot contract
// (cognition.mjs stageIntentTaskSync / server.mjs taskIntentCurrent) so hosts that
// already own those decisions can share one predicate instead of re-deriving it.
export const INTENT_TASK_RUNNABLE=Object.freeze(['open','pursuing','deferred']);
export const INTENT_TASK_SETTLEMENT=Object.freeze({deferred:'paused',completed:'cancelled',abandoned:'cancelled',expired:'cancelled'});
const TASK_TOOLS_LIMIT=64;

// Task metadata is host data, not model input. Normalizing its tool list here keeps the
// declared allowance single-sourced: the Runtime still executes only tools that exist in
// its own registry, so this can narrow but never widen authority.
function taskMetadata(metadata){
  if(metadata===null||metadata===undefined)return null;
  ensure(metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&Object.getPrototypeOf(metadata)===Object.prototype,'TASK_METADATA','task metadata must be a plain object or null');
  return metadata;
}
function normalizeAllowedTools(value){
  if(value===undefined)return undefined;
  ensure(Array.isArray(value),'TASK_ALLOWED_TOOLS','task.allowedTools must be an array of tool names');
  const names=value.map(item=>typeof item==='string'?item.trim():'');
  ensure(names.every(name=>name.length>0),'TASK_ALLOWED_TOOLS','task.allowedTools must contain nonempty tool names');
  ensure([...new Set(names)].length<=TASK_TOOLS_LIMIT,'TASK_ALLOWED_TOOLS_LIMIT',`task.allowedTools allows up to ${TASK_TOOLS_LIMIT} names`);
  return [...new Set(names)];
}
function normalizeProcessId(value){
  if(value===undefined||value===null)return null;
  ensure(typeof value==='string'&&value.length>0&&[...value].length<=200,'TASK_PROCESS_ID','task.processId must be a stable own Process id');
  return value;
}
function normalizeIntentRef(value){
  if(value===undefined||value===null)return null;
  const id=typeof value==='string'?value:value?.id,revision=typeof value==='string'?1:value?.revision;
  ensure(typeof id==='string'&&id.length>0&&Number.isSafeInteger(revision)&&revision>0,'TASK_INTENT_REF','task.intentRef must pin {id,revision}');
  return {id,revision};
}
function normalizeTaskMetadata(metadata){
  const value=taskMetadata(metadata);if(value===null)return null;
  const next={...value};
  if(Object.hasOwn(value,'allowedTools'))next.allowedTools=normalizeAllowedTools(value.allowedTools);
  return next;
}
// Duplicate-start identity for host-side task creation. Only an explicit Intent binding
// gives a Task a durable logical identity; an unbound Task must never be compared by
// goal text (architecture: no Intent ownership guesses from similar goals).
export function taskStartIdentity({intentRef=null,goal='',processId=null}={}){
  let intent=null;try{intent=normalizeIntentRef(intentRef);}catch{return null;}
  if(!intent)return null;
  const normalizedGoal=String(goal??'').trim();
  if(!normalizedGoal)return null;
  let process=null;try{process=normalizeProcessId(processId);}catch{return null;}
  return canonical({intent,goal:normalizedGoal,processId:process});
}
export function sameTaskStart(a,b){
  const x=taskStartIdentity(a??{}),y=taskStartIdentity(b??{});
  return x!==null&&x===y;
}
// Pure Intent→Task constraint helper. `advance` mirrors taskIntentCurrent; `settle` mirrors
// stageIntentTaskSync. Unknown statuses neither advance nor settle (fail closed, no guess).
export function intentTaskConstraint(status){
  if(INTENT_TASK_RUNNABLE.includes(status))return {advance:true,settle:null};
  if(Object.hasOwn(INTENT_TASK_SETTLEMENT,status??''))return {advance:false,settle:INTENT_TASK_SETTLEMENT[status]};
  return {advance:false,settle:null};
}

const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>{
  const walk=v=>{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(walk).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+walk(v[k])).join(',')+'}';};
  return walk(value??{});
};

const progressKey=(action,o)=>createHash('sha256').update(canonical({tool:action.tool,args:action.args??{},ok:o.ok,result:o.result??null,error:o.error??null})).digest('hex');
const repeats=recent=>recent.length===6&&typeof recent[0].signature==='string'&&recent.every(x=>x.signature===recent[0].signature);
function taskResultText(value){
 let text;if(typeof value==='string')text=value;else {try{text=JSON.stringify(value);}catch{throw Object.assign(Error('task result must be JSON serializable'),{code:'TASK_RESULT_FORMAT'});}}
 if(typeof text!=='string'||text.length>8000)throw Object.assign(Error('task result exceeds complete result contract; original decision retained'),{code:'TASK_RESULT_LIMIT'});
 return text;
}
async function withTimeout(promise,ms,onLate){
 let timer,timedOut=false;const actual=Promise.resolve(promise);
 actual.then(value=>{if(timedOut)return onLate?.(null,value);},error=>{if(timedOut)return onLate?.(error);}).catch(()=>{});
 try{return await Promise.race([actual,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Object.assign(new Error('tool timeout'),{code:'TOOL_TIMEOUT'}));},ms);})]);}finally{clearTimeout(timer);}
}
function normalizeDecision(decision){
  const value=decision?.decision??decision;
  const output=value?.output??value;
  if(output?.kind==='tool'&&['task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect'].includes(output.tool))return controlAction(output.tool,output.args??{});
  if(output?.kind)return output;
  const selected=output?.options?.find(o=>o.id===output.selected);
  if(selected?.payload){
    if(selected.kind==='act')return controlAction(selected.payload.tool,selected.payload.args??{});
    if(selected.kind==='wait')return {kind:'wait',wakeAt:selected.payload.wakeAt};
    if(selected.kind==='respond')return {kind:'continue',responsePending:true};
    if(selected.kind==='continue'||selected.kind==='intent'||selected.kind==='none')return {kind:'continue'};
    if(selected.kind==='pause')return {kind:'pause',reason:selected.payload?.reason??'paused'};
  }
  throw Object.assign(new Error('persisted subject decision has no executable action'),{code:'DECISION_ACTION'});
}
function controlAction(tool,args){
  if(tool==='task_finish')return {kind:'finish',result:args.result??args.summary??''};
  if(tool==='task_blocked'||tool==='task_help')return {kind:tool==='task_help'?'help':'blocked',reason:args.reason??tool};
  if(tool==='task_pause')return {kind:'pause',reason:args.reason??'paused'};
  if(tool==='task_wait')return {kind:'wait',wakeAt:args.wakeAt};
  if(tool==='task_replan')return {kind:'replan',plan:args.plan??''};
  if(tool==='task_redirect')return {kind:'redirect',goal:args.goal??'',plan:args.plan??''};
  return {kind:'tool',tool,args};
}

export class AgentRuntime{
  #tools;#checkpoint;#observationSink;#now;#maxSteps;#maxCalls;#inFlight=0;
  constructor({tools={},checkpoint=null,onObservation=null,now=Date.now,maxSteps=24,maxCalls=64}={}){
    this.#tools=tools;this.#checkpoint=checkpoint;this.#observationSink=onObservation;this.#now=now;this.#maxSteps=maxSteps;this.#maxCalls=maxCalls;
  }
  createTask({goal,plan='',target=null,threadId=null,budget=null,metadata=null,id=null,context=null,originEventRef=null,originDecisionRef=null,completionCriteria=null,processId=null,subjectId=null,intentRef=null}={}){
    if(typeof goal!=='string'||!goal.trim())throw new Error('goal required');
    if(id!==null&&(typeof id!=='string'||!id||[...id].length>200))throw Object.assign(new Error('task id must be a stable id string'),{code:'TASK_ID'});
    const taskId=id??`task:${this.#now()}:${Math.random().toString(36).slice(2,10)}`;
    return {format:'agent-task-v1',id:taskId,goal:goal.trim(),
      plan:String(plan).slice(0,8000),target,threadId:threadId??null,processId:normalizeProcessId(processId),originEventRef,originDecisionRef,
      completionCriteria,subjectId,intentRef:normalizeIntentRef(intentRef),status:'running',stepCount:0,callCount:0,observations:[],observationRefs:[],decisionRefs:[],interrupts:[],interruptCursor:0,
      wakeAt:null,blockedReason:null,result:null,budget,metadata:normalizeTaskMetadata(metadata),context,controlRevision:0,createdAt:this.#now(),updatedAt:this.#now()};
  }
  interrupt(task,message){
    if(!task||typeof message!=='string'||!message.trim())throw new Error('interrupt message required');
    if(TASK_TERMINAL.includes(task.status))return {queued:false,count:task.interrupts?.length??0,reason:'TASK_TERMINAL'};
    task.interrupts.push({at:this.#now(),message:message.trim()});task.updatedAt=this.#now();this.#save(task);
    return {queued:true,count:task.interrupts.length};
  }
  pause(task,reason='paused'){if(!task||task.status!=='running')return false;task.status='paused';task.blockedReason=String(reason).slice(0,2000);task.updatedAt=this.#now();this.#save(task);return true;}
  resume(task,{at=this.#now()}={}){
    if(!task||TASK_TERMINAL.includes(task.status)||task.result!==null)return false;
    if(this.pendingToolOperations(task).length)return false;
    if(task.status==='paused'){task.status='running';task.blockedReason=null;task.updatedAt=at;this.#save(task);return true;}
    if(task.status==='waiting'&&(task.wakeAt===null||task.wakeAt<=at||(task.interrupts?.length??0)>(task.interruptCursor??0))){task.status='running';task.wakeAt=null;task.updatedAt=at;this.#save(task);return true;}
    return false;
  }
  stop(task,reason='stopped'){
    if(!task||TASK_TERMINAL.includes(task.status))return false;
    task.status='cancelled';task.result=String(reason).slice(0,8000);task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=this.#now();this.#save(task);return true;
  }
  redirect(task,{goal,plan,target,metadata}={}){
    if(!task||task.status!=='running')return false;
    if(typeof goal==='string'&&goal.trim())task.goal=goal.trim();
    if(typeof plan==='string')task.plan=plan.slice(0,8000);
    if(target!==undefined)task.target=target;
    if(metadata!==undefined)task.metadata=normalizeTaskMetadata(metadata);
    task.controlRevision=(task.controlRevision??0)+1;task.updatedAt=this.#now();this.#save(task);return true;
  }
  isTerminal(task){return Boolean(task)&&TASK_TERMINAL.includes(task.status);}
  snapshot(task){return clone(task);}
  restore(snapshot){
    const task=clone(snapshot);
    if(!task||task.format!=='agent-task-v1'||!TASK_STATUS.includes(task.status))throw new Error('invalid agent task snapshot');
    task.interrupts=Array.isArray(task.interrupts)?task.interrupts:[];
    task.observations=Array.isArray(task.observations)?task.observations:[];
    task.decisionRefs=Array.isArray(task.decisionRefs)?task.decisionRefs:[];
    task.observationRefs=Array.isArray(task.observationRefs)?task.observationRefs:[];
    task.processId=normalizeProcessId(task.processId??null);
    try{task.intentRef=normalizeIntentRef(task.intentRef??null);}catch{task.intentRef=null;}
    try{task.metadata=normalizeTaskMetadata(task.metadata??null);}catch{/* legacy metadata stays readable; Runtime still narrows to registered tools */}
    return task;
  }
  #save(task){if(this.#checkpoint)this.#checkpoint(this.snapshot(task));}
  // Declared names are host data; the effective list can only narrow to tools this Runtime
  // actually owns, so a task can never widen authority by naming an unregistered tool.
  declaredAllowedToolNames(task){const declared=task?.metadata?.allowedTools;return Array.isArray(declared)?[...declared]:[];}
  allowedToolNames(task){
    const declared=this.declaredAllowedToolNames(task),registry=Object.keys(this.#tools);
    return registry.filter(name=>declared.includes(name));
  }
  #allowedTools(task){return this.allowedToolNames(task);}
  pendingExecutions(){return this.#inFlight;}
  pendingToolOperations(task){return Object.entries(task?.toolOps??{}).filter(([,v])=>['started','uncertain'].includes(v?.status)).map(([key,value])=>({key,status:value.status}));}
  claimLease(task,{owner='worker',ttlMs=30000,at=this.#now()}={}){
    if(!task)return false;
    const lease=task.lease;
    if(lease&&lease.owner!==owner&&lease.expiresAt>at)return false;
    task.lease={owner,token:Math.random().toString(36).slice(2,10),expiresAt:at+ttlMs};
    task.updatedAt=at;this.#save(task);return true;
  }
  releaseLease(task,owner='worker'){if(task?.lease?.owner===owner){delete task.lease;task.updatedAt=this.#now();this.#save(task);return true;}return false;}
  remainingCalls(task){const max=Number.isSafeInteger(task.budget?.maxCalls)?Math.min(this.#maxCalls,task.budget.maxCalls):this.#maxCalls;return Math.max(0,max-(task.callCount??0));}
  budgetExceeded(task,now=this.#now(),{ignoreCalls=false}={}){
    if(!task)return 'TASK';
    const maxSteps=Number.isSafeInteger(task.budget?.maxSteps)?Math.min(this.#maxSteps,task.budget.maxSteps):this.#maxSteps;
    const maxCalls=Number.isSafeInteger(task.budget?.maxCalls)?Math.min(this.#maxCalls,task.budget.maxCalls):this.#maxCalls;
    if(task.stepCount>=maxSteps)return 'MAX_STEPS';
    if(!ignoreCalls&&(task.callCount??0)>=maxCalls)return 'MAX_CALLS';
    if(Number.isSafeInteger(task.budget?.deadline)&&now>task.budget.deadline)return 'DEADLINE';
    return null;
  }
  async executeDecision(task,decision,{afterModelAttempt=false}={}){
    if(!task||task.status!=='running')return {skipped:true,status:task?.status};
    if(this.pendingToolOperations(task).length){task.status='blocked';task.blockedReason='TOOL_OUTCOME_UNKNOWN';task.updatedAt=this.#now();this.#save(task);return {ok:false,status:'blocked',error:'TOOL_OUTCOME_UNKNOWN'};}
    const exceeded=this.budgetExceeded(task,this.#now(),{ignoreCalls:afterModelAttempt});if(exceeded){task.status='failed';task.blockedReason=exceeded;task.updatedAt=this.#now();this.#save(task);return {ok:false,status:'failed',error:exceeded};}
    const action=normalizeDecision(decision);
    const ref=decision?.decisionRef??decision?.ref??decision?.id??null;
    if(ref){action.decisionRef=ref;task.decisionRefs=Array.isArray(task.decisionRefs)?task.decisionRefs:[];task.decisionRefs.push(ref);task.originDecisionRef=task.originDecisionRef??ref;}
    return this.#applyAction(task,action);
  }
  async step(task,decision,options){
    if(!task||task.status!=='running')return {skipped:true,status:task?.status};
    if(decision===undefined||decision===null)return {ok:false,error:'DECISION_REQUIRED',status:task.status};
    return this.executeDecision(task,decision,options);
  }
  async #applyAction(task,action){
    if(action.kind==='tool'){
      if(typeof action.tool!=='string'||!this.#allowedTools(task).includes(action.tool)||!Object.hasOwn(this.#tools,action.tool)){task.observations.push({at:this.#now(),kind:'error',error:'UNKNOWN_TOOL',tool:action.tool});task.updatedAt=this.#now();this.#save(task);return {ok:false,error:'unknown tool'};}
      task.toolOps=task.toolOps??{};
      const decisionIdentity=action.decisionRef&&typeof action.decisionRef==='object'?canonical(action.decisionRef):action.decisionRef??action.id??'no-decision';
      const opKey=`${decisionIdentity}:${action.tool}:${canonical(action.args??{})}`;
      const legacyKey=`[object Object]:${action.tool}:${canonical(action.args??{})}`;
      if(typeof action.decisionRef==='object'&&task.toolOps[legacyKey]&&!task.toolOps[opKey]){
        task.status='blocked';task.blockedReason='LEGACY_TOOL_IDENTITY_AMBIGUOUS';task.updatedAt=this.#now();this.#save(task);
        return {ok:false,status:'blocked',error:'LEGACY_TOOL_IDENTITY_AMBIGUOUS'};
      }
      const prior=task.toolOps[opKey];
      if(prior){
        const observation=prior.status==='succeeded'?{...prior.observation,deduplicated:true}:{at:this.#now(),kind:'tool',tool:action.tool,ok:false,error:'TOOL_UNCERTAIN',message:`prior ${prior.status}`};
        task.observations.push(observation);task.toolHistory=Array.isArray(task.toolHistory)?task.toolHistory:[];task.toolHistory.push({tool:action.tool,at:this.#now(),signature:progressKey(action,observation)});task.toolHistory=task.toolHistory.slice(-12);task.updatedAt=this.#now();this.#save(task);
        const recent=task.toolHistory.slice(-6);if(repeats(recent)){task.status='blocked';task.blockedReason=`NO_PROGRESS: repeated ${action.tool} six times without a distinct input or result`;task.updatedAt=this.#now();this.#save(task);return {ok:false,status:'blocked',error:'NO_PROGRESS',observation};}
        return {ok:observation.ok,action,observation,status:task.status,deduplicated:true};
      }
      const operationId=createHash('sha256').update(opKey).digest('hex');
      task.toolOps[opKey]={status:'started',operationId,at:this.#now()};task.updatedAt=this.#now();this.#save(task);
      this.#inFlight++;let latePending=false;
      try{
      let observation;
      try{const timeout=Number.isSafeInteger(task.budget?.toolTimeoutMs)?task.budget.toolTimeoutMs:30000;const result=await withTimeout(this.#tools[action.tool](action.args??{},task),timeout,async(error,result)=>{
        try{
        const late={at:this.#now(),kind:'tool',tool:action.tool,operationId,late:true,ok:!error,...(error?{error:error.code??'TOOL_ERROR',message:error.message}:{result:result??null})};
        task.toolOps[opKey]={status:error?'failed':'succeeded',operationId,at:this.#now(),observation:late};task.observations.push(late);
        if(this.#observationSink)await this.#observationSink(task,late);else this.#save(task);
        }finally{this.#inFlight--;}
      });observation={at:this.#now(),kind:'tool',tool:action.tool,ok:true,result:result??null};}
      catch(error){latePending=error.code==='TOOL_TIMEOUT';observation={at:this.#now(),kind:'tool',tool:action.tool,ok:false,error:error.code??'TOOL_ERROR',message:error.message};}
      observation.operationId=operationId;
      task.toolOps[opKey]={operationId,status:observation.ok?'succeeded':observation.error==='TOOL_TIMEOUT'?'uncertain':'failed',at:this.#now(),observation};
      if(observation.error==='TOOL_TIMEOUT'){task.status='blocked';task.blockedReason='TOOL_OUTCOME_UNKNOWN';}
      task.observations.push(observation);task.stepCount++;task.toolHistory=Array.isArray(task.toolHistory)?task.toolHistory:[];task.toolHistory.push({tool:action.tool,at:this.#now(),signature:progressKey(action,observation)});task.toolHistory=task.toolHistory.slice(-12);task.updatedAt=this.#now();
      if(this.#observationSink){try{await this.#observationSink(task,observation);}catch(error){task.observations.push({at:this.#now(),kind:'persistence_error',error:error.code??'OBSERVATION_PERSIST_FAILED',message:error.message});task.status='blocked';task.blockedReason='OBSERVATION_PERSIST_FAILED';task.updatedAt=this.#now();this.#save(task);return {ok:false,status:'blocked',error:'OBSERVATION_PERSIST_FAILED',observation};}}
      this.#save(task);
      const recent=task.toolHistory.slice(-6);const sameTool=repeats(recent);
      if(sameTool){task.status='blocked';task.blockedReason=`NO_PROGRESS: repeated ${action.tool} six times without a distinct input or result`;task.updatedAt=this.#now();this.#save(task);return {ok:false,status:'blocked',error:'NO_PROGRESS',observation};}
      return {ok:observation.ok,action,observation,status:task.status};
      }finally{if(!latePending)this.#inFlight--;}
    }
    if(action.kind==='continue'||action.kind==='none'){task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'running',noop:true};}
    if(action.kind==='finish'){const result=taskResultText(action.result??action.summary??'');task.status='done';task.result=result;task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'done'};}
    if(action.kind==='blocked'||action.kind==='help'){task.status='blocked';task.blockedReason=String(action.reason??action.summary??'blocked').slice(0,2000);task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'blocked'};}
    if(action.kind==='pause'){task.status='paused';task.blockedReason=String(action.reason??'paused').slice(0,2000);task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'paused'};}
    if(action.kind==='wait'){task.status='waiting';task.wakeAt=Number.isSafeInteger(action.wakeAt)?action.wakeAt:this.#now()+60000;task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'waiting'};}
    if(action.kind==='replan'){task.plan=String(action.plan??'').slice(0,8000);task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'running',replanned:true};}
    if(action.kind==='redirect'){if(typeof action.goal==='string'&&action.goal.trim())task.goal=action.goal.trim();if(typeof action.plan==='string')task.plan=action.plan.slice(0,8000);task.updatedAt=this.#now();this.#save(task);return {ok:true,status:'running',redirected:true};}
    return {ok:false,status:task.status,error:'UNSUPPORTED_ACTION'};
  }
}

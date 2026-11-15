import {attentionId} from './attention.mjs';
import {readFileSync} from 'node:fs';
// 她的一轮：收观察 → 问她的节律 → 组装最合理的处境 → 把决定权交给她 → 执行她的选择 → 收出站/等待。
// 宿主只提供事实、结构、资源与执行；不替她挑焦点、不替她写记忆、不替她解释。
import {canonical,digest,ensure,text} from './contracts.mjs';
import {normalizeMessage,projectText} from './message.mjs';
import {ContinuitySession} from './continuity-session.mjs';
import {LocalLookupSession} from './local-lookup.mjs';
import {prepareReflection} from './cognition.mjs';
import {reflectionFrame} from './reflection-frame.mjs';
import {rhythmConfig,rhythmTick} from './rhythm.mjs';
import {recordEpisodes} from './tendency.mjs';
import {observeAssociation} from './association-observe.mjs';
import {readActivity,saveActivity,activityWrite} from './turn-activity.mjs';
import {runtimeFeedback} from './runtime-feedback.mjs';

const ref=r=>({id:r.id,revision:r.revision});
const TASK_STEP_SUFFIX='这是 AgentTask 单步执行，不是新的对话轮。continuity.attention.frame 只是输入，不得原样写回输出。若本轮不修改 attention 就完全省略 attention；若修改，attention 必须是增量 {processes,relations,residency,questions}，可选 focus，绝不能包含 frame。准备好结果时使用 task_finish。';
const TASK_RESULT_SUFFIX='本轮 current 是 AgentTask 的 tool_receipt 结果，任务已经终结；不要调用 task_finish/task_blocked/task_wait 等任务控制工具，只处理这次结果对认识和 Intent 的影响，或选择 wait。若要更新/完成/放弃已有 Intent，必须使用 options 中 kind:"intent" 的 payload {intentId,status}；绝不能把 Intent 的 id 写进 continuity.changes（那会与 Intent 对象类型冲突）。若你写 nature:"encounter"，basis.observations 必须至少包含 current 的精确 {id,revision}；没有引用 current 时，只能用 reappraisal/self-report，不能把结果冒充实遇。';

const MEMORY_SCOPE_V1=readFileSync(new URL('../prompts/memory-scope-v1.zh.md',import.meta.url),'utf8');
export class TurnDriver {
  #store;#subjectId;#session;#lookup;#decide;#config;#lookupPolicy;#workspace;#identity;#style;#eventBypass;#materialsFor;#maxCalls;#state;#outbox;#tendency;#allowed;#capabilities;#algorithmV011;#apperceptionV1;#subjectiveDomains;#subjectiveMemory;#subjectiveMemoryV2;#taskThreads;#anchorDirectory;#memoryScopeV1;#investigationContinuityV1;#experienceLearningV1;
  constructor({store,subjectId,decide,workspace,identity='',style='',eventBypass=false,materialsFor=null,rhythm={},lookupPolicy={maxReads:2,maxHits:4},maxCallsPerTurn=3,maxForeground=16,tendency=null,allowedActionTools=[],capabilities=null,algorithmV011=false,apperceptionV1=false,subjectiveDomains=false,subjectiveMemory=false,subjectiveMemoryV2=false,taskThreads=false,anchorDirectory=false,memoryScopeV1=false,investigationContinuityV1=false,experienceLearningV1=false,sessionFactory=null}={}){
    ensure(store&&typeof store.execute==='function','TURN_DRIVER','store required');
    text(subjectId,'subject id');ensure(typeof decide==='function','TURN_DRIVER','decide function required');
    const w=store.read(workspace?.id??workspace,workspace?.revision);
    ensure(w?.type==='workspace','TURN_DRIVER','existing workspace required');
    ensure(typeof identity==='string'&&[...identity].length<=4000,'TURN_DRIVER','bounded identity required');
    ensure(Number.isSafeInteger(maxCallsPerTurn)&&maxCallsPerTurn>=1&&maxCallsPerTurn<=8,'TURN_DRIVER','1..8 calls per turn');
    ensure(tendency===null||(tendency?.learning&&typeof tendency.learning.material==='function'&&typeof tendency.learning.observe==='function'
      &&tendency.spec&&typeof tendency.contextFor==='function'),'TURN_DRIVER','explicit tendency session and context provider required');
    ensure(Array.isArray(allowedActionTools)&&allowedActionTools.length<=64,'TURN_DRIVER','up to 64 granted action tools');
    allowedActionTools.forEach(t=>text(t,'tool'));
    this.#store=store;this.#subjectId=subjectId;this.#decide=decide;this.#workspace=ref(w);
    this.#identity=identity;this.#style=String(style??'').slice(0,16000);this.#eventBypass=eventBypass===true;this.#materialsFor=typeof materialsFor==='function'?materialsFor:()=>[];
    this.#maxCalls=maxCallsPerTurn;this.#lookupPolicy=lookupPolicy;this.#tendency=tendency;
    this.#allowed=[...new Set(allowedActionTools)].sort();
    ensure(capabilities===null||Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string'),'TURN_DRIVER','capabilities must be null or a string array');
    this.#capabilities=capabilities;
    this.#algorithmV011=algorithmV011===true;
    this.#apperceptionV1=apperceptionV1===true;
    this.#subjectiveDomains=subjectiveDomains===true;
    this.#subjectiveMemory=subjectiveMemory===true;
    this.#subjectiveMemoryV2=subjectiveMemoryV2===true;
    this.#taskThreads=taskThreads===true;
    this.#anchorDirectory=anchorDirectory===true;this.#memoryScopeV1=memoryScopeV1===true;this.#experienceLearningV1=experienceLearningV1===true;this.#investigationContinuityV1=investigationContinuityV1===true||this.#experienceLearningV1;
    this.#session=sessionFactory?sessionFactory({store,subjectId,attention:true,maxForeground}):new ContinuitySession({store,subjectId,attention:true,maxForeground});
    this.#lookup=new LocalLookupSession({store,subjectId,policy:lookupPolicy});
    this.#config=rhythmConfig(rhythm);
    this.#state={lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null};
    this.#outbox=[];
  }
  #priorDecisions({task=null,event=null}={}){
    if(!this.#investigationContinuityV1)return [];
    const frame=this.#store.read(attentionId(this.#subjectId)),ids=new Set((frame?.focus?.selection??[]).filter(s=>s.kind==='process'&&frame.processes.some(p=>p.id===s.id&&!['completed','abandoned'].includes(p.status))).map(s=>s.id));
    const resultTask=event?[...this.#store.all('agent_task')].find(t=>t.feedback?.event?.id===event.id&&t.feedback.event.revision===event.revision):null;
    const taskId=task?.id??resultTask?.id??null,last=this.#store.read(this.#subjectId)?.lastDecision;
    // Exact receipt -> action -> decision lineage survives an intervening lookup.
    // No similarity-based ownership or guessed Intent; only used by the opt-in learning adapter.
    const receiptAction=this.#experienceLearningV1&&event?.origin==='tool_receipt'?[...this.#store.all('action')].find(a=>a.receipt?.id===event.id&&a.receipt.revision===event.revision):null;
    const receiptDecision=receiptAction?[...this.#store.all('decision')].find(d=>d.action?.id===receiptAction.id&&d.input?.payload?.continuity?.subject?.id===this.#subjectId&&d.workspace.id===this.#workspace.id):null;
    return [...this.#store.all('decision')].filter(d=>{
      if(d.input?.payload?.continuity?.subject?.id!==this.#subjectId||d.workspace.id!==this.#workspace.id)return false;
      if(d.id===receiptDecision?.id)return true;
      if(taskId)return d.input.payload.task?.id===taskId;
      if(!ids.size)return d.id===last?.id;
      const selected=d.input.payload.continuity.attention?.focusSupport?.validSelection??[];
      return [...selected.filter(s=>s.kind==='process').map(s=>s.id),...(d.output.continuity?.attention?.processes??[]).map(p=>p.id)].some(id=>ids.has(id));
    }).sort((a,b)=>Number(b.id===receiptDecision?.id)-Number(a.id===receiptDecision?.id)||Number(b.id===last?.id)-Number(a.id===last?.id)||(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id)).slice(0,2).reverse().map(ref);
  }
  #instructions(extra=null){const policy=this.#decide.operationPolicy;return [extra,this.#memoryScopeV1?MEMORY_SCOPE_V1:null,'【宿主操作反馈】'+JSON.stringify(runtimeFeedback({store:this.#store,subjectId:this.#subjectId,policy:policy?{externalSend:policy.externalSend??null,dependencyStatus:policy.dependencyStatus??'not-confirmed'}:null}))].filter(Boolean).join('\n\n')||null;}
  get state(){return {...this.#state};}
  get subjectId(){return this.#subjectId;}
  setStyle(style){this.#style=String(style??'').slice(0,16000);}

  // 观察入账：同一 source key 幂等；admit 让收件箱可见（重复也幂等）。不决定事情，只记事实。
  ingest({key,body=null,message:messageValue=null,actor='brother',sender=null,scene='local-chat',origin='reported',at=Date.now(),sourceSystem='turn-driver',threadId=null,admit=true}){
    text(key,'observation key');
    if(messageValue!==null)body=projectText(normalizeMessage(messageValue));
    text(body,'observation body');
    const id='obs:'+key;
    const ev=this.#store.execute({requestId:`ingest:${id}`,commands:[{op:'append_event',id,body,...(messageValue!==null?{message:normalizeMessage(messageValue)}:{}),origin,actor,scene,...(sender?{sender}:{}),...(threadId!==null?{threadId}:{}),occurredAt:at,source:{system:sourceSystem,key:id}}]}).at(-1);
    if(admit)this.#store.execute({requestId:`admit:${digest({subject:this.#subjectId,event:ref(ev)})}`,commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:ref(ev)}]});
    return ref(ev);
  }

  // 节律机会：醒来 ≠ 必须思考。没有待处理观察时只是空闲；预算门由节律层给出。
  async tick({now=Date.now(),localHour=null,dayKey=null,memoryUpdate=false,followup=null,eventBypass=this.#eventBypass,idleReflection=false}={}){
    const pendingActivity=readActivity(this.#store,this.#subjectId,this.#workspace)?.value;
    if(pendingActivity&&pendingActivity.phase!=='complete'){
      if(pendingActivity.context.kind==='reflection')return this.#runReflection({...pendingActivity.context,resume:pendingActivity});
      return this.#runDecision({...pendingActivity.context,resume:pendingActivity});
    }
    if(followup)return this.#runReflection({now,reason:'followup',followup});
    const pending=this.#store.subjectInbox({subjectId:this.#subjectId,limit:64,pendingOnly:true}).items.filter(o=>!(this.#session.sourceBlocked?.(o.eventId)));
    // A subject-deferred source stays pending, but must not hide a new receipt
    // or user observation. Do not mark deferred work completed on her behalf.
    const observation=pending.find(o=>o.status==='received')??pending[0];
    const day=dayKey??new Date(now).toISOString().slice(0,10);
    const calls=day===this.#state.dayKey?this.#state.callsToday:0;
    const hour=localHour??new Date(now).getHours();
    if(eventBypass&&pending.length>0){
      const dayKeyNow=dayKey??new Date(now).toISOString().slice(0,10);
      const callsNow=dayKeyNow===this.#state.dayKey?this.#state.callsToday:0;
      if(this.#config.dailyCallCap!==null&&callsNow>=this.#config.dailyCallCap)return {wake:false,reason:'budget',pending:pending.length};
      this.#state.lastWakeAt=now;this.#state.dayKey=dayKeyNow;
      return this.#runDecision({now,observation,reason:'event'});
    }
    const r=rhythmTick({now,localHour:hour,state:{lastWakeAt:this.#state.lastWakeAt??(now),nextWakeAt:this.#state.nextWakeAt,
      callsToday:calls,clockSuspect:false,pendingEvents:pending.length},config:this.#config});
    this.#state={lastWakeAt:r.state.lastWakeAt,nextWakeAt:r.state.nextWakeAt,callsToday:r.state.callsToday,dayKey:day};
    if(memoryUpdate&&pending.length===0&&r.modelAllowed)return this.#runReflection({now,reason:'memory-update',memoryUpdate:true});
    if(idleReflection&&pending.length===0&&r.modelAllowed)return this.#runReflection({now,reason:'idle'});
    if(!r.wake)return {wake:false,reason:r.reason,nextAt:r.nextAt};
    if(!r.modelAllowed)return {wake:true,reason:r.reason,action:'budget-blocked',pending:pending.length,nextAt:r.nextAt};
    if(pending.length===0)return this.#runReflection({now,reason:r.reason});
    return this.#runDecision({now,observation,reason:r.reason});
  }

  // 节律醒来但没有新观察：给内部时间/注意力摘要，让她自己决定要不要做点什么（不写事件）。
  async #runReflection({now,reason,memoryUpdate=false,followup=null,resume=null,internal:restoredInternal=null}){
    const internal=restoredInternal??reflectionFrame({read:(id,rev)=>this.#store.read(id,rev),subjectId:this.#subjectId,workspace:this.#workspace,now,
      sinceLastInteraction:this.#state.lastWakeAt===null?null:Math.max(0,now-this.#state.lastWakeAt),
      waitingUntil:this.#state.nextWakeAt});
    const context={kind:'reflection',now,reason,memoryUpdate,followup,internal},lookups=[...(resume?.context.lookups??[])],outbox=[];let decision=null,choiceKind=null;
    for(let c=resume?.context.step??0;c<this.#maxCalls;c++){
      const packet=resume?.packet??await this.#session.prepareReflection({previousDecisions:this.#priorDecisions(),investigationContinuityV1:this.#investigationContinuityV1,experienceLearningV1:this.#experienceLearningV1,instructionSuffix:this.#instructions(),store:this.#store,subjectId:this.#subjectId,workspace:this.#workspace,identity:this.#identity,
        internal,localLookupPolicy:this.#lookupPolicy,apperceptionV1:this.#apperceptionV1,budgetBytes:131072,allowedActionTools:this.#allowed,lookupResults:lookups,capabilities:this.#capabilities,memoryUpdateDue:memoryUpdate,style:this.#style,followup,subjectiveDomains:this.#subjectiveDomains,subjectiveMemory:this.#subjectiveMemory,subjectiveMemoryV2:this.#subjectiveMemoryV2,taskThreads:this.#taskThreads,anchorDirectory:this.#anchorDirectory});
      decision=await this.#durableDecision(packet,{...context,step:c,lookups},this.#allowed);resume=null;
      observeAssociation({store:this.#store,packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls){this.#finishActivity();return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),lookups};}
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        this.#finishActivity({...context,step:c+1,lookups});
        continue;
      }
      if(choice.kind==='respond'){const response=this.#store.read(`${decision.id}:response`);outbox.push({kind:'respond',text:choice.payload.text,...(choice.payload.target?{scene:choice.payload.target}:{}),...(response?{response:{id:response.id,revision:response.revision}}:{})});}
      else if(choice.kind==='act')outbox.push({kind:'act',tool:choice.payload.tool,args:choice.payload.args,action:decision.action??null});
      else if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#finishActivity();this.#outbox.push(...outbox);
    return {wake:true,reason,action:'reflected',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  capturedTaskPacket(task){
    return [...this.#store.all('affect_turn')].find(t=>t.subject===this.#subjectId&&t.status==='captured'&&t.packet.payload.task?.id===task.id&&t.packet.payload.task.stepCount===task.stepCount&&(t.packet.payload.task.controlRevision??0)===(task.controlRevision??0))?.packet??null;
  }
  taskAllowedTools(task){const scope=this.#decide.operationPolicy?.taskAllowedTools;return (task.metadata?.allowedTools??[]).filter(t=>scope===undefined||scope.includes(t));}
  async recoverTaskCapture(task,packet){
    const output=this.#session.capturedOutput?.(packet);ensure(typeof output==='string','TASK_CAPTURE','captured output required');
    const tools=[...new Set([...this.taskAllowedTools(task),'task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect'])];
    const id='task-decision:'+packet.packetId;
    const decision=await this.#session.commit({packet,output,decisionId:id,requestId:id,allowedActionTools:tools,maxOutputBytes:32768,taskGuard:{id:task.id,controlRevision:task.controlRevision??0,leaseToken:task.lease?.token??null}});
    const choice=decision.output.options.find(o=>o.id===decision.output.selected);
    if(choice.kind==='lookup'){this.#lookup.execute({decision:ref(decision)});return {lookupExhausted:true,decision:null,choice,packet,calls:0,recovered:true};}
    task.interruptCursor=Math.min(task.interrupts.length,(packet.payload.task.interruptCursor??0)+(packet.payload.task.interrupts?.length??0));
    return {decision,choice,packet,decisionRef:ref(decision),calls:0,recovered:true};
  }
  recoverTaskDecision(task){
    const subject=this.#store.read(this.#subjectId),d=subject?.lastDecision?this.#store.read(subject.lastDecision.id,subject.lastDecision.revision):null;
    const context=d?.input?.payload?.task;
    if(!context||context.id!==task.id||context.stepCount!==task.stepCount||(context.controlRevision??0)!==(task.controlRevision??0)||(task.decisionRefs??[]).some(r=>(r.id??r)===d.id))return null;
    const choice=d.output.options.find(o=>o.id===d.output.selected);if(choice?.kind==='lookup')return null;
    task.interruptCursor=Math.min(task.interrupts.length,(context.interruptCursor??task.interruptCursor??0)+(context.interrupts?.length??0));
    return {decision:d,choice,packet:d.input,taskRef:{id:task.id},decisionRef:ref(d),calls:0,recovered:true};
  }
  async decideTaskStep(task,{now=Date.now(),maxModelCalls=this.#maxCalls,onModelAttempt=null,onDecisionReady=null}={}){
    ensure(task&&task.format==='agent-task-v1'&&task.status==='running','TASK_STEP','running agent task required');
    const recovered=this.recoverTaskDecision(task);if(recovered)return recovered;
    let eventRef=task.observationRefs?.at(-1)??task.originEventRef??null;
    let event=eventRef?this.#store.read(eventRef.id,eventRef.revision):null;
    if(!event){const created=this.ingest({key:'task-origin:'+task.id,body:'任务：'+task.goal,scene:task.target??'agent/task',threadId:task.threadId??null,origin:'reported'});event=this.#store.read(created.id);}
    task.originEventRef=task.originEventRef??ref(event);const current=ref(event);
    const controls=['task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect'];
    const tools=[...new Set([...this.taskAllowedTools(task),...controls])];
    const clean=value=>JSON.parse(JSON.stringify(value));
    const earlier=clean(task.observations.slice(0,-8).slice(-24).map(o=>({at:o.at,kind:o.kind,tool:o.tool,ok:o.ok,error:o.error})));
    let lookupResults=[],previousDecisions=this.#priorDecisions({task}),lookupDecisions=[],packet=null,decision=null,choice=null,calls=0;
    const limit=Math.min(this.#maxCalls,maxModelCalls);
    ensure(Number.isSafeInteger(limit)&&limit>0,'TASK_CALL_BUDGET','positive remaining model attempt budget required');
    for(let c=0;c<limit;c++){
      const deliveredInterruptCount=task.interrupts.length;
      const taskContext={id:task.id,controlRevision:task.controlRevision??0,leaseToken:task.lease?.token??null,interruptCursor:task.interruptCursor??0,goal:task.goal,plan:task.plan,status:task.status,target:task.target,threadId:task.threadId??null,stepCount:task.stepCount,budget:task.budget??null,observations:clean(task.observations.slice(-8)),earlierObservations:earlier,observationRefs:clean(task.observationRefs),interrupts:clean(task.interrupts.slice(task.interruptCursor??0)),controlTools:controls};
      packet=await this.#session.prepare({instructionSuffix:this.#instructions(TASK_STEP_SUFFIX),currentEvent:current,workspace:this.#workspace,identity:this.#identity,style:this.#style,materials:[],previousDecisions:this.#investigationContinuityV1?[...previousDecisions,...lookupDecisions.slice(-2)]:previousDecisions,investigationContinuityV1:this.#investigationContinuityV1,experienceLearningV1:this.#experienceLearningV1,lookupResults,mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,algorithmV011:this.#algorithmV011,apperceptionV1:this.#apperceptionV1,subjectiveDomains:this.#subjectiveDomains,subjectiveMemory:this.#subjectiveMemory,subjectiveMemoryV2:this.#subjectiveMemoryV2,taskThreads:this.#taskThreads,anchorDirectory:this.#anchorDirectory,localLookupPolicy:this.#lookupPolicy,allowedActionTools:tools,budgetBytes:131072,now,capabilities:this.#capabilities,task:taskContext});
      const output=await this.#session.invoke(packet,async p=>{
        try{ensure(calls<maxModelCalls,'TASK_CALL_BUDGET','task model attempt budget exhausted');await onModelAttempt?.();}catch(error){error.transportInvoked=false;throw error;}
        this.#state.callsToday++;calls++;return this.#decide(p,{beforeCorrection:async()=>{ensure(calls<maxModelCalls,'TASK_CALL_BUDGET','no remaining task model attempt for correction');await onModelAttempt?.();this.#state.callsToday++;calls++;}});
      });
      try{await onDecisionReady?.();}catch(error){await this.#session.supersede?.(packet,error);throw error;}
      const decisionId='task-decision:'+packet.packetId;
      decision=await this.#session.commit({packet,output,decisionId,requestId:decisionId,allowedActionTools:tools,maxOutputBytes:32768,taskGuard:{id:task.id,controlRevision:task.controlRevision??0,leaseToken:task.lease?.token??null}});
      observeAssociation({store:this.#store,packet,decision});
      choice=decision.output.options.find(o=>o.id===decision.output.selected);
      if(choice.kind==='lookup'){if(c===limit-1)return {decision:null,choice,packet,taskRef:{id:task.id},lookupExhausted:true,calls};lookupResults.push(ref(this.#lookup.execute({decision:ref(decision)})));if(this.#investigationContinuityV1)lookupDecisions.push(ref(decision));else previousDecisions.push(ref(decision));continue;}
      task.interruptCursor=deliveredInterruptCount;
      return {decision,choice,packet,taskRef:{id:task.id},decisionRef:ref(decision),calls};
    }
    return {decision:null,choice,packet,taskRef:{id:task.id},lookupExhausted:true,calls};
  }
  async #runDecision({now,observation,reason,resume=null}){
    const event=this.#store.read(observation.eventId);
    ensure(event?.type==='event','TURN_DRIVER','pending observation must be an existing event');
    const context={kind:'decision',now,observation,reason},current=ref(event),lookups=[...(resume?.context.lookups??[])],outbox=[];
    const materials=[...(this.#materialsFor({store:this.#store,subjectId:this.#subjectId,event:current,now})??[])];
    // 长期经验卡：宿主先确认这是"她自己的学习语境"，才生成并作为知识材料交付；卡片不是指令。
    if(this.#tendency){
      const context=this.#tendency.contextFor({store:this.#store,event:current,now});
      if(context){const card=this.#tendency.learning.material({context});materials.push({ref:card.ref,aspect:'knowledge'});}
    }
    let decision=null,choiceKind=null;
    for(let c=resume?.context.step??0;c<this.#maxCalls;c++){
      const taskResult=event.origin==='tool_receipt'&&event.source?.system==='agent-runtime';
      const allowedForDecision=taskResult?this.#allowed.filter(t=>!['task_finish','task_blocked','task_help','task_pause','task_wait','task_replan','task_redirect'].includes(t)):this.#allowed;
      const packet=resume?.packet??await this.#session.prepare({instructionSuffix:this.#instructions(taskResult?TASK_RESULT_SUFFIX:null),currentEvent:current,workspace:this.#workspace,identity:this.#identity,style:this.#style,materials,previousDecisions:this.#priorDecisions({event}),investigationContinuityV1:this.#investigationContinuityV1,experienceLearningV1:this.#experienceLearningV1,
        mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,algorithmV011:this.#algorithmV011,apperceptionV1:this.#apperceptionV1,
        subjectiveDomains:this.#subjectiveDomains,subjectiveMemory:this.#subjectiveMemory,subjectiveMemoryV2:this.#subjectiveMemoryV2,taskThreads:this.#taskThreads,anchorDirectory:this.#anchorDirectory,
        localLookupPolicy:this.#lookupPolicy,lookupResults:lookups,allowedActionTools:allowedForDecision,budgetBytes:131072,now,capabilities:this.#capabilities});
      decision=await this.#durableDecision(packet,{...context,step:c,lookups},allowedForDecision);resume=null;
      observeAssociation({store:this.#store,packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls){this.#finishActivity();return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),outbox,lookups};}
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        this.#finishActivity({...context,step:c+1,lookups});
        continue;
      }
      if(choice.kind==='respond'){const response=this.#store.read(`${decision.id}:response`);outbox.push({kind:'respond',text:choice.payload.text,...(choice.payload.target?{scene:choice.payload.target}:{}),...(response?{response:{id:response.id,revision:response.revision}}:{})});}
      else if(choice.kind==='act')outbox.push({kind:'act',tool:choice.payload.tool,args:choice.payload.args,action:decision.action??null});
      else if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#finishActivity();this.#outbox.push(...outbox);
    return {wake:true,reason,action:'decided',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  async #durableDecision(packet,context,allowedActionTools){
    let row=readActivity(this.#store,this.#subjectId,this.#workspace);
    const save=value=>{row=saveActivity(this.#store,row,{subject:this.#subjectId,workspace:this.#workspace,value});};
    if(!row||['complete','ready'].includes(row.value.phase))save({phase:'prepared',context,packet});
    ensure(row.value.packet?.packetId===packet.packetId,'TURN_ACTIVITY_CHANGED','finish the exact pending turn before starting another');
    const decisionId='decision:'+packet.packetId,requestId='commit:'+packet.packetId;
    if(row.value.phase==='committed')return this.#store.read(row.value.decision.id,row.value.decision.revision);
    let output=row.value.output;
    if(row.value.phase==='dispatched'){
      output=this.#session.capturedOutput?.(packet);
      ensure(typeof output==='string','TURN_OUTCOME_UNKNOWN','interrupted model invocation requires explicit accounting/capture recovery; do not resend');
      save({...row.value,phase:'captured',output});
    }
    if(row.value.phase==='prepared'){
      // The journal is durable before entering any model callback.
      output=await this.#session.invoke(packet,p=>{
        save({...row.value,phase:'dispatched'});this.#state.callsToday++;return this.#decide(p,{beforeCorrection:()=>{ensure(this.#config.dailyCallCap===null||this.#state.callsToday<this.#config.dailyCallCap,'TASK_CALL_BUDGET','no remaining cognitive call budget for correction');this.#state.callsToday++;}});
      });
      output=typeof output==='string'?output:canonical(output);
      save({...row.value,phase:'captured',output});
    }
    ensure(row.value.phase==='captured','TURN_ACTIVITY','captured output required');
    const write=activityWrite(row,{subject:this.#subjectId,workspace:this.#workspace,value:{phase:'committed',context:row.value.context,packet,decision:{id:decisionId,revision:1}}});
    try{return await this.#session.commit({packet,output:row.value.output,decisionId,requestId,allowedActionTools,maxOutputBytes:32768,extensionWrites:[write]});}
    catch(error){
      const journal=activityWrite(row,{subject:this.#subjectId,workspace:this.#workspace,value:{...row.value,phase:'complete',failure:{code:error.code??'ERROR',outcome:'rejected-not-adopted'}}});
      this.#session.closeRejected?.({packet,error,journal});throw error;
    }
  }
  #finishActivity(next=null){
    const row=readActivity(this.#store,this.#subjectId,this.#workspace);if(!row)return;
    saveActivity(this.#store,row,{subject:this.#subjectId,workspace:this.#workspace,value:next?{phase:'ready',context:next}:{phase:'complete',decision:row.value.decision??null}});
  }
  takeOutbox(){const out=this.#outbox;this.#outbox=[];return out;}

  // 真实回执入账（执行结果只能来自宿主；这里只记录，不推断她是否“学到”）。
  applyReceipt({action,status,body,eventId,claimId=null,actor='host',sourceSystem='host',occurredAt}={}){
    ensure(action,'TURN_DRIVER','action reference required');
    const existing=this.#store.read(eventId);
    if(existing?.type==='event'&&existing.origin==='tool_receipt'){
      const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
      return {receipt:ref(existing),tendency,replayed:true};
    }
    const live=claimId?this.#store.read(action.id):this.#store.read(action.id,action.revision);
    ensure(live?.type==='action','TURN_DRIVER','existing action required');
    const ev=this.#store.execute({requestId:`receipt:${eventId}`,commands:[{op:'record_receipt',actionId:live.id,
      expectedRevision:live.revision,claimId,status,eventId,body,source:{system:sourceSystem,key:eventId},actor,occurredAt:occurredAt??Date.now()}]}).at(-1);
    const receipt=ev.receipt;
    this.#store.execute({requestId:'receipt-admit:'+eventId,commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:receipt}]});
    const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
    return {receipt,tendency};
  }

  // 节律状态存成版本化 note：重启后接得上；内容只是时钟与预算，不是经历。
  loadState(){
    const id=`rhythm:${this.#subjectId}`,note=this.#store.read(id);
    if(!note?.body)return false;
    let data;try{data=JSON.parse(note.body);}catch{return false;}
    if(data?.format!=='rhythm-state-v1')return false;
    this.restore({state:{lastWakeAt:data.lastWakeAt??null,nextWakeAt:data.nextWakeAt??null,callsToday:data.callsToday??0,dayKey:data.dayKey??null}});
    return true;
  }
  persistState(){
    const id=`rhythm:${this.#subjectId}`,old=this.#store.read(id),body=canonical({format:'rhythm-state-v1',...this.#state});
    const out=this.#store.execute({requestId:`rhythm-state:${digest({id,body,expected:old?.revision??0})}`,
      commands:[{op:'write_note',id,expectedRevision:old?.revision??0,kind:'skill',change:'self_report',evidence:[],body}]}).at(-1);
    return ref(out.record);
  }

  snapshot(){return {state:{...this.#state},outbox:[...this.#outbox]};}
  restore(snapshot){
    ensure(snapshot&&typeof snapshot==='object','TURN_DRIVER','snapshot required');
    const s=snapshot.state??{};
    for(const key of ['lastWakeAt','nextWakeAt'])ensure(s[key]===null||Number.isSafeInteger(s[key]),'TURN_DRIVER',`invalid ${key}`);
    ensure(Number.isSafeInteger(s.callsToday??0)&&(s.callsToday??0)>=0,'TURN_DRIVER','invalid callsToday');
    this.#state={lastWakeAt:s.lastWakeAt??null,nextWakeAt:s.nextWakeAt??null,callsToday:s.callsToday??0,dayKey:s.dayKey??null};
    this.#outbox=Array.isArray(snapshot.outbox)?[...snapshot.outbox]:[];
  }
}
